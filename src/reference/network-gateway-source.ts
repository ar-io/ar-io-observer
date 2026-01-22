/**
 * AR.IO Observer
 * Copyright (C) 2023 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */

import { AoARIORead } from '@ar.io/sdk/node';
import { Logger } from 'winston';

import * as metrics from '../metrics.js';
import {
  NetworkGateway,
  NetworkGatewaySelectionConfig,
  NetworkGatewaySource,
} from '../types.js';

/**
 * CachedNetworkGatewaySource queries and caches eligible network gateways
 * from the AR.IO contract.
 *
 * Selection criteria:
 * - Gateway status is 'joined'
 * - Has valid FQDN with HTTPS protocol
 * - Total epoch count >= minEpochCount
 * - Pass rate (passedEpochCount / totalEpochCount) >= minPassRate
 * - Passed consecutive epochs >= minConsecutivePasses
 *
 * Features:
 * - Caches gateway list with configurable TTL
 * - Stale-while-error: uses expired cache if refresh fails
 * - Tracks unresponsive gateways to skip in subsequent selections
 * - Clears unresponsive list when cache refreshes
 */
export class CachedNetworkGatewaySource implements NetworkGatewaySource {
  private readonly contract: AoARIORead;
  private readonly config: NetworkGatewaySelectionConfig;
  private readonly log: Logger;

  private cachedGateways: NetworkGateway[] = [];
  private cacheTimestamp: number = 0;
  private unresponsiveGateways: Set<string> = new Set();
  private refreshInProgress: boolean = false;

  constructor({
    contract,
    config,
    log,
  }: {
    contract: AoARIORead;
    config: NetworkGatewaySelectionConfig;
    log: Logger;
  }) {
    this.contract = contract;
    this.config = config;
    this.log = log.child({ class: 'CachedNetworkGatewaySource' });

    this.log.debug('CachedNetworkGatewaySource initialized', {
      config: this.config,
    });
  }

  /**
   * Check if the cache is still valid.
   */
  private isCacheValid(): boolean {
    const now = Date.now();
    const cacheAgeMs = now - this.cacheTimestamp;
    return cacheAgeMs < this.config.cacheTtlSeconds * 1000;
  }

  /**
   * Refresh the gateway cache from the contract.
   */
  private async refreshCache(): Promise<void> {
    if (this.refreshInProgress) {
      return;
    }

    this.refreshInProgress = true;

    try {
      this.log.debug('Refreshing network gateway cache');

      const gateways: NetworkGateway[] = [];
      let cursor: string | undefined;

      do {
        const { nextCursor, items } = await this.contract.getGateways({
          cursor,
        });

        for (const gateway of items) {
          // Skip gateways without valid FQDN or not joined
          if (gateway.settings.fqdn === undefined) {
            continue;
          }

          // Skip non-HTTPS gateways
          if (gateway.settings.protocol !== 'https') {
            continue;
          }

          // Calculate pass rate
          const totalEpochCount = gateway.stats.totalEpochCount ?? 0;
          const passedEpochCount = gateway.stats.passedEpochCount ?? 0;
          const passedConsecutiveEpochs =
            gateway.stats.passedConsecutiveEpochs ?? 0;

          // Check minimum epoch count
          if (totalEpochCount < this.config.minEpochCount) {
            continue;
          }

          // Calculate pass rate
          const passRate =
            totalEpochCount > 0 ? passedEpochCount / totalEpochCount : 0;

          // Check pass rate
          if (passRate < this.config.minPassRate) {
            continue;
          }

          // Check consecutive passes
          if (passedConsecutiveEpochs < this.config.minConsecutivePasses) {
            continue;
          }

          gateways.push({
            fqdn: gateway.settings.fqdn,
            protocol: gateway.settings.protocol,
            port: gateway.settings.port ?? 443,
            gatewayAddress: gateway.gatewayAddress,
            passRate,
            passedConsecutiveEpochs,
          });
        }

        cursor = nextCursor;
      } while (cursor !== undefined);

      // Sort by pass rate (descending) and consecutive passes (descending)
      gateways.sort((a, b) => {
        if (b.passRate !== a.passRate) {
          return b.passRate - a.passRate;
        }
        return b.passedConsecutiveEpochs - a.passedConsecutiveEpochs;
      });

      this.cachedGateways = gateways;
      this.cacheTimestamp = Date.now();
      // Clear unresponsive list on cache refresh
      this.unresponsiveGateways.clear();

      // Update metrics
      metrics.networkEligibleGatewaysGauge.set(gateways.length);

      this.log.debug('Network gateway cache refreshed', {
        eligibleCount: gateways.length,
        topGateways: gateways.slice(0, 3).map((g) => ({
          fqdn: g.fqdn,
          passRate: g.passRate.toFixed(2),
          consecutivePasses: g.passedConsecutiveEpochs,
        })),
      });
    } catch (error: any) {
      this.log.error('Failed to refresh network gateway cache', {
        error: error?.message,
      });

      // Stale-while-error: keep existing cache if available
      if (this.cachedGateways.length > 0) {
        this.log.warn('Using stale gateway cache due to refresh failure', {
          cacheAge: Date.now() - this.cacheTimestamp,
          cachedCount: this.cachedGateways.length,
        });
      } else {
        throw error;
      }
    } finally {
      this.refreshInProgress = false;
    }
  }

  /**
   * Get eligible gateways from the network.
   *
   * @param excludeFqdns FQDNs to exclude from selection (e.g., observed gateway)
   * @param maxCount Maximum number of gateways to return
   */
  async getEligibleGateways({
    excludeFqdns = [],
    maxCount,
  }: {
    excludeFqdns?: string[];
    maxCount?: number;
  }): Promise<NetworkGateway[]> {
    // Refresh cache if needed
    if (!this.isCacheValid()) {
      await this.refreshCache();
    }

    const effectiveMaxCount = maxCount ?? this.config.maxCount;
    const excludeSet = new Set([...excludeFqdns, ...this.unresponsiveGateways]);

    // Filter out excluded and unresponsive gateways
    const eligibleGateways = this.cachedGateways.filter(
      (g) => !excludeSet.has(g.fqdn),
    );

    // Return up to maxCount gateways
    return eligibleGateways.slice(0, effectiveMaxCount);
  }

  /**
   * Mark a gateway as unresponsive.
   *
   * Unresponsive gateways are skipped in subsequent selections until
   * the cache is refreshed.
   */
  markUnresponsive(fqdn: string): void {
    this.unresponsiveGateways.add(fqdn);
    this.log.debug('Gateway marked as unresponsive', {
      fqdn,
      unresponsiveCount: this.unresponsiveGateways.size,
    });
  }
}
