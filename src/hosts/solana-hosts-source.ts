/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Solana-native gateway hosts source.
 *
 * Replaces `ContractHostsSource`. Reads the on-chain `GatewayRegistry`
 * + each `Gateway` PDA via the SDK and surfaces their `fqdn`/`port`/
 * `protocol` for the continuous observer to assess.
 */
import type winston from 'winston';

import type { SolanaARIOReadable } from '@ar.io/sdk';
import type { GatewayHost, GatewayHostsSource } from '../types.js';

export interface SolanaHostsSourceConfig {
  readable: SolanaARIOReadable;
  log: winston.Logger;
  /** Cap on how many gateways to return per call. The on-chain
   *  registry can hold up to 3,000; on devnet-shrunk it's 30. */
  limit?: number;
}

export class SolanaHostsSource implements GatewayHostsSource {
  private readonly readable: SolanaARIOReadable;
  private readonly log: winston.Logger;
  private readonly limit: number;

  constructor(cfg: SolanaHostsSourceConfig) {
    this.readable = cfg.readable;
    this.log = cfg.log.child({ class: this.constructor.name });
    this.limit = cfg.limit ?? 3000;
  }

  async getHosts(): Promise<GatewayHost[]> {
    const page = await this.readable.getGateways({ limit: this.limit });
    const hosts: GatewayHost[] = [];
    for (const g of page.items) {
      const s = g.settings;
      // Defensive: skip gateways with no FQDN — their HTTP path can't
      // be assessed and a blank FQDN would resolve to nothing.
      if (!s.fqdn || s.fqdn.length === 0) {
        continue;
      }
      hosts.push({
        fqdn: s.fqdn,
        port: s.port,
        protocol: s.protocol,
        wallet: g.gatewayAddress,
      });
    }
    this.log.verbose('Loaded gateway hosts', {
      count: hosts.length,
      totalScanned: page.items.length,
    });
    return hosts;
  }
}
