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
import { ReadThroughPromiseCache } from '@ardrive/ardrive-promise-cache';
import { Logger } from 'winston';

import { ArnsResolution, ReferenceGatewaySource } from '../types.js';

// ArNS names and FQDNs never contain a newline, so it cannot collide.
const KEY_SEPARATOR = '\n';

function sameHost(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * Per-epoch cache of reference ArNS resolutions that never answers an
 * observed gateway with its own resolution.
 *
 * Most gateways share one reference resolution per name, so the cache
 * keeps the shared answer under the bare name. When that answer came
 * from the gateway now being observed (for example, when observing
 * turbo-gateway.com while it is the first reference host), the lookup is
 * repeated with that gateway excluded and cached under a per-gateway
 * key. Only reference gateways ever take the second path, so this costs
 * a few extra lookups per name, not one per observed gateway.
 *
 * The exclusion is an argument to `get`, not state on the cache or the
 * reference source, so concurrent assessments cannot interfere.
 *
 * If no other reference can answer (for example a single explicit host
 * with network fallback disabled), `get` returns the gateway's own
 * resolution, as before this exclusion existed, and logs a warning. An
 * observer-side shortage of references must not fail the gateway.
 */
export class ReferenceResolutionCache {
  private readonly cache: ReadThroughPromiseCache<
    string,
    { host: string; resolution: ArnsResolution }
  >;
  private readonly log: Logger | undefined;

  constructor({
    referenceGateway,
    entropy,
    capacity,
    ttlMs,
    log,
  }: {
    referenceGateway: ReferenceGatewaySource;
    entropy: Buffer;
    capacity: number;
    ttlMs: number;
    log?: Logger;
  }) {
    this.log = log;
    this.cache = new ReadThroughPromiseCache({
      cacheParams: { cacheCapacity: capacity, cacheTTL: ttlMs },
      readThroughFunction: async (key: string) => {
        const [arnsName, excludedFqdn] = key.split(KEY_SEPARATOR);
        return referenceGateway.getArnsResolution({
          arnsName,
          entropy,
          ...(excludedFqdn !== undefined
            ? { excludeFqdns: [excludedFqdn] }
            : {}),
        });
      },
    });
  }

  /**
   * Reference resolution for `arnsName`, guaranteed not to have been
   * served by `observedFqdn`.
   */
  async get(arnsName: string, observedFqdn: string): Promise<ArnsResolution> {
    const shared = await this.cache.get(arnsName);
    if (!sameHost(shared.host, observedFqdn)) {
      return shared.resolution;
    }
    try {
      const own = await this.cache.get(
        `${arnsName}${KEY_SEPARATOR}${observedFqdn.toLowerCase()}`,
      );
      return own.resolution;
    } catch (error: any) {
      this.log?.warn(
        'No reference other than the observed gateway; comparing it with itself',
        {
          arnsName,
          observedFqdn,
          error: error?.message?.slice(0, 256),
        },
      );
      return shared.resolution;
    }
  }
}
