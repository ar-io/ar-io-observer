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
import { expect } from 'chai';

import { parseChunkHeaderMetadata } from './chunk-header-parser.js';

const completeHeaders = {
  'x-arweave-chunk-tx-id': 'T3DcnZlZg_FqOQUf9MSZXQ5j7_ETc04OEqbkX-MZRnc',
  'x-arweave-chunk-tx-start-offset': '108631448658167',
  'x-arweave-chunk-tx-data-size': '42724169',
  'x-arweave-chunk-data-root': 'qoQEdVyTqjLpkybZAgkIgtNawXUHUd5TJZwkWx0Vo-A',
  'x-arweave-chunk-data-path': 'E2OKmVV7k4k',
  'x-arweave-chunk-tx-path': 'H9gNFx8dbHj',
  'x-arweave-chunk-start-offset': '108631449706743',
  'x-arweave-chunk-relative-start-offset': '1048576',
};

describe('parseChunkHeaderMetadata', function () {
  it('parses a complete set of headers', function () {
    const parsed = parseChunkHeaderMetadata(completeHeaders);
    expect(parsed).to.not.equal(null);
    expect(parsed!.txId).to.equal(completeHeaders['x-arweave-chunk-tx-id']);
    expect(parsed!.txStartOffset).to.equal(108631448658167n);
    expect(parsed!.txDataSize).to.equal(42724169n);
    expect(parsed!.chunkStartOffset).to.equal(108631449706743n);
    expect(parsed!.chunkRelativeStartOffset).to.equal(1048576n);
    expect(parsed!.dataRoot).to.equal(
      completeHeaders['x-arweave-chunk-data-root'],
    );
    expect(parsed!.dataPath).to.equal(
      completeHeaders['x-arweave-chunk-data-path'],
    );
    expect(parsed!.txPath).to.equal(completeHeaders['x-arweave-chunk-tx-path']);
  });

  it('returns null when a required string header is missing', function () {
    const { ['x-arweave-chunk-tx-id']: _omit, ...missing } = completeHeaders;
    expect(parseChunkHeaderMetadata(missing)).to.equal(null);
  });

  it('returns null when a required string header is empty', function () {
    const empty = { ...completeHeaders, 'x-arweave-chunk-data-root': '' };
    expect(parseChunkHeaderMetadata(empty)).to.equal(null);
  });

  it('returns null when a numeric header is not parseable', function () {
    const malformed = {
      ...completeHeaders,
      'x-arweave-chunk-tx-start-offset': 'not-a-number',
    };
    expect(parseChunkHeaderMetadata(malformed)).to.equal(null);
  });

  it('returns null when a numeric header is negative', function () {
    const negative = {
      ...completeHeaders,
      'x-arweave-chunk-tx-data-size': '-1',
    };
    expect(parseChunkHeaderMetadata(negative)).to.equal(null);
  });

  it('preserves precision for offsets beyond Number.MAX_SAFE_INTEGER', function () {
    const huge = '9007199254740993'; // MAX_SAFE_INTEGER + 2
    const headers = {
      ...completeHeaders,
      'x-arweave-chunk-tx-start-offset': huge,
    };
    const parsed = parseChunkHeaderMetadata(headers);
    expect(parsed).to.not.equal(null);
    expect(parsed!.txStartOffset).to.equal(BigInt(huge));
  });

  it('takes the first value when a header is an array', function () {
    const arr = {
      ...completeHeaders,
      'x-arweave-chunk-tx-id': ['first-tx-id', 'second-tx-id'],
    };
    const parsed = parseChunkHeaderMetadata(arr);
    expect(parsed).to.not.equal(null);
    expect(parsed!.txId).to.equal('first-tx-id');
  });

  it('accepts zero for chunkRelativeStartOffset (first chunk of a tx)', function () {
    const zero = {
      ...completeHeaders,
      'x-arweave-chunk-relative-start-offset': '0',
    };
    const parsed = parseChunkHeaderMetadata(zero);
    expect(parsed).to.not.equal(null);
    expect(parsed!.chunkRelativeStartOffset).to.equal(0n);
  });
});
