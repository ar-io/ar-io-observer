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
import crypto from 'node:crypto';

import { EntropySource, ObserverList, ObserversSource } from '../types.js';

export class RandomObserversSource implements ObserversSource {
  private observerList: ObserverList;
  private entropySource: EntropySource;
  private numObserversToSource: number;

  constructor({
    observerList,
    entropySource,
    numObserversToSource,
  }: {
    observerList: ObserverList;
    entropySource: EntropySource;
    numObserversToSource: number;
  }) {
    this.observerList = observerList;
    this.entropySource = entropySource;
    this.numObserversToSource = numObserversToSource;
  }

  async getObservers({ height }: { height: number }): Promise<string[]> {
    const selectedObservers: string[] = [];
    const usedIndexes = new Set<number>();
    const entropy = await this.entropySource.getEntropy({ height });
    const observersCount = await this.observerList.getObserversCount(height);

    // If we want to source more names than exist in the list, just return all
    if (this.numObserversToSource >= observersCount) {
      return this.observerList.getAllObservers(height);
    }

    let hash = crypto.createHash('sha256').update(entropy).digest();
    for (let i = 0; i < this.numObserversToSource; i++) {
      let index = hash.readUInt32BE(0) % observersCount;

      while (usedIndexes.has(index)) {
        index = (index + 1) % observersCount;
      }

      usedIndexes.add(index);
      selectedObservers.push(
        await this.observerList.getObserver(height, index),
      );

      hash = crypto.createHash('sha256').update(hash).digest();
    }

    return selectedObservers;
  }
}
