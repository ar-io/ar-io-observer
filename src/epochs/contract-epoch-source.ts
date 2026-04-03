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
import { ARIO, AoARIORead } from '@ar.io/sdk/node';
import winston from 'winston';

import * as config from '../config.js';
import defaultLogger from '../log.js';
import {
  BlockSource,
  EpochSettings,
  EpochTimestampParams,
  HeightSource,
} from '../types.js';
import { EpochTimestampSource as IEpochTimestampSource } from '../types.js';

export class ContractEpochSource implements IEpochTimestampSource {
  private static readonly CURRENT_EPOCH_MAX_RETRIES = 3;
  private static readonly CURRENT_EPOCH_RETRY_DELAY_MS = 5 * 60 * 1000;

  private contract: AoARIORead;
  private blockSource: BlockSource;
  private heightSource: HeightSource;
  private epochParams: EpochTimestampParams | undefined;
  private log: winston.Logger;

  constructor({
    contract = ARIO.init({ processId: config.IO_PROCESS_ID }),
    blockSource,
    heightSource,
    log = defaultLogger,
  }: {
    contract?: AoARIORead;
    blockSource: BlockSource;
    heightSource: HeightSource;
    log?: winston.Logger;
  }) {
    this.contract = contract;
    this.blockSource = blockSource;
    this.heightSource = heightSource;
    this.log = log.child({ class: 'ContractEpochSource' });
  }

  private async delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async getCurrentEpochWithRetry(attempt = 1): Promise<any> {
    try {
      return await this.contract.getCurrentEpoch();
    } catch (error: any) {
      if (attempt >= ContractEpochSource.CURRENT_EPOCH_MAX_RETRIES) {
        throw error;
      }

      this.log.warn('Failed to get current epoch. Retrying...', {
        attempt: attempt,
        maxRetries: ContractEpochSource.CURRENT_EPOCH_MAX_RETRIES,
        retryDelayMs: ContractEpochSource.CURRENT_EPOCH_RETRY_DELAY_MS,
        error: error.message,
      });

      await this.delay(ContractEpochSource.CURRENT_EPOCH_RETRY_DELAY_MS);
      return this.getCurrentEpochWithRetry(attempt + 1);
    }
  }

  async getEpochSettings(): Promise<EpochSettings> {
    const epochSettings = await this.contract.getEpochSettings();
    return {
      epochZeroStartTimestamp: epochSettings.epochZeroStartTimestamp,
      durationMs: epochSettings.durationMs,
    };
  }

  async getEpochParams(): Promise<EpochTimestampParams> {
    let networkTimestamp: number | undefined = undefined;
    try {
      // cache the epoch params for the duration of the epoch to avoid unnecessary contract calls
      // TODO: check the epochs have started, requires type change on this interface
      const height = await this.heightSource.getHeight();
      const block = await this.blockSource.getBlockByHeight(height);
      networkTimestamp = block.timestamp * 1000;
      if (
        this.epochParams !== undefined &&
        this.epochParams.epochEndTimestamp > networkTimestamp
      ) {
        return this.epochParams;
      }

      const currentEpoch = await this.getCurrentEpochWithRetry();
      const startTimestamp = currentEpoch?.startTimestamp;
      const startHeight = currentEpoch?.startHeight;
      const endTimestamp = currentEpoch?.endTimestamp;
      const epochIndex = currentEpoch?.epochIndex;

      // if they are undefined, we are before the first epoch
      if (
        startTimestamp === undefined &&
        startHeight === undefined &&
        endTimestamp === undefined &&
        epochIndex === undefined
      ) {
        this.log.verbose('No epoch data available');
        return {
          epochStartTimestamp: startTimestamp,
          epochStartHeight: startHeight,
          epochEndTimestamp: endTimestamp,
          epochIndex: epochIndex,
        };
      }

      this.log.verbose('Setting epoch params.', {
        startTimestamp: startTimestamp,
        startHeight: startHeight,
        endTimestamp: endTimestamp,
        epochIndex: epochIndex,
      });
      this.epochParams = {
        epochStartTimestamp: startTimestamp,
        epochStartHeight: startHeight,
        epochEndTimestamp: endTimestamp,
        epochIndex: epochIndex,
      };
      return this.epochParams;
    } catch (error: any) {
      this.log.error('Failed to get epoch params.', {
        error: error.message,
      });

      if (
        networkTimestamp !== undefined &&
        this.epochParams !== undefined &&
        this.epochParams.epochStartTimestamp > networkTimestamp
      ) {
        this.log.warn(
          'Using cached epoch params after getEpochParams failure.',
        );
        return this.epochParams;
      }

      throw error;
    }
  }

  async getEpochStartTimestamp(): Promise<number> {
    return this.getEpochParams().then((params) => params.epochStartTimestamp);
  }

  async getEpochEndTimestamp(): Promise<number> {
    return this.getEpochParams().then((params) => params.epochEndTimestamp);
  }

  async getEpochStartHeight(): Promise<number> {
    return this.getEpochParams().then((params) => params.epochStartHeight);
  }

  async getEpochIndex(): Promise<number> {
    return this.getEpochParams().then((params) => params.epochIndex);
  }
}
