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

import { ObserverList } from '../types.js';

interface GatewayRecords {
  gateways: {
    [name: string]: unknown;
  };
}

function hasGatewayRecords(obj: unknown): obj is GatewayRecords {
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

export class RemoteCacheObserverList implements ObserverList {
  private baseCacheUrl: string;
  private contractId: string;
  private observers: string[] | undefined;

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

  async getObserversCount(height: number): Promise<number> {
    const names = await this.getAllObservers(height);
    return names.length;
  }

  async getAllObservers(height: number): Promise<string[]> {
    if (this.observers === undefined) {
      const block = await got(
        `https://arweave.net/block/height/${height}`,
      ).json<unknown>();
      if (!hasTimestamp(block)) {
        throw new Error('Unexpected block response format');
      }
      const blockTimestamp = block.timestamp;

      // TODO request the state at the given height
      const cacheUrl = `${this.baseCacheUrl}/v1/contract/${this.contractId}/gateways`;
      const resp = await got.get(cacheUrl).json<unknown>();
      if (!hasGatewayRecords(resp)) {
        throw new Error('Unexpected name records response format');
      }
      const observers = [];
      for (const [name, record] of Object.entries(resp.gateways)) {
        const anyRecord = record as any;
        // TODO remove magic number
        if (+anyRecord?.start > blockTimestamp - 50) {
          continue;
        }
        observers.push(name);
      }

      // TODO cache based on height and timestamp range
      this.observers = observers.sort();
    }

    return this.observers;
  }

  async getObserver(height: number, index: number): Promise<string> {
    return (await this.getAllObservers(height))[index];
  }
}
