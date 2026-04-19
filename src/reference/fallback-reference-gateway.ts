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

import { validateArnsResolutionHeaders } from '../lib/arns-validation.js';
import { parseChunkHeaderMetadata } from '../lib/chunk-header-parser.js';
import { createGatewayHttpClient } from '../lib/http-client.js';
import * as metrics from '../metrics.js';
import { getArnsResolution } from '../observer.js';
import {
  ArnsResolution,
  ChunkHeaderMetadata,
  ReferenceGatewaySource,
} from '../types.js';

/**
 * FallbackReferenceGateway provides reference gateway operations with
 * sequential fallback support across multiple hosts.
 *
 * When the primary gateway fails or returns invalid responses, it
 * automatically tries the next gateway in the list.
 */
export class FallbackReferenceGateway implements ReferenceGatewaySource {
  private readonly hosts: string[];
  private readonly log: Logger;
  private readonly gotClient: Got;

  constructor({
    hosts,
    nodeReleaseVersion,
    log,
  }: {
    hosts: string[];
    nodeReleaseVersion: string;
    log: Logger;
  }) {
    if (hosts.length === 0) {
      throw new Error('At least one reference gateway host is required');
    }

    this.hosts = hosts;
    this.log = log.child({ class: 'FallbackReferenceGateway' });

    this.gotClient = createGatewayHttpClient(nodeReleaseVersion);

    this.log.debug('FallbackReferenceGateway initialized', {
      hosts: this.hosts,
    });
  }

  /**
   * Try an operation with sequential fallback across hosts.
   *
   * @param operation Function that takes a host and returns a result
   * @param operationName Name of the operation for logging
   * @returns The result from the first successful host
   */
  private async tryWithFallback<T>(
    operation: (host: string) => Promise<T>,
    operationName: string,
  ): Promise<{ host: string; result: T }> {
    let lastError: Error | undefined;

    for (let i = 0; i < this.hosts.length; i++) {
      const host = this.hosts[i];

      try {
        const result = await operation(host);
        return { host, result };
      } catch (error: any) {
        lastError = error;

        this.log.debug(`${operationName} failed on host, trying fallback`, {
          host,
          hostIndex: i,
          totalHosts: this.hosts.length,
          error: error?.message?.slice(0, 256),
        });

        // Increment fallback counter when falling back to the next host
        if (i + 1 < this.hosts.length) {
          metrics.referenceGatewayFallbackCounter.inc({
            operation: operationName,
            host: this.hosts[i + 1],
          });
        }
      }
    }

    throw new Error(
      `${operationName} failed on all hosts: ${lastError?.message}`,
    );
  }

  /**
   * Get ArNS resolution from reference gateways with fallback.
   *
   * Validates that the response contains valid x-arns-resolved-id
   * and x-arns-ttl-seconds headers.
   */
  async getArnsResolution(params: {
    arnsName: string;
    entropy: Buffer;
    referenceContentLength?: string | null;
  }): Promise<{ host: string; resolution: ArnsResolution }> {
    const { arnsName, entropy, referenceContentLength } = params;

    const { host, result } = await this.tryWithFallback(async (host) => {
      const url = `https://${arnsName}.${host}/`;

      const resolution = await getArnsResolution({
        url,
        got: this.gotClient,
        referenceGatewayContentLength: referenceContentLength,
        entropy,
      });

      validateArnsResolutionHeaders(resolution, host, arnsName);

      return resolution;
    }, 'getArnsResolution');

    return { host, resolution: result };
  }

  /**
   * Check chunk availability from reference gateways with fallback.
   *
   * 404/410 responses are treated as authoritative "chunk not found" and
   * return immediately. Network errors trigger fallback to the next host.
   * If all hosts fail with non-404/410 errors, throws to allow network fallback.
   */
  async checkChunkAvailability(params: {
    offset: number;
  }): Promise<{ host: string; available: boolean }> {
    const { offset } = params;
    let lastError: Error | undefined;

    for (let i = 0; i < this.hosts.length; i++) {
      const host = this.hosts[i];
      const url = `https://${host}/chunk/${offset}`;

      this.log.debug('Checking chunk availability', {
        host,
        offset,
        url,
      });

      try {
        const response = await this.gotClient.get(url, {
          timeout: { request: 7000 },
          responseType: 'json',
        });

        const chunkResponse = response.body as {
          chunk?: string;
          data_path?: string;
        };

        // Validate response structure
        if (response.statusCode !== 200) {
          throw new Error(
            `Unexpected status code ${response.statusCode} from ${host}`,
          );
        }

        if (chunkResponse.chunk === undefined) {
          throw new Error(`Missing chunk field in response from ${host}`);
        }

        return { host, available: true };
      } catch (error: any) {
        const statusCode = error?.response?.statusCode;

        // 404/410 are authoritative "chunk not found" - return immediately
        if (statusCode === 404 || statusCode === 410) {
          this.log.debug('Chunk not found (authoritative response)', {
            host,
            offset,
            statusCode,
          });
          return { host, available: false };
        }

        // Other errors - try next host
        lastError = error;
        this.log.debug('Chunk availability check failed, trying fallback', {
          host,
          hostIndex: i,
          totalHosts: this.hosts.length,
          statusCode,
          error: error?.message?.slice(0, 256),
        });

        // Increment fallback counter when falling back to the next host
        if (i + 1 < this.hosts.length) {
          metrics.referenceGatewayFallbackCounter.inc({
            operation: 'checkChunkAvailability',
            host: this.hosts[i + 1],
          });
        }
      }
    }

    // All hosts failed with non-404/410 errors - throw to trigger network fallback
    throw new Error(
      `checkChunkAvailability failed on all hosts: ${lastError?.message}`,
    );
  }

  /**
   * Fetch chunk metadata headers from reference gateways with fallback.
   *
   * Performs a HEAD request to `/chunk/{offset}/data` and extracts the
   * `x-arweave-chunk-*` headers that advertise tx boundaries, data_root,
   * and merkle proofs.
   *
   * Returns `metadata: null` when the first successful host omits the
   * required headers (older gateway) — caller should fall back. 404/410
   * responses are authoritative "chunk not found" and also return null.
   * Throws only when every host fails with network/HTTP errors.
   */
  async getChunkMetadata(params: {
    offset: number;
  }): Promise<{ host: string; metadata: ChunkHeaderMetadata | null }> {
    const { offset } = params;
    let lastError: Error | undefined;
    // Track the most recent host that produced any HTTP response (200
    // without headers, 404, 410, etc.) so we can return metadata:null
    // against a reachable host rather than throwing when no host ends
    // up advertising the headers.
    let lastReachableHost: string | undefined;

    const incrementFallbackCounter = (nextHostIndex: number) => {
      if (nextHostIndex < this.hosts.length) {
        metrics.referenceGatewayFallbackCounter.inc({
          operation: 'getChunkMetadata',
          host: this.hosts[nextHostIndex],
        });
      }
    };

    for (let i = 0; i < this.hosts.length; i++) {
      const host = this.hosts[i];
      const url = `https://${host}/chunk/${offset}/data`;

      this.log.debug('Fetching chunk metadata headers', { host, offset, url });

      try {
        const response = await this.gotClient.head(url, {
          timeout: { request: 3000 },
        });

        if (response.statusCode !== 200) {
          throw new Error(
            `Unexpected status code ${response.statusCode} from ${host}`,
          );
        }

        const metadata = parseChunkHeaderMetadata(response.headers);
        if (metadata !== null) {
          return { host, metadata };
        }

        // 200 without usable headers: reachable but doesn't expose the
        // chunk metadata headers (older deployment). Try the next host.
        this.log.debug(
          'Chunk metadata headers missing or malformed, trying fallback',
          { host, offset, hostIndex: i, totalHosts: this.hosts.length },
        );
        lastReachableHost = host;
        incrementFallbackCounter(i + 1);
        continue;
      } catch (error: any) {
        const statusCode = error?.response?.statusCode;

        // Unlike `/chunk/{offset}`, a 404/410 on `/chunk/{offset}/data`
        // can just mean "this host doesn't expose that endpoint" — it's
        // not authoritative. Keep trying later hosts that might.
        if (statusCode === 404 || statusCode === 410) {
          this.log.debug(
            'Chunk metadata endpoint returned 404/410, trying fallback',
            { host, offset, statusCode },
          );
          lastReachableHost = host;
          incrementFallbackCounter(i + 1);
          continue;
        }

        lastError = error;
        this.log.debug('Chunk metadata fetch failed, trying fallback', {
          host,
          hostIndex: i,
          totalHosts: this.hosts.length,
          statusCode,
          error: error?.message?.slice(0, 256),
        });
        if (statusCode !== undefined) {
          // Any other HTTP response still counts as reachable.
          lastReachableHost = host;
        }
        incrementFallbackCounter(i + 1);
      }
    }

    // Prefer reporting the reachable-but-unsupported outcome over the
    // transport error so callers can distinguish "feature unavailable"
    // from "reference side down".
    if (lastReachableHost !== undefined) {
      return { host: lastReachableHost, metadata: null };
    }

    throw new Error(
      `getChunkMetadata failed on all hosts: ${lastError?.message}`,
    );
  }
}
