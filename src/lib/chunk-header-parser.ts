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

import { ChunkHeaderMetadata } from '../types.js';

type RawHeaders = Record<string, string | string[] | undefined>;

function firstValue(headers: RawHeaders, name: string): string | undefined {
  const v = headers[name];
  if (v === undefined) return undefined;
  return Array.isArray(v) ? v[0] : v;
}

function parseBigIntHeader(raw: string | undefined): bigint | undefined {
  if (raw === undefined || raw === '') return undefined;
  try {
    const v = BigInt(raw);
    if (v < 0n) return undefined;
    return v;
  } catch {
    return undefined;
  }
}

export function parseChunkHeaderMetadata(
  headers: RawHeaders,
): ChunkHeaderMetadata | null {
  const txId = firstValue(headers, 'x-arweave-chunk-tx-id');
  const dataRoot = firstValue(headers, 'x-arweave-chunk-data-root');
  const dataPath = firstValue(headers, 'x-arweave-chunk-data-path');
  const txPath = firstValue(headers, 'x-arweave-chunk-tx-path');
  const txStartOffset = parseBigIntHeader(
    firstValue(headers, 'x-arweave-chunk-tx-start-offset'),
  );
  const txDataSize = parseBigIntHeader(
    firstValue(headers, 'x-arweave-chunk-tx-data-size'),
  );
  const chunkStartOffset = parseBigIntHeader(
    firstValue(headers, 'x-arweave-chunk-start-offset'),
  );
  const chunkRelativeStartOffset = parseBigIntHeader(
    firstValue(headers, 'x-arweave-chunk-relative-start-offset'),
  );

  if (
    txId === undefined ||
    txId === '' ||
    dataRoot === undefined ||
    dataRoot === '' ||
    dataPath === undefined ||
    dataPath === '' ||
    txPath === undefined ||
    txPath === '' ||
    txStartOffset === undefined ||
    txDataSize === undefined ||
    chunkStartOffset === undefined ||
    chunkRelativeStartOffset === undefined
  ) {
    return null;
  }

  return {
    txId,
    dataRoot,
    dataPath,
    txPath,
    txStartOffset,
    txDataSize,
    chunkStartOffset,
    chunkRelativeStartOffset,
  };
}
