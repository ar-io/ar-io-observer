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

import { TESTNET_CONTRACT_SETTINGS, getEpochStart } from '../protocol.js';
import {
  EntropySource,
  GatewayHost,
  GatewayHostList,
  ObserversSource,
} from '../types.js';

export class RandomObserversSource implements ObserversSource {
  private observedGatewayHostList: GatewayHostList;
  private entropySource: EntropySource;
  private numObserversToSource: number;
  private eligibleObservers: string[];

  constructor({
    observedGatewayHostList,
    entropySource,
    numObserversToSource,
  }: {
    observedGatewayHostList: GatewayHostList;
    entropySource: EntropySource;
    numObserversToSource: number;
  }) {
    this.observedGatewayHostList = observedGatewayHostList;
    this.entropySource = entropySource;
    this.numObserversToSource = numObserversToSource;
    this.eligibleObservers = [];
  }

  async getObservers({
    startHeight,
    epochBlockLength,
    height,
  }: {
    startHeight: number;
    epochBlockLength: number;
    height: number;
  }): Promise<string[]> {
    const selectedObservers: string[] = [];
    const currentEpochStartHeight = getEpochStart({
      startHeight,
      epochBlockLength,
      height,
    });
    const usedIndexes = new Set<number>();
    const entropy = await this.entropySource.getEntropy({ height });
    const observedGatewayHosts = await this.observedGatewayHostList.getHosts();
    this.eligibleObservers = await this.getEligibleObservers(
      observedGatewayHosts,
      currentEpochStartHeight,
    );

    const eligibleObserversCount = this.eligibleObservers.length;

    // If we want to source more names than exist in the list, just return all
    if (this.numObserversToSource >= eligibleObserversCount) {
      return this.eligibleObservers;
    }

    let hash = crypto.createHash('sha256').update(entropy).digest();
    for (let i = 0; i < this.numObserversToSource; i++) {
      let index = hash.readUInt32BE(0) % eligibleObserversCount;

      while (usedIndexes.has(index)) {
        index = (index + 1) % eligibleObserversCount;
      }

      usedIndexes.add(index);
      selectedObservers.push(this.eligibleObservers[index]);

      hash = crypto.createHash('sha256').update(hash).digest();
    }

    return selectedObservers;
  }

  async getEligibleObservers(
    observedGatewayHosts: GatewayHost[],
    currentEpochStartHeight: number,
  ): Promise<string[]> {
    const eligibleObservers = [];
    for (let i = 0; i < observedGatewayHosts.length; i++) {
      const gateway = observedGatewayHosts[i];

      if (gateway.start === undefined || gateway.end === undefined) {
        // this gateway has invalid start/end date and is not eligible to be an observer
        continue;
      }
      // Check the conditions
      const isWithinStartRange = gateway.start <= currentEpochStartHeight;
      const isWithinEndRange =
        gateway.end === 0 ||
        gateway.end - TESTNET_CONTRACT_SETTINGS.gatewayLeaveLength < //TO DO: read this from the contract
          currentEpochStartHeight;

      // Keep the gateway if it meets the conditions
      if (isWithinStartRange && isWithinEndRange) {
        eligibleObservers.push(gateway.wallet);
      }
    }
    return eligibleObservers;
  }
}
