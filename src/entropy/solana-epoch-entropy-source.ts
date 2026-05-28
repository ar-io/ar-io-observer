/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Deterministic shared entropy for the Solana backend.
 *
 * `ChainEntropySource` (the legacy AO path) hashes Arweave block headers
 * `epochStartHeight - 50/51/52`. Solana epochs aren't Arweave-block-aligned
 * (`SolanaEpochSource.getEpochStartHeight()` returns the 0 sentinel), so
 * the AO path produces 400s when fetching `block/height/-50`. This source
 * replaces it on Solana.
 *
 * Why hash the on-chain Epoch PDA contents instead of just
 * `sha256(epochIndex)` or a Solana slot hash:
 *
 *   - **Shared across observers** — every prescribed observer reads the
 *     same Epoch PDA from the same Solana programs and computes the
 *     same bytes. Required for consensus on chosen-names sampling +
 *     gateway shuffle order.
 *   - **Not predictable before `prescribe_epoch`** — the prescribed
 *     observer set and prescribed name set are derived on-chain by the
 *     cranker's `prescribe_epoch` ix using Solana's `SlotHashes` sysvar
 *     VRF. So this source is piggybacking on the network's existing
 *     on-chain entropy injection without an extra RPC round-trip to
 *     fetch slot hashes off-chain. An adversary who can predict next
 *     epoch's prescribed lists has already won — they have no extra
 *     leverage from knowing the entropy.
 *   - **Versioned** — the `v1` prefix in the hashed input lets us
 *     evolve the derivation without colliding with stored caches or
 *     other observers running older code.
 *
 * RPC budget: one `getAccountInfo` per epoch (cached). Notably this
 * does NOT use `SolanaARIOReadable.getEpoch()`, which fans out into one
 * RPC per prescribed observer (gateway lookup) plus one per prescribed
 * name (record PDA fetch) — ~30+ RPC calls on mainnet-shape epochs, more
 * than a free-tier RPC will sustain when paired with the cranker's
 * parallel traffic. The raw `deserializeEpoch` gives us the same
 * `prescribed_name_hashes` and `prescribed_observers` (raw 32-byte
 * pubkeys, no Gateway expansion) which is all the entropy derivation
 * needs.
 */
import {
  type Address,
  type Rpc,
  type SolanaRpcApi,
  fetchEncodedAccount,
} from '@solana/kit';
import crypto from 'node:crypto';
import type winston from 'winston';

import { deserializeEpoch, getEpochPDA } from '@ar.io/sdk';
import type { EntropySource, EpochTimestampSource } from '../types.js';

export interface SolanaEpochEntropySourceConfig {
  /** Source for the current epoch index (cheaply cached). */
  epochSource: Pick<EpochTimestampSource, 'getEpochIndex'>;
  /** Shared Solana RPC client. */
  rpc: Rpc<SolanaRpcApi>;
  /** `ario-gar` program address — used to derive the Epoch PDA. */
  garProgramAddress: Address;
  log: winston.Logger;
  /** How long to cache the derived entropy. Defaults to 5 minutes —
   *  shorter than an epoch's lifetime but long enough that the
   *  continuous observer's ~30s cycle doesn't hammer the RPC. The
   *  cache is also keyed by `epochIndex` so it invalidates on epoch
   *  rollover regardless of TTL. */
  cacheTtlMs?: number;
}

export class SolanaEpochEntropySource implements EntropySource {
  private readonly epochSource: Pick<EpochTimestampSource, 'getEpochIndex'>;
  private readonly rpc: Rpc<SolanaRpcApi>;
  private readonly garProgramAddress: Address;
  private readonly log: winston.Logger;
  private readonly cacheTtlMs: number;
  private cached?: {
    epochIndex: number;
    entropy: Buffer;
    fetchedAt: number;
  };

  constructor(cfg: SolanaEpochEntropySourceConfig) {
    this.epochSource = cfg.epochSource;
    this.rpc = cfg.rpc;
    this.garProgramAddress = cfg.garProgramAddress;
    this.log = cfg.log.child({ class: this.constructor.name });
    this.cacheTtlMs = cfg.cacheTtlMs ?? 5 * 60_000;
  }

  /**
   * Derive 32 bytes of shared entropy for the current epoch.
   *
   * The `height` parameter is ignored — Solana epochs are clock-aligned,
   * not Arweave-block-aligned. It's kept on the signature for
   * `EntropySource` interface compatibility with the legacy
   * `ChainEntropySource`.
   */
  async getEntropy(_input: { height: number }): Promise<Buffer> {
    const epochIndex = await this.epochSource.getEpochIndex();
    const now = Date.now();

    if (
      this.cached !== undefined &&
      this.cached.epochIndex === epochIndex &&
      now - this.cached.fetchedAt < this.cacheTtlMs
    ) {
      return this.cached.entropy;
    }

    // Single getAccountInfo for the Epoch PDA. No fan-out into per-
    // observer / per-name lookups.
    const [pda] = await getEpochPDA(epochIndex, this.garProgramAddress);
    const account = await fetchEncodedAccount(this.rpc, pda, {
      commitment: 'confirmed',
    });
    if (!account.exists) {
      throw new Error(
        `Epoch ${epochIndex} PDA not found at ${pda} — has prescribe_epoch run yet?`,
      );
    }
    const epoch = deserializeEpoch(Buffer.from(account.data));

    const hash = crypto.createHash('sha256');
    // The version prefix locks the derivation to this schema. Bump to
    // `v2` if the input shape ever needs to change so old caches /
    // alternative implementations don't silently mismatch.
    hash.update('ar-io-solana-epoch-entropy:v1\n');
    hash.update(`epochIndex=${epochIndex}\n`);
    // Hash the raw 32-byte observer pubkeys + name hashes. They're
    // stored in canonical order on-chain (the cranker writes them
    // sequentially in `prescribe_epoch`), so all observers reading
    // the same PDA get the same byte sequence here.
    // deserializeEpoch returns `prescribedObservers: Address[]` (kit
    // base58 strings) and `prescribedNameHashes: Buffer[]`. Both are in
    // the on-chain storage order set by `prescribe_epoch`, so hashing
    // them sequentially gives the same input across observers.
    hash.update(`observers=`);
    for (let i = 0; i < epoch.observerCount; i++) {
      const addr = epoch.prescribedObservers[i];
      if (addr !== undefined) hash.update(String(addr));
      hash.update(',');
    }
    hash.update(`\nnameHashes=`);
    for (let i = 0; i < epoch.nameCount; i++) {
      const h = epoch.prescribedNameHashes[i];
      if (h !== undefined) hash.update(h);
    }

    const entropy = hash.digest();

    // Don't cache pre-prescribe_epoch state. When `observerCount` and
    // `nameCount` are both zero, the cranker hasn't yet written the
    // prescribed sets into the Epoch PDA — caching here would lock
    // the entropy to an empty-state hash for the cache TTL, and even
    // a subsequent `prescribe_epoch` landing wouldn't refresh it.
    // Return the value but force the next call to re-fetch.
    if (epoch.observerCount === 0 && epoch.nameCount === 0) {
      this.log.verbose(
        'Epoch entropy derived from pre-prescribe state; skipping cache',
        { epochIndex },
      );
      return entropy;
    }

    this.cached = { epochIndex, entropy, fetchedAt: now };
    this.log.verbose('Derived shared epoch entropy', {
      epochIndex,
      observerCount: epoch.observerCount,
      nameCount: epoch.nameCount,
    });
    return entropy;
  }
}
