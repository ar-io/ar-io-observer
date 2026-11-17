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

import { ArnsResolution } from '../types.js';

export function validateArnsResolutionHeaders(
  resolution: ArnsResolution,
  source: string,
  arnsName?: string,
): void {
  if (resolution.statusCode === 404) return;

  const nameContext = arnsName !== undefined ? ` for ${arnsName}` : '';

  if (resolution.resolvedId === null) {
    throw new Error(
      `Missing x-arns-resolved-id header from ${source}${nameContext}`,
    );
  }
  if (resolution.ttlSeconds === null) {
    throw new Error(
      `Missing x-arns-ttl-seconds header from ${source}${nameContext}`,
    );
  }
}

// A name is reachable only as the subdomain label `<name>.<host>`, and
// hostnames reach a gateway lowercased, so a name with uppercase letters,
// dots or other characters a label cannot carry can never resolve there.
// The registry holds a few (`1.21212E+14`: a number a spreadsheet wrote in
// scientific notation), and every gateway fails them.
const SUBDOMAIN_LABEL = /^[a-z0-9_-]{1,63}$/;

/**
 * Whether `name` can be resolved as a gateway subdomain label.
 */
export function isSubdomainLabel(name: string): boolean {
  return SUBDOMAIN_LABEL.test(name);
}

/**
 * The media type of a Content-Type header, without its parameters.
 *
 * Gateways disagree on parameters for the same bytes: a gateway that
 * cached an item from an upstream peer may keep that peer's
 * `application/json; charset=utf-8`, while one that indexed the item serves
 * the tag's `application/json`. Neither is wrong, so only the media type is
 * compared.
 */
export function mediaType(contentType: string | null): string | null {
  if (contentType === null) return null;
  return contentType.split(';')[0].trim().toLowerCase();
}

/**
 * Compare a gateway's resolution with the reference's, returning why they
 * differ, or undefined when they match.
 */
export function compareArnsResolutions(
  reference: ArnsResolution,
  gateway: ArnsResolution,
): string | undefined {
  const mismatches: string[] = [];
  if (reference.resolvedId !== gateway.resolvedId) {
    mismatches.push('resolvedId mismatch');
  }
  if (reference.ttlSeconds !== gateway.ttlSeconds) {
    mismatches.push('ttlSeconds mismatch');
  }
  if (mediaType(reference.contentType) !== mediaType(gateway.contentType)) {
    mismatches.push('contentType mismatch');
  }
  if (reference.dataHashDigest !== gateway.dataHashDigest) {
    mismatches.push('dataHashDigest mismatch');
  }
  return mismatches.length > 0 ? mismatches.join(', ') : undefined;
}

/**
 * The reference gateway could not resolve a name, so a gateway's
 * resolution of it cannot be judged.
 */
export class ReferenceResolutionError extends Error {
  constructor(cause: unknown) {
    const message =
      cause instanceof Error ? cause.message : String(cause ?? 'unknown');
    super(`Reference resolution failed: ${message}`);
    this.name = 'ReferenceResolutionError';
  }
}
