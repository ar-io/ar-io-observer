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
import got from 'got';
import crypto from 'node:crypto';

import { EntropySource } from '../types.js';

const DEFAULT_NUM_SAMPLED_BLOCKS = 3;
const DEFAULT_SAMPLED_BLOCKS_OFFSET = 50;

export class ChainEntropySource implements EntropySource {
  private arweaveBaseUrl: string;
  private numSampledBlocks: number;
  private sampledBlocksOffset: number;

  constructor({
    arweaveBaseUrl,
    numSampledBlocks = DEFAULT_NUM_SAMPLED_BLOCKS,
    sampledBlocksOffset = DEFAULT_SAMPLED_BLOCKS_OFFSET,
  }: {
    arweaveBaseUrl: string;
    numSampledBlocks?: number;
    sampledBlocksOffset?: number;
  }) {
    this.arweaveBaseUrl = arweaveBaseUrl;
    this.numSampledBlocks = numSampledBlocks;
    this.sampledBlocksOffset = sampledBlocksOffset;
  }

  async getEntropy({ height }: { height: number }): Promise<Buffer> {
    const hash = crypto.createHash('sha256');
    // We hash multiples block hashes to reduce the chance that someone will
    // influence the value produced by grinding with excessive hash power.
    for (let i = 0; i < this.numSampledBlocks; i++) {
      const url = `${this.arweaveBaseUrl}/block/height/${
        height - this.sampledBlocksOffset - i
      }`;
      const block = (await got(url).json()) as any; // TODO fix any
      if (!block.indep_hash || typeof block.indep_hash !== 'string') {
        throw new Error(`Block ${height - i} has no indep_hash`);
      }
      hash.update(Buffer.from(block.indep_hash, 'base64url'));
    }
    return hash.digest();
  }
}
