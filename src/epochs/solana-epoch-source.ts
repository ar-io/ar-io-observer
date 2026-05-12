/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Solana-native epoch timing source.
 *
 * Replaces the legacy `ContractEpochSource` which depended on:
 *   1. AO `getCurrentEpoch()` (which returned wall-clock-indexed epoch
 *      params and required an HTTP roundtrip to an AO Compute Unit), and
 *   2. Arweave block height + timestamp (for AO-era epoch boundary math
 *      that aligned to Arweave blocks).
 *
 * On Solana, neither is needed:
 *   - Epoch boundaries are pinned by the on-chain `EpochSettings`
 *     (`genesis_timestamp + N * epoch_duration`), readable directly via
 *     `SolanaARIOReadable.getEpochSettings()`.
 *   - The currently-active Epoch's `start_timestamp` and `end_timestamp`
 *     are stored verbatim on the Epoch PDA and surfaced by
 *     `SolanaARIOReadable.getEpoch(undefined)` (which itself was fixed
 *     to return `currentEpochIndex - 1` per the cranker's "next-to-be-
 *     created" semantics for `current_epoch_index`).
 *
 * No Arweave block lookup is needed. `getEpochStartHeight()` is kept on
 * the interface for back-compat (downstream callers expect it) but
 * always returns 0 — the observer only uses startHeight for AO-era
 * cross-checks that don't apply on Solana.
 */
import type winston from 'winston';

import type { SolanaARIOReadable } from '@ar.io/sdk/solana';
import type {
  EpochSettings,
  EpochTimestampParams,
  EpochTimestampSource,
} from '../types.js';

export interface SolanaEpochSourceConfig {
  readable: SolanaARIOReadable;
  log: winston.Logger;
  /** How long to cache epoch params before refetching. Defaults to 30s
   *  which matches the continuous-observer cycle interval. */
  cacheTtlMs?: number;
}

export class SolanaEpochSource implements EpochTimestampSource {
  private readonly readable: SolanaARIOReadable;
  private readonly log: winston.Logger;
  private readonly cacheTtlMs: number;
  private cached?: { params: EpochTimestampParams; fetchedAt: number };

  constructor(cfg: SolanaEpochSourceConfig) {
    this.readable = cfg.readable;
    this.log = cfg.log.child({ class: this.constructor.name });
    this.cacheTtlMs = cfg.cacheTtlMs ?? 30_000;
  }

  async getEpochSettings(): Promise<EpochSettings> {
    const s = await this.readable.getEpochSettings();
    return {
      // SDK returns these already in ms (durationMs / epochZeroStartTimestamp
      // ms is established by the SDK adapter from on-chain seconds).
      epochZeroStartTimestamp: s.epochZeroStartTimestamp,
      durationMs: s.durationMs,
    };
  }

  /**
   * Resolve the currently-active epoch's timing parameters. Caches for
   * `cacheTtlMs` to avoid hammering the RPC on the observer's 30s cycle.
   * Cache invalidates the moment we cross `epochEndTimestamp` so the
   * observer never operates on a stale epoch view.
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

    const epoch = await this.readable.getEpoch();
    // SDK returns timestamps in milliseconds.
    const params: EpochTimestampParams = {
      epochStartTimestamp: epoch.startTimestamp,
      epochEndTimestamp: epoch.endTimestamp,
      // Arweave block height isn't meaningful in Solana mode — epoch
      // boundaries are Solana-clock-aligned, not Arweave-block-aligned.
      // Always 0 so downstream callers that ignore startHeight in
      // Solana mode get a stable sentinel.
      epochStartHeight: 0,
      epochIndex: epoch.epochIndex,
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
