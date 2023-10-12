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
import { HeightSource } from './types.js';

export const START_HEIGHT = 0;
export const EPOCH_BLOCK_LENGTH = 5000;
export const TESTNET_CONTRACT_SETTINGS = {
  minLockLength: 5,
  maxLockLength: 720 * 365 * 3,
  minNetworkJoinStakeAmount: 5_000,
  minGatewayJoinLength: 2,
  gatewayLeaveLength: 2,
  operatorStakeWithdrawLength: 5,
};

export function getEpochEnd({
  startHeight,
  epochBlockLength,
  height,
}: {
  startHeight: number;
  epochBlockLength: number;
  height: number;
}): number {
  return (
    startHeight +
    epochBlockLength *
      (Math.floor((height - startHeight) / epochBlockLength) + 1) -
    1
  );
}

export function getEpochStart({
  startHeight,
  epochBlockLength,
  height,
}: {
  startHeight: number;
  epochBlockLength: number;
  height: number;
}): number {
  return (
    getEpochEnd({ startHeight, epochBlockLength, height }) +
    1 -
    epochBlockLength
  );
}

interface EpochParams {
  startHeight: number;
  epochBlockLength: number;
}

export class EpochHeightSource implements HeightSource {
  private heightSource: HeightSource;
  private epochParams: EpochParams;

  constructor({
    epochParams = {
      startHeight: START_HEIGHT,
      epochBlockLength: EPOCH_BLOCK_LENGTH,
    },
    heightSource,
  }: {
    epochParams?: EpochParams;
    heightSource: HeightSource;
  }) {
    this.heightSource = heightSource;
    this.epochParams = epochParams;
  }

  async getHeight(): Promise<number> {
    const height = await this.heightSource.getHeight();
    return getEpochStart({
      ...this.epochParams,
      height,
    });
  }
}
