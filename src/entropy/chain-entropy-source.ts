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

import { EntropySource, HeightSource } from '../types.js';

export class ChainEntropySource implements EntropySource {
  private arweaveBaseUrl: string;
  private heightSource: HeightSource;

  constructor({
    arweaveBaseUrl,
    heightSource,
  }: {
    arweaveBaseUrl: string;
    heightSource: HeightSource;
  }) {
    this.arweaveBaseUrl = arweaveBaseUrl;
    this.heightSource = heightSource;
  }

  async getEntropy(): Promise<Buffer> {
    const hash = crypto.createHash('sha256');
    const height = await this.heightSource.getHeight();
    // We hash 5 block hashes to reduce the chance that someone will influence
    // the value produced by grinding block hashes.
    for (let i = 0; i < 5; i++) {
      const url = `${this.arweaveBaseUrl}/block/height/${height - i}`;
      const block = (await got(url).json()) as any; // TODO fix any
      if (!block.indep_hash || typeof block.indep_hash !== 'string') {
        throw new Error(`Block ${height - i} has no indep_hash`);
      }
      hash.update(Buffer.from(block.indep_hash, 'base64url'));
    }
    return hash.digest();
  }
}
