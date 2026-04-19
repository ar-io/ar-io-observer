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

import { ChunkHeaderMetadata } from '../types.js';
import {
  ChainAnchorMismatchError,
  anchorChunkMetadata,
} from './chunk-metadata-anchor.js';

const txId = 'T3DcnZlZg_FqOQUf9MSZXQ5j7_ETc04OEqbkX-MZRnc';
const dataRoot = 'qoQEdVyTqjLpkybZAgkIgtNawXUHUd5TJZwkWx0Vo-A';

const txStartOffset = 108631448658167n;
const txDataSize = 42724169n;
const txEndOffset = txStartOffset + txDataSize - 1n;
const sampleOffset = 108631449706743;

const headerMetadata: ChunkHeaderMetadata = {
  txId,
  txStartOffset,
  txDataSize,
  dataRoot,
  dataPath: 'ignored',
  txPath: 'ignored',
  chunkStartOffset: 108631449706743n,
  chunkRelativeStartOffset: 1048576n,
};

const matchingChainOffset = {
  size: txDataSize.toString(),
  offset: txEndOffset.toString(),
};

describe('anchorChunkMetadata', function () {
  it('returns chain-anchored bounds and decodes dataRoot when everything matches', async function () {
    let txFetchCount = 0;
    const result = await anchorChunkMetadata({
      headerMetadata,
      offset: sampleOffset,
      fetchTxOffset: async () => matchingChainOffset,
      fetchTransaction: async () => {
        txFetchCount += 1;
        return { data_root: dataRoot };
      },
    });

    expect(txFetchCount).to.equal(1);
    expect(result.txId).to.equal(txId);
    expect(result.txStartOffset).to.equal(Number(txStartOffset));
    expect(result.txEndOffset).to.equal(Number(txEndOffset));
    expect(result.dataRoot.length).to.be.greaterThan(0);
  });

  it('skips the /tx fetch when anchorDataRoot is false', async function () {
    let txFetchCount = 0;
    await anchorChunkMetadata({
      headerMetadata,
      offset: sampleOffset,
      fetchTxOffset: async () => matchingChainOffset,
      fetchTransaction: async () => {
        txFetchCount += 1;
        return { data_root: dataRoot };
      },
      anchorDataRoot: false,
    });

    expect(txFetchCount).to.equal(0);
  });

  it('throws when chain-reported size disagrees with header', async function () {
    try {
      await anchorChunkMetadata({
        headerMetadata,
        offset: sampleOffset,
        fetchTxOffset: async () => ({
          size: (txDataSize + 1n).toString(),
          offset: (txEndOffset + 1n).toString(),
        }),
        fetchTransaction: async () => ({ data_root: dataRoot }),
      });
      expect.fail('Expected ChainAnchorMismatchError');
    } catch (error: any) {
      expect(error).to.be.instanceOf(ChainAnchorMismatchError);
      expect(error.field).to.equal('txDataSize');
    }
  });

  it('throws when chain-derived start offset disagrees with header', async function () {
    try {
      await anchorChunkMetadata({
        headerMetadata,
        offset: sampleOffset,
        // Keep size the same, shift the end offset: start no longer matches.
        fetchTxOffset: async () => ({
          size: txDataSize.toString(),
          offset: (txEndOffset + 100n).toString(),
        }),
        fetchTransaction: async () => ({ data_root: dataRoot }),
      });
      expect.fail('Expected ChainAnchorMismatchError');
    } catch (error: any) {
      expect(error).to.be.instanceOf(ChainAnchorMismatchError);
      expect(error.field).to.equal('txStartOffset');
    }
  });

  it('throws when the probed offset is outside the chain-derived tx range', async function () {
    try {
      await anchorChunkMetadata({
        headerMetadata,
        offset: Number(txEndOffset + 1n),
        fetchTxOffset: async () => matchingChainOffset,
        fetchTransaction: async () => ({ data_root: dataRoot }),
      });
      expect.fail('Expected ChainAnchorMismatchError');
    } catch (error: any) {
      expect(error).to.be.instanceOf(ChainAnchorMismatchError);
      expect(error.field).to.equal('offsetInRange');
    }
  });

  it('throws when chain data_root disagrees with header and anchorDataRoot is on', async function () {
    try {
      await anchorChunkMetadata({
        headerMetadata,
        offset: sampleOffset,
        fetchTxOffset: async () => matchingChainOffset,
        fetchTransaction: async () => ({
          data_root: 'DIFFERENT-DATA-ROOT',
        }),
      });
      expect.fail('Expected ChainAnchorMismatchError');
    } catch (error: any) {
      expect(error).to.be.instanceOf(ChainAnchorMismatchError);
      expect(error.field).to.equal('dataRoot');
    }
  });

  it('requires fetchTransaction when anchorDataRoot is on', async function () {
    try {
      await anchorChunkMetadata({
        headerMetadata,
        offset: sampleOffset,
        fetchTxOffset: async () => matchingChainOffset,
      });
      expect.fail('Expected error about missing fetchTransaction');
    } catch (error: any) {
      expect(error.message).to.include('fetchTransaction');
    }
  });
});
