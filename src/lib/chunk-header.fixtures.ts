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
import type { ChunkHeaderMetadata } from '../types.js';

export const completeHeaders = {
  'x-arweave-chunk-tx-id': 'T3DcnZlZg_FqOQUf9MSZXQ5j7_ETc04OEqbkX-MZRnc',
  'x-arweave-chunk-tx-start-offset': '108631448658167',
  'x-arweave-chunk-tx-data-size': '42724169',
  'x-arweave-chunk-data-root': 'qoQEdVyTqjLpkybZAgkIgtNawXUHUd5TJZwkWx0Vo-A',
  'x-arweave-chunk-data-path': 'E2OKmVV7k4k',
  'x-arweave-chunk-tx-path': 'H9gNFx8dbHj',
  'x-arweave-chunk-start-offset': '108631449706743',
  'x-arweave-chunk-relative-start-offset': '1048576',
};

export const completeMetadata: ChunkHeaderMetadata = {
  txId: completeHeaders['x-arweave-chunk-tx-id'],
  txStartOffset: BigInt(completeHeaders['x-arweave-chunk-tx-start-offset']),
  txDataSize: BigInt(completeHeaders['x-arweave-chunk-tx-data-size']),
  dataRoot: completeHeaders['x-arweave-chunk-data-root'],
  dataPath: completeHeaders['x-arweave-chunk-data-path'],
  txPath: completeHeaders['x-arweave-chunk-tx-path'],
  chunkStartOffset: BigInt(completeHeaders['x-arweave-chunk-start-offset']),
  chunkRelativeStartOffset: BigInt(
    completeHeaders['x-arweave-chunk-relative-start-offset'],
  ),
};
