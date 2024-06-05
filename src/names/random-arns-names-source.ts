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

import { ArnsNameList, ArnsNamesSource, EntropySource } from '../types.js';

export class RandomArnsNamesSource implements ArnsNamesSource {
  private nameList: ArnsNameList;
  private entropySource: EntropySource;
  private numNamesToSource: number;

  constructor({
    nameList,
    entropySource,
    numNamesToSource,
  }: {
    nameList: ArnsNameList;
    entropySource: EntropySource;
    numNamesToSource: number;
  }) {
    this.nameList = nameList;
    this.entropySource = entropySource;
    this.numNamesToSource = numNamesToSource;
  }

  async getPrescribedNames({ height }: { height: number }): Promise<string[]> {
    const selectedNames: string[] = [];
    const usedIndexes = new Set<number>();
    const entropy = await this.entropySource.getEntropy({ height });
    const namesCount = await this.nameList.getNamesCount(height);

    // If we want to source more names than exist in the list, just return all
    if (this.numNamesToSource >= namesCount) {
      return this.nameList.getAllNames(height);
    }

    let hash = crypto.createHash('sha256').update(entropy).digest();
    for (let i = 0; i < this.numNamesToSource; i++) {
      let index = hash.readUInt32BE(0) % namesCount;

      while (usedIndexes.has(index)) {
        index = (index + 1) % namesCount;
      }

      usedIndexes.add(index);
      selectedNames.push(await this.nameList.getName(height, index));

      hash = crypto.createHash('sha256').update(hash).digest();
    }

    return selectedNames;
  }
}
