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

import { AVERAGE_BLOCK_TIME } from '../arweave.js';
import { ArnsNameList } from '../types.js';

interface NameRecords {
  records: {
    [name: string]: unknown;
  };
}

function hasNameRecords(obj: unknown): obj is NameRecords {
  if (!(typeof obj === 'object')) {
    return false;
  }

  if (obj === null) {
    return false;
  }

  if (!('records' in obj)) {
    return false;
  }

  if ((typeof obj['records'] as any) !== 'object') {
    return false;
  }

  return true;
}

interface TimeStamped {
  timestamp: number;
}

function hasTimestamp(obj: unknown): obj is TimeStamped {
  if (!(typeof obj === 'object')) {
    return false;
  }

  if (obj === null) {
    return false;
  }

  if (!('timestamp' in obj)) {
    return false;
  }

  if ((typeof obj['timestamp'] as any) !== 'number') {
    return false;
  }

  return true;
}

export class RemoteCacheArnsNameList implements ArnsNameList {
  private baseCacheUrl: string;
  private contractId: string;
  private names: string[] | undefined;

  constructor({
    baseCacheUrl,
    contractId,
  }: {
    baseCacheUrl: string;
    contractId: string;
  }) {
    this.baseCacheUrl = baseCacheUrl;
    this.contractId = contractId;
  }

  async getNamesCount(height: number): Promise<number> {
    const names = await this.getAllNames(height);
    return names.length;
  }

  async getAllNames(height: number): Promise<string[]> {
    if (this.names === undefined) {
      const block = await got(
        `https://arweave.net/block/height/${height}`,
      ).json<unknown>();
      if (!hasTimestamp(block)) {
        throw new Error('Unexpected block response format');
      }
      const blockTimestamp = block.timestamp;

      // TODO request the state at the given height
      const cacheUrl = `${this.baseCacheUrl}/v1/contract/${this.contractId}/records`;
      const resp = await got.get(cacheUrl).json<unknown>();
      if (!hasNameRecords(resp)) {
        throw new Error('Unexpected name records response format');
      }
      const names = [];
      for (const [name, record] of Object.entries(resp.records)) {
        const anyRecord = record as any;
        // TODO remove magic number
        if (
          +anyRecord?.startTimestamp >
          blockTimestamp - AVERAGE_BLOCK_TIME * 50
        ) {
          continue;
        }
        // TODO remove magic number
        if (
          +anyRecord?.endTimestamp <
          blockTimestamp + AVERAGE_BLOCK_TIME * 6000
        ) {
          continue;
        }
        names.push(name);
      }

      // TODO cache based on height and timestamp range
      this.names = names.sort();
    }

    return this.names;
  }

  async getName(height: number, index: number): Promise<string> {
    return (await this.getAllNames(height))[index];
  }
}
