/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Solana-native epoch timing source.
 *
 * Replaces the legacy `ContractEpochSource` which depended on AO HTTP
 * roundtrips and Arweave block boundary math. On Solana, the entire
 * epoch schedule is derivable from a single on-chain `EpochSettings`
 * account (`genesis_timestamp + N * epoch_duration`), so this source
 * does exactly ONE `getAccountInfo` per refresh — no `getEpoch()`
 * fan-out (which would do per-prescribed-observer Gateway lookups and
 * per-prescribed-name record fetches, ~30+ RPC calls per refresh on
 * mainnet-shape epochs).
 *
 * `getEpochStartHeight()` returns the 0 sentinel — Solana epochs are
 * not Arweave-block-aligned. The interface keeps `epochStartHeight`
 * for back-compat with the AO-era report shape and the offset-
 * observation feature, which now sources height from `heightSource`
 * (Arweave chainSource) independently.
 */
import {
  type Address,
  type Rpc,
  type SolanaRpcApi,
  fetchEncodedAccount,
} from '@solana/kit';
import type winston from 'winston';

import {
  deserializeEpochSettingsFull,
  getEpochSettingsPDA,
} from '@ar.io/sdk';
import type {
  EpochSettings,
  EpochTimestampParams,
  EpochTimestampSource,
} from '../types.js';

export interface SolanaEpochSourceConfig {
  rpc: Rpc<SolanaRpcApi>;
  /** `ario-gar` program address — used to derive the EpochSettings PDA. */
  garProgramAddress: Address;
  log: winston.Logger;
  /** How long to cache epoch params before refetching. Defaults to 30s
   *  which matches the continuous-observer cycle interval. */
  cacheTtlMs?: number;
}

export class SolanaEpochSource implements EpochTimestampSource {
  private readonly rpc: Rpc<SolanaRpcApi>;
  private readonly garProgramAddress: Address;
  private readonly log: winston.Logger;
  private readonly cacheTtlMs: number;
  private cached?: { params: EpochTimestampParams; fetchedAt: number };

  constructor(cfg: SolanaEpochSourceConfig) {
    this.rpc = cfg.rpc;
    this.garProgramAddress = cfg.garProgramAddress;
    this.log = cfg.log.child({ class: this.constructor.name });
    this.cacheTtlMs = cfg.cacheTtlMs ?? 30_000;
  }

  /**
   * Fetch and decode the EpochSettings PDA in a single RPC call.
   * Cached by the underlying RPC layer's coalescing on identical
   * concurrent requests.
   */
  private async fetchSettings(): Promise<{
    currentEpochIndex: number;
    genesisTimestamp: number; // seconds
    epochDuration: number; // seconds
  }> {
    const [pda] = await getEpochSettingsPDA(this.garProgramAddress);
    const account = await fetchEncodedAccount(this.rpc, pda, {
      commitment: 'confirmed',
    });
    if (!account.exists) {
      throw new Error(`EpochSettings PDA not found at ${pda}`);
    }
    const data = deserializeEpochSettingsFull(Buffer.from(account.data));
    return {
      currentEpochIndex: data.currentEpochIndex,
      genesisTimestamp: data.genesisTimestamp,
      epochDuration: data.epochDuration,
    };
  }

  async getEpochSettings(): Promise<EpochSettings> {
    const s = await this.fetchSettings();
    return {
      epochZeroStartTimestamp: s.genesisTimestamp * 1000,
      durationMs: s.epochDuration * 1000,
    };
  }

  /**
   * Resolve the currently-active epoch's timing parameters. Caches for
   * `cacheTtlMs` to avoid hammering the RPC on the observer's 30s cycle.
   * Cache invalidates the moment we cross `epochEndTimestamp` so the
   * observer never operates on a stale epoch view.
   *
   * The currently-active epoch index is `currentEpochIndex - 1`: the
   * on-chain `current_epoch_index` is the NEXT epoch to be created
   * (the cranker increments it inside `create_epoch` AFTER allocating
   * the PDA). Same off-by-one fixed in
   * `SolanaARIOReadable.resolveEpochIndex`.
   */
  async getEpochParams(): Promise<EpochTimestampParams> {
    const now = Date.now();
    if (
      this.cached !== undefined &&
      this.cached.params.epochEndTimestamp > now &&
      now - this.cached.fetchedAt < this.cacheTtlMs
    ) {
      return this.cached.params;
    }

    const s = await this.fetchSettings();
    const activeEpochIndex = Math.max(0, s.currentEpochIndex - 1);
    const epochStartSec =
      s.genesisTimestamp + activeEpochIndex * s.epochDuration;
    const epochEndSec = epochStartSec + s.epochDuration;
    const params: EpochTimestampParams = {
      epochStartTimestamp: epochStartSec * 1000,
      epochEndTimestamp: epochEndSec * 1000,
      // Arweave block height isn't meaningful in Solana mode.
      epochStartHeight: 0,
      epochIndex: activeEpochIndex,
    };

    this.cached = { params, fetchedAt: now };
    this.log.verbose('Epoch params resolved', {
      epochIndex: params.epochIndex,
      epochStartTimestamp: params.epochStartTimestamp,
      epochEndTimestamp: params.epochEndTimestamp,
    });
    return params;
  }

  async getEpochStartTimestamp(): Promise<number> {
    return (await this.getEpochParams()).epochStartTimestamp;
  }

  async getEpochEndTimestamp(): Promise<number> {
    return (await this.getEpochParams()).epochEndTimestamp;
  }

  async getEpochStartHeight(): Promise<number> {
    return 0;
  }

  async getEpochIndex(): Promise<number> {
    return (await this.getEpochParams()).epochIndex;
  }
}
