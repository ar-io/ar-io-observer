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
import * as metrics from '../metrics.js';
import type { GatewayHost, GatewayHostsSource } from '../types.js';

export interface SolanaHostsSourceConfig {
  readable: SolanaARIOReadable;
  log: winston.Logger;
  /** Cap on how many gateways to return per call. The on-chain
   *  registry can hold up to 3,000; on devnet-shrunk it's 30. */
  limit?: number;
  /** Exclude gateways the registry reports as `leaving`. Defaults to
   *  true; `system.ts` injects `config.SKIP_LEAVING_GATEWAYS`. */
  skipLeaving?: boolean;
}

export class SolanaHostsSource implements GatewayHostsSource {
  private readonly readable: SolanaARIOReadable;
  private readonly log: winston.Logger;
  private readonly limit: number;
  private readonly skipLeaving: boolean;

  constructor(cfg: SolanaHostsSourceConfig) {
    this.readable = cfg.readable;
    this.log = cfg.log.child({ class: this.constructor.name });
    this.limit = cfg.limit ?? 3000;
    this.skipLeaving = cfg.skipLeaving ?? true;
  }

  /**
   * Read the gateway registry and return the hosts to assess this epoch.
   *
   * Two kinds of gateway are dropped: those with no FQDN (nothing to
   * request), and — unless `skipLeaving` is false — those the registry
   * reports as `leaving`. Only an explicit `leaving` is excluded; see the
   * comment on the filter for why unknown status is deliberately kept.
   */
  async getHosts(): Promise<GatewayHost[]> {
    const page = await this.readable.getGateways({ limit: this.limit });
    const hosts: GatewayHost[] = [];
    let skippedLeaving = 0;
    for (const g of page.items) {
      const s = g.settings;
      // Defensive: skip gateways with no FQDN — their HTTP path can't
      // be assessed and a blank FQDN would resolve to nothing.
      if (!s.fqdn || s.fqdn.length === 0) {
        continue;
      }

      // Skip gateways the registry says are on their way out.
      //
      // A gateway is `leaving` either because its operator withdrew it or
      // because the network demoted it after 30 consecutive failed epochs,
      // so the status doubles as a consensus liveness signal. Neither kind
      // can be affected by observing it: `leaving` is terminal (there is no
      // path back to `joined`), such a gateway is already excluded from the
      // reward set, and it cannot be demoted again. Assessing it only
      // rediscovers, one DNS timeout at a time, what the registry already
      // says.
      //
      // Measured on mainnet 2026-08-30: 334 of 646 registered gateways were
      // `leaving` — 51.7% of the registry and, at OBSERVATIONS_PER_GATEWAY=3,
      // roughly half the epoch's observation budget. Of those sampled that
      // epoch, 84 of 84 failed while joined gateways failed 22 of 87, so the
      // cohort also puts a hard ~50% floor under the reported failure rate,
      // consuming most of the headroom below
      // OBSERVER_MAX_GATEWAY_FAILURE_THRESHOLD (0.9), above which the whole
      // report is suppressed.
      //
      // Deliberately excludes ONLY an explicit 'leaving'. A gateway whose
      // status is absent or unrecognised is kept, so a registry or SDK that
      // stops reporting status degrades to the previous behaviour rather
      // than emptying the host list — which would silently produce an empty
      // report rather than an obviously broken one.
      if (this.skipLeaving && g.status === 'leaving') {
        skippedLeaving++;
        continue;
      }

      hosts.push({
        fqdn: s.fqdn,
        port: s.port,
        protocol: s.protocol,
        wallet: g.gatewayAddress,
      });
    }
    metrics.gatewaysSkippedLeavingCounter.inc(skippedLeaving);
    this.log.verbose('Loaded gateway hosts', {
      count: hosts.length,
      totalScanned: page.items.length,
      skippedLeaving,
    });
    return hosts;
  }
}
