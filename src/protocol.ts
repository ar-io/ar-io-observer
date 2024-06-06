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
import {
  HeightSource,
  EpochHeightSource as IEpochHeightSource,
  EpochTimestampSource as IEpochTimestampSource,
} from './types.js';

export const START_HEIGHT = 0;
export const START_TIMESTAMP = 0;
export const EPOCH_BLOCK_LENGTH_MS = 60 * 1000 * 60 * 24; // 1 day
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

interface EpochTimestampParams {
  epochStartTimestamp: number;
  epochStartHeight: number;
  epochEndTimestamp: number;
  epochIndex: number;
}

export class EpochHeightSource implements IEpochHeightSource {
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

  async getEpochStartHeight(): Promise<number> {
    const height = await this.heightSource.getHeight();
    return getEpochStart({
      ...this.epochParams,
      height,
    });
  }

  async getEpochEndHeight(): Promise<number> {
    const height = await this.heightSource.getHeight();
    return getEpochEnd({
      ...this.epochParams,
      height,
    });
  }
}

export class EpochTimestampSource implements IEpochTimestampSource {
  private epochParams: EpochTimestampParams;

  constructor({
    epochParams = {
      epochStartTimestamp: 0,
      epochEndTimestamp: 1000 * 60 * 60 * 24, // 1 day
      epochStartHeight: 0,
      epochIndex: 0,
    },
  }: {
    epochParams?: EpochTimestampParams;
    heightSource: HeightSource;
  }) {
    this.epochParams = epochParams;
  }

  async getEpochStartTimestamp(): Promise<number> {
    return this.epochParams.epochStartTimestamp;
  }

  async getEpochEndTimestamp(): Promise<number> {
    return this.epochParams.epochEndTimestamp;
  }

  async getEpochStartHeight(): Promise<number> {
    return this.epochParams.epochStartHeight;
  }

  async getEpochIndex(): Promise<number> {
    return this.epochParams.epochIndex;
  }
}
