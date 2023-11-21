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

import { HeightSource } from './types.js';

export const AVERAGE_BLOCK_TIME = 120;
export const MAX_FORK_DEPTH = 50;

export class FixedHeightSource implements HeightSource {
  private height: number;

  constructor({ height }: { height: number }) {
    this.height = height;
  }

  async getHeight(): Promise<number> {
    return this.height;
  }
}

export class ChainSource implements HeightSource {
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
}
