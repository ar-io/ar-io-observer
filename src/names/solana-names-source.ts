/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Solana-native ArNS names source.
 *
 * Replaces `ContractNamesSource`. Implements both:
 *   - `ArnsNamesSource.getNames({epochIndex})` — prescribed names for an
 *     epoch (the observer's "must assess" set). The SDK already resolves
 *     `Epoch.prescribed_name_hashes` (32-byte SHA-256) back to name strings
 *     by deriving each `ArnsRecord` PDA from its hash, so we just delegate.
 *   - `ArnsNameList.{getAllNames,getName,getNamesCount}` — the universe of
 *     registered ArNS names used for the chosen-names (random) sampler.
 *     Backed by `getArNSRecords()` paginated through the on-chain registry.
 *
 * `height` is part of the ArnsNameList interface for AO compat and is
 * ignored — Solana ArNS state is not Arweave-block-indexed.
 */
import type winston from 'winston';

import type { SolanaARIOReadable } from '@ar.io/sdk/solana';
import type { ArnsNameList, ArnsNamesSource } from '../types.js';

export interface SolanaNamesSourceConfig {
  readable: SolanaARIOReadable;
  log: winston.Logger;
  /** How long to cache the full registry name list. Defaults to 5 minutes.
   *  The chosen-names sampler doesn't need second-fresh data; refresh on
   *  this cadence keeps RPC pressure bounded. */
  allNamesCacheTtlMs?: number;
  /** Page size used when walking the ArnsRecord PDAs. */
  pageSize?: number;
}

export class SolanaNamesSource implements ArnsNamesSource, ArnsNameList {
  private readonly readable: SolanaARIOReadable;
  private readonly log: winston.Logger;
  private readonly allNamesCacheTtlMs: number;
  private readonly pageSize: number;
  private allNamesCache?: { names: string[]; fetchedAt: number };
  private allNamesInflight?: Promise<string[]>;

  constructor(cfg: SolanaNamesSourceConfig) {
    this.readable = cfg.readable;
    this.log = cfg.log.child({ class: this.constructor.name });
    this.allNamesCacheTtlMs = cfg.allNamesCacheTtlMs ?? 5 * 60_000;
    this.pageSize = cfg.pageSize ?? 1000;
  }

  async getNames({ epochIndex }: { epochIndex: number }): Promise<string[]> {
    const names = await this.readable.getPrescribedNames({ epochIndex });
    this.log.verbose('Prescribed names resolved', {
      epochIndex,
      count: names.length,
    });
    return names;
  }

  async getAllNames(_height: number): Promise<string[]> {
    const now = Date.now();
    if (
      this.allNamesCache !== undefined &&
      now - this.allNamesCache.fetchedAt < this.allNamesCacheTtlMs
    ) {
      return this.allNamesCache.names;
    }
    // Coalesce concurrent callers onto a single in-flight fetch so the
    // first cycle after cache expiry doesn't fan out a flood of identical
    // `getProgramAccounts` scans.
    if (this.allNamesInflight !== undefined) {
      return this.allNamesInflight;
    }
    this.allNamesInflight = this.fetchAllNames().finally(() => {
      this.allNamesInflight = undefined;
    });
    return this.allNamesInflight;
  }

  async getName(height: number, index: number): Promise<string> {
    const names = await this.getAllNames(height);
    return names[index];
  }

  async getNamesCount(height: number): Promise<number> {
    return (await this.getAllNames(height)).length;
  }

  private async fetchAllNames(): Promise<string[]> {
    const seen = new Set<string>();
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await this.readable.getArNSRecords({
        cursor,
        limit: this.pageSize,
      });
      for (const record of page.items) {
        if (record.name) seen.add(record.name);
      }
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor !== undefined);

    const names = [...seen].sort();
    this.allNamesCache = { names, fetchedAt: Date.now() };
    this.log.verbose('All ArNS names refreshed', {
      count: names.length,
      pages,
    });
    return names;
  }
}
