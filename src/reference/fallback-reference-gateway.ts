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
import { ArnsResolution, ReferenceGatewaySource } from '../types.js';

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

    this.gotClient = got.extend({
      headers: { 'X-AR-IO-Node-Release': nodeReleaseVersion },
      timeout: {
        lookup: 5000,
        connect: 5000,
        secureConnect: 2000,
        socket: 7000,
      },
    });

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

      // Validate required headers for ArNS resolution
      // A valid ArNS resolution must have both resolvedId and ttlSeconds
      // unless it's a 404 (name not found)
      if (resolution.statusCode !== 404) {
        if (resolution.resolvedId === null) {
          throw new Error(
            `Missing x-arns-resolved-id header from ${host} for ${arnsName}`,
          );
        }
        if (resolution.ttlSeconds === null) {
          throw new Error(
            `Missing x-arns-ttl-seconds header from ${host} for ${arnsName}`,
          );
        }
      }

      return resolution;
    }, 'getArnsResolution');

    return { host, resolution: result };
  }

  /**
   * Check chunk availability from reference gateways with fallback.
   *
   * Validates that the response is HTTP 200 with a valid chunk field.
   */
  async checkChunkAvailability(params: {
    offset: number;
  }): Promise<{ host: string; available: boolean }> {
    const { offset } = params;

    try {
      const { host, result } = await this.tryWithFallback(async (host) => {
        const url = `https://${host}/chunk/${offset}`;

        this.log.debug('Checking chunk availability', {
          host,
          offset,
          url,
        });

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

        return true;
      }, 'checkChunkAvailability');

      return { host, available: result };
    } catch (error: any) {
      // If all hosts fail, return unavailable
      this.log.debug('Chunk availability check failed on all hosts', {
        offset,
        error: error?.message,
      });

      return { host: this.hosts[0], available: false };
    }
  }
}
