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

import { BlockSource, HeightSource } from './types.js';

export const AVERAGE_BLOCK_TIME_SECS = 120;
export const AVERAGE_BLOCK_TIME_MS = AVERAGE_BLOCK_TIME_SECS * 1000;
export const MAX_FORK_DEPTH = 50;

export class FixedHeightSource implements HeightSource {
  private height: number;

  constructor({ height }: { height: number }) {
    this.height = height;
  }

  async getHeight(): Promise<number> {
    return this.height;
  }

  async getHeightAtTimestamp(_timestamp: number): Promise<number> {
    return this.height;
  }
}

export class ChainSource implements HeightSource, BlockSource {
  private arweaveBaseUrl: string;

  constructor({ arweaveBaseUrl }: { arweaveBaseUrl: string }) {
    this.arweaveBaseUrl = arweaveBaseUrl;
  }

  async getHeight(): Promise<number> {
    const url = `${this.arweaveBaseUrl}/height`;
    const resp = await got(url);
    const height = parseInt(resp.body);
    if (isNaN(height)) {
      throw new Error(`Invalid height: ${resp.body}`);
    }
    return height;
  }

  async getBlockByHeight(height: number): Promise<any> {
    const url = `${this.arweaveBaseUrl}/block/height/${height}`;
    const resp = await got(url);
    const block = JSON.parse(resp.body);
    return block;
  }

  // copy/pasta from irys/arbundles
  async getHeightAtTimestamp(reqTimestamp: number): Promise<number> {
    const currentHeight = await this.getHeight();
    const avgBlockTime = 2 * 60 * 1000;
    const estimateHeightDelta = Math.ceil(
      (Date.now() - reqTimestamp) / avgBlockTime,
    );
    const estimateHeight = currentHeight - estimateHeightDelta;
    // Get blocks from around the estimate
    const height = estimateHeight;

    let wobble = 0;
    let closestDelta = Infinity;
    let closestHeight = 0;
    let twoClosest = 0; // Below will flip flop between two values at minimum

    for (let i = 0; i < 30; i++) {
      const testHeight = height + wobble;
      const timestamp = await this.getBlockByHeight(testHeight);
      const cDelta = timestamp - reqTimestamp;
      if (cDelta === twoClosest) break;
      if (i % 2 === 0) twoClosest = cDelta;
      if (Math.abs(cDelta) > 20 * 60 * 1000) {
        wobble += Math.floor((cDelta / avgBlockTime) * 0.75) * -1;
      } else {
        wobble += cDelta > 0 ? -1 : 1;
      }
      if (Math.abs(cDelta) < Math.abs(closestDelta)) {
        closestDelta = cDelta;
        closestHeight = testHeight;
      }
    }

    return closestHeight;
  }
}
