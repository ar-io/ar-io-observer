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

import { Got } from 'got';
import { Logger } from 'winston';

import { createGatewayHttpClient } from '../lib/http-client.js';
import * as metrics from '../metrics.js';
import {
  ArnsConsensusResolver,
  ArnsResolution,
  CompositeReferenceGatewaySource,
  NetworkGatewaySource,
  ReferenceGatewaySource,
} from '../types.js';

/**
 * CompositeReferenceGateway orchestrates fallback between explicit hosts
 * and network gateways.
 *
 * Operating modes:
 * 1. Explicit only (networkFallback=false): Use only explicit hosts
 * 2. Explicit + network fallback (default): Falls back to network when explicit hosts fail
 * 3. Network only (networkOnly=true): Use only network gateways
 *
 * Fallback chain (ArNS):
 * - Mode 2: Explicit hosts (sequential) -> Network (consensus)
 * - Mode 3: Network (consensus)
 *
 * Fallback chain (Chunks):
 * - Mode 2: Explicit hosts (sequential) -> Network (sequential)
 * - Mode 3: Network (sequential)
 */
export class CompositeReferenceGateway
  implements CompositeReferenceGatewaySource
{
  private readonly explicitGateway: ReferenceGatewaySource | null;
  private readonly networkGatewaySource: NetworkGatewaySource | null;
  private readonly consensusResolver: ArnsConsensusResolver | null;
  private readonly networkOnly: boolean;
  private readonly networkFallback: boolean;
  private readonly log: Logger;
  private readonly gotClient: Got;

  private observedGatewayFqdn: string | null = null;

  constructor({
    explicitGateway,
    networkGatewaySource,
    consensusResolver,
    networkOnly,
    networkFallback,
    nodeReleaseVersion,
    log,
  }: {
    explicitGateway: ReferenceGatewaySource | null;
    networkGatewaySource: NetworkGatewaySource | null;
    consensusResolver: ArnsConsensusResolver | null;
    networkOnly: boolean;
    networkFallback: boolean;
    nodeReleaseVersion: string;
    log: Logger;
  }) {
    this.explicitGateway = explicitGateway;
    this.networkGatewaySource = networkGatewaySource;
    this.consensusResolver = consensusResolver;
    this.networkOnly = networkOnly;
    this.networkFallback = networkFallback;
    this.log = log.child({ class: 'CompositeReferenceGateway' });

    this.gotClient = createGatewayHttpClient(nodeReleaseVersion);

    // Validate configuration
    if ((networkOnly || networkFallback) && networkGatewaySource === null) {
      throw new Error(
        'Network gateway source required when network fallback is enabled',
      );
    }
    if ((networkOnly || networkFallback) && consensusResolver === null) {
      throw new Error(
        'Consensus resolver required when network fallback is enabled',
      );
    }
    if (!networkOnly && explicitGateway === null) {
      throw new Error('Explicit gateway required when networkOnly is false');
    }

    this.log.debug('CompositeReferenceGateway initialized', {
      networkOnly,
      networkFallback,
      hasExplicitGateway: explicitGateway !== null,
      hasNetworkGatewaySource: networkGatewaySource !== null,
      hasConsensusResolver: consensusResolver !== null,
    });
  }

  /**
   * Set the currently observed gateway to exclude from network selection.
   */
  setObservedGateway(fqdn: string | null): void {
    this.observedGatewayFqdn = fqdn;
    this.log.debug('Observed gateway set', { fqdn });
  }

  /**
   * Get ArNS resolution with fallback support.
   */
  async getArnsResolution(params: {
    arnsName: string;
    entropy: Buffer;
    referenceContentLength?: string | null;
  }): Promise<{ host: string; resolution: ArnsResolution }> {
    const { arnsName, entropy, referenceContentLength } = params;

    // Mode 3: Network only
    if (this.networkOnly) {
      return this.resolveArnsFromNetwork({
        arnsName,
        entropy,
        referenceContentLength,
      });
    }

    // Mode 1 & 2: Try explicit gateway first
    try {
      const result = await this.explicitGateway!.getArnsResolution(params);
      return result;
    } catch (explicitError: any) {
      // Mode 1: Explicit only - rethrow
      if (!this.networkFallback) {
        throw explicitError;
      }

      // Mode 2: Fall back to network
      this.log.debug(
        'Explicit gateway failed, falling back to network consensus',
        {
          arnsName,
          explicitError: explicitError?.message?.slice(0, 256),
        },
      );

      metrics.networkFallbackCounter.inc({
        operation: 'getArnsResolution',
        status: 'triggered',
      });

      try {
        const result = await this.resolveArnsFromNetwork({
          arnsName,
          entropy,
          referenceContentLength,
        });

        metrics.networkFallbackCounter.inc({
          operation: 'getArnsResolution',
          status: 'success',
        });

        return result;
      } catch (networkError: any) {
        metrics.networkFallbackCounter.inc({
          operation: 'getArnsResolution',
          status: 'failure',
        });

        throw new Error(
          `Both explicit and network resolution failed for ${arnsName}: ` +
            `explicit: ${explicitError?.message}; ` +
            `network: ${networkError?.message}`,
        );
      }
    }
  }

  /**
   * Resolve ArNS from network using consensus.
   */
  private async resolveArnsFromNetwork(params: {
    arnsName: string;
    entropy: Buffer;
    referenceContentLength?: string | null;
  }): Promise<{ host: string; resolution: ArnsResolution }> {
    if (this.consensusResolver === null) {
      throw new Error('Consensus resolver not configured');
    }

    // Build exclude list (the observed gateway should not be used for reference)
    const excludeFqdns =
      this.observedGatewayFqdn !== null ? [this.observedGatewayFqdn] : [];

    // The consensus resolver fetches gateways and handles retry-with-replacement
    return this.consensusResolver.resolveWithConsensus({
      arnsName: params.arnsName,
      entropy: params.entropy,
      excludeFqdns,
      referenceContentLength: params.referenceContentLength,
    });
  }

  /**
   * Check chunk availability with fallback support.
   */
  async checkChunkAvailability(params: {
    offset: number;
  }): Promise<{ host: string; available: boolean }> {
    const { offset } = params;

    // Mode 3: Network only
    if (this.networkOnly) {
      return this.checkChunkFromNetwork({ offset });
    }

    // Mode 1 & 2: Try explicit gateway first
    try {
      const result = await this.explicitGateway!.checkChunkAvailability(params);
      return result;
    } catch (explicitError: any) {
      // Mode 1: Explicit only - rethrow or return unavailable
      if (!this.networkFallback) {
        // Return unavailable rather than throwing for chunk checks
        return { host: 'explicit', available: false };
      }

      // Mode 2: Fall back to network
      this.log.debug(
        'Explicit gateway chunk check failed, falling back to network',
        {
          offset,
          explicitError: explicitError?.message?.slice(0, 256),
        },
      );

      metrics.networkFallbackCounter.inc({
        operation: 'checkChunkAvailability',
        status: 'triggered',
      });

      try {
        const result = await this.checkChunkFromNetwork({ offset });

        metrics.networkFallbackCounter.inc({
          operation: 'checkChunkAvailability',
          status: result.available ? 'success' : 'failure',
        });

        return result;
      } catch (networkError: any) {
        metrics.networkFallbackCounter.inc({
          operation: 'checkChunkAvailability',
          status: 'failure',
        });

        // Return unavailable for chunk checks
        return { host: 'network', available: false };
      }
    }
  }

  /**
   * Check chunk availability from network gateways (sequential).
   */
  private async checkChunkFromNetwork(params: {
    offset: number;
  }): Promise<{ host: string; available: boolean }> {
    if (this.networkGatewaySource === null) {
      throw new Error('Network gateway source not configured');
    }

    const { offset } = params;

    // Get eligible gateways, excluding the observed gateway
    const excludeFqdns =
      this.observedGatewayFqdn !== null ? [this.observedGatewayFqdn] : [];

    const gateways = await this.networkGatewaySource.getEligibleGateways({
      excludeFqdns,
    });

    if (gateways.length === 0) {
      throw new Error('No eligible network gateways available');
    }

    // Try gateways sequentially (chunks are self-verifying)
    for (const gateway of gateways) {
      try {
        const portPart = gateway.port !== 443 ? `:${gateway.port}` : '';
        const url = `https://${gateway.fqdn}${portPart}/chunk/${offset}`;

        this.log.debug('Checking chunk availability from network gateway', {
          gateway: gateway.fqdn,
          offset,
        });

        const response = await this.gotClient.get(url, {
          timeout: { request: 7000 },
          responseType: 'json',
        });

        const chunkResponse = response.body as {
          chunk?: string;
          data_path?: string;
        };

        if (response.statusCode === 200 && chunkResponse.chunk !== undefined) {
          this.log.debug('Chunk found on network gateway', {
            gateway: gateway.fqdn,
            offset,
          });

          return { host: gateway.fqdn, available: true };
        }
      } catch (error: any) {
        const statusCode = error?.response?.statusCode;

        // 404/410 are valid "chunk not found" responses, not gateway failures
        if (statusCode === 404 || statusCode === 410) {
          this.log.debug('Chunk not found on network gateway', {
            gateway: gateway.fqdn,
            offset,
            statusCode,
          });
          continue;
        }

        this.log.debug('Network gateway chunk check failed, trying next', {
          gateway: gateway.fqdn,
          offset,
          statusCode,
          error: error?.message?.slice(0, 256),
        });

        // Mark as unresponsive only on network errors/timeouts
        this.networkGatewaySource.markUnresponsive(gateway.fqdn);
      }
    }

    // All gateways failed or chunk not found
    return { host: 'network', available: false };
  }
}
