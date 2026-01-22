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

import got, { Got } from 'got';
import { Logger } from 'winston';

import * as metrics from '../metrics.js';
import { getArnsResolution } from '../observer.js';
import {
  ArnsConsensusResolver,
  ArnsResolution,
  NetworkGateway,
  NetworkGatewaySource,
} from '../types.js';

/**
 * DefaultArnsConsensusResolver resolves ArNS names by querying multiple
 * network gateways and finding consensus.
 *
 * Consensus algorithm:
 * 1. Fetch consensusSize gateways from the network
 * 2. Query all gateways in parallel
 * 3. Mark failed gateways as unresponsive
 * 4. Group successful results by resolvedId
 * 5. If most common ID has >= consensusThreshold votes, return it
 * 6. If not enough successful responses, retry with replacement gateways
 * 7. After maxAttempts, throw with disagreement details
 */
export class DefaultArnsConsensusResolver implements ArnsConsensusResolver {
  private readonly networkGatewaySource: NetworkGatewaySource;
  private readonly consensusSize: number;
  private readonly consensusThreshold: number;
  private readonly maxAttempts: number;
  private readonly log: Logger;
  private readonly gotClient: Got;

  constructor({
    networkGatewaySource,
    consensusSize,
    consensusThreshold,
    maxAttempts,
    nodeReleaseVersion,
    log,
  }: {
    networkGatewaySource: NetworkGatewaySource;
    consensusSize: number;
    consensusThreshold: number;
    maxAttempts: number;
    nodeReleaseVersion: string;
    log: Logger;
  }) {
    this.networkGatewaySource = networkGatewaySource;
    this.consensusSize = consensusSize;
    this.consensusThreshold = consensusThreshold;
    this.maxAttempts = maxAttempts;
    this.log = log.child({ class: 'DefaultArnsConsensusResolver' });

    this.gotClient = got.extend({
      headers: { 'X-AR-IO-Node-Release': nodeReleaseVersion },
      timeout: {
        lookup: 5000,
        connect: 5000,
        secureConnect: 2000,
        socket: 7000,
      },
    });

    this.log.debug('DefaultArnsConsensusResolver initialized', {
      consensusSize,
      consensusThreshold,
      maxAttempts,
    });
  }

  /**
   * Resolve an ArNS name using consensus from multiple gateways.
   * Implements retry-with-replacement when gateways fail.
   */
  async resolveWithConsensus({
    arnsName,
    entropy,
    excludeFqdns = [],
    referenceContentLength,
  }: {
    arnsName: string;
    entropy: Buffer;
    excludeFqdns?: string[];
    referenceContentLength?: string | null;
  }): Promise<{ host: string; resolution: ArnsResolution }> {
    // Track all gateways we've tried across attempts
    const triedGateways = new Set<string>(excludeFqdns);

    // Accumulate successful results across attempts
    const allSuccessfulResults: Array<{
      gateway: NetworkGateway;
      resolution: ArnsResolution;
    }> = [];

    let lastError: Error | null = null;

    for (let attempt = 0; attempt < this.maxAttempts; attempt++) {
      // Calculate how many more successful responses we need
      const neededResponses =
        this.consensusThreshold - allSuccessfulResults.length;
      // Fetch enough gateways to potentially reach consensus
      const gatewaysToFetch = Math.max(
        neededResponses,
        this.consensusSize - allSuccessfulResults.length,
      );

      if (gatewaysToFetch <= 0) {
        // We already have enough responses, check for consensus
        break;
      }

      // Fetch gateways, excluding ones we've already tried
      const gateways = await this.networkGatewaySource.getEligibleGateways({
        excludeFqdns: Array.from(triedGateways),
        maxCount: gatewaysToFetch,
      });

      if (gateways.length === 0) {
        this.log.debug('No more eligible gateways available', {
          arnsName,
          attempt,
          triedCount: triedGateways.size,
          successfulCount: allSuccessfulResults.length,
        });
        break;
      }

      this.log.debug('Starting consensus resolution attempt', {
        arnsName,
        attempt,
        gatewayCount: gateways.length,
        gateways: gateways.map((g) => g.fqdn),
        previousSuccessCount: allSuccessfulResults.length,
      });

      // Mark these gateways as tried
      for (const gw of gateways) {
        triedGateways.add(gw.fqdn);
      }

      // Query gateways in parallel
      const { successfulResults, failedGateways, error } =
        await this.queryGateways({
          arnsName,
          entropy,
          gateways,
          referenceContentLength,
        });

      // Accumulate results
      allSuccessfulResults.push(...successfulResults);

      if (error !== null) {
        lastError = error;
      }

      this.log.debug('Attempt completed', {
        arnsName,
        attempt,
        newSuccessful: successfulResults.length,
        newFailed: failedGateways.length,
        totalSuccessful: allSuccessfulResults.length,
      });

      // Check if we have enough for consensus
      if (allSuccessfulResults.length >= this.consensusThreshold) {
        const consensusResult = this.checkConsensus(
          arnsName,
          allSuccessfulResults,
        );
        if (consensusResult !== null) {
          return consensusResult;
        }
        // No consensus yet, but we might have enough responses - continue to get more
      }
    }

    // Final check for consensus with all accumulated results
    if (allSuccessfulResults.length > 0) {
      const consensusResult = this.checkConsensus(
        arnsName,
        allSuccessfulResults,
      );
      if (consensusResult !== null) {
        return consensusResult;
      }

      // No consensus achieved
      const votesByResolvedId = this.groupByResolvedId(allSuccessfulResults);
      const voteDetails = Array.from(votesByResolvedId.entries())
        .map(
          ([key, votes]) =>
            `${key}: ${votes.length} (${votes.map((v) => v.gateway.fqdn).join(', ')})`,
        )
        .join('; ');

      throw new Error(
        `No consensus for ${arnsName} after ${this.maxAttempts} attempts: ` +
          `threshold ${this.consensusThreshold}, got ${allSuccessfulResults.length} responses. ` +
          `Votes: ${voteDetails}`,
      );
    }

    // All attempts failed
    throw (
      lastError ??
      new Error(`All gateways failed for consensus resolution of ${arnsName}`)
    );
  }

  /**
   * Query a set of gateways in parallel.
   */
  private async queryGateways({
    arnsName,
    entropy,
    gateways,
    referenceContentLength,
  }: {
    arnsName: string;
    entropy: Buffer;
    gateways: NetworkGateway[];
    referenceContentLength?: string | null;
  }): Promise<{
    successfulResults: Array<{
      gateway: NetworkGateway;
      resolution: ArnsResolution;
    }>;
    failedGateways: string[];
    error: Error | null;
  }> {
    const results = await Promise.allSettled(
      gateways.map(async (gateway) => {
        const url = `https://${arnsName}.${gateway.fqdn}/`;
        try {
          const resolution = await getArnsResolution({
            url,
            got: this.gotClient,
            referenceGatewayContentLength: referenceContentLength,
            entropy,
          });

          // Validate required headers for ArNS resolution (unless 404)
          if (resolution.statusCode !== 404) {
            if (resolution.resolvedId === null) {
              throw new Error(
                `Missing x-arns-resolved-id header from ${gateway.fqdn}`,
              );
            }
            if (resolution.ttlSeconds === null) {
              throw new Error(
                `Missing x-arns-ttl-seconds header from ${gateway.fqdn}`,
              );
            }
          }

          return {
            gateway,
            resolution,
          };
        } catch (error: any) {
          // Mark gateway as unresponsive for future selections
          this.networkGatewaySource.markUnresponsive(gateway.fqdn);
          throw error;
        }
      }),
    );

    const successfulResults: Array<{
      gateway: NetworkGateway;
      resolution: ArnsResolution;
    }> = [];
    const failedGateways: string[] = [];
    let lastError: Error | null = null;

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      const gateway = gateways[i];

      if (result.status === 'fulfilled') {
        successfulResults.push(result.value);
      } else {
        failedGateways.push(gateway.fqdn);
        lastError = result.reason;
        this.log.debug('Gateway failed during consensus resolution', {
          arnsName,
          gateway: gateway.fqdn,
          error: result.reason?.message?.slice(0, 256),
        });
      }
    }

    return { successfulResults, failedGateways, error: lastError };
  }

  /**
   * Group results by resolvedId.
   */
  private groupByResolvedId(
    results: Array<{ gateway: NetworkGateway; resolution: ArnsResolution }>,
  ): Map<
    string,
    Array<{ gateway: NetworkGateway; resolution: ArnsResolution }>
  > {
    const votesByResolvedId = new Map<
      string,
      Array<{ gateway: NetworkGateway; resolution: ArnsResolution }>
    >();

    for (const result of results) {
      const key = result.resolution.resolvedId ?? 'null';
      const existing = votesByResolvedId.get(key) ?? [];
      existing.push(result);
      votesByResolvedId.set(key, existing);
    }

    return votesByResolvedId;
  }

  /**
   * Check if consensus has been achieved.
   * Returns the winning result if consensus is met, null otherwise.
   */
  private checkConsensus(
    arnsName: string,
    results: Array<{ gateway: NetworkGateway; resolution: ArnsResolution }>,
  ): { host: string; resolution: ArnsResolution } | null {
    const votesByResolvedId = this.groupByResolvedId(results);

    // Find the most common resolvedId
    let maxVotes = 0;
    let winningResults: Array<{
      gateway: NetworkGateway;
      resolution: ArnsResolution;
    }> = [];

    for (const [, votes] of votesByResolvedId) {
      if (votes.length > maxVotes) {
        maxVotes = votes.length;
        winningResults = votes;
      }
    }

    // Record consensus agreement metrics
    metrics.networkConsensusAgreementHistogram.observe(maxVotes);

    this.log.debug('Consensus vote check', {
      arnsName,
      totalResponses: results.length,
      maxVotes,
      threshold: this.consensusThreshold,
      voteDistribution: Array.from(votesByResolvedId.entries()).map(
        ([key, votes]) => ({
          resolvedId: key,
          votes: votes.length,
          gateways: votes.map((v) => v.gateway.fqdn),
        }),
      ),
    });

    // Check if consensus threshold is met
    if (maxVotes >= this.consensusThreshold) {
      const winner = winningResults[0];

      this.log.debug('Consensus achieved', {
        arnsName,
        resolvedId: winner.resolution.resolvedId,
        votesForWinner: maxVotes,
        winningGateway: winner.gateway.fqdn,
      });

      return {
        host: winner.gateway.fqdn,
        resolution: winner.resolution,
      };
    }

    return null;
  }
}
