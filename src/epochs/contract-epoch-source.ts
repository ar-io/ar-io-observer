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
import { AoIORead, IO } from '@ar.io/sdk';
import winston from 'winston';

import * as config from '../config.js';
import defaultLogger from '../log.js';
import { BlockSource, EpochTimestampParams, HeightSource } from '../types.js';
import { EpochTimestampSource as IEpochTimestampSource } from '../types.js';

export class ContractEpochSource implements IEpochTimestampSource {
  private contract: AoIORead;
  private blockSource: BlockSource;
  private heightSource: HeightSource;
  private epochParams: EpochTimestampParams | undefined;
  private log: winston.Logger;

  constructor({
    contract = IO.init({ processId: config.IO_PROCESS_ID }),
    blockSource,
    heightSource,
    log = defaultLogger,
  }: {
    contract?: AoIORead;
    blockSource: BlockSource;
    heightSource: HeightSource;
    log?: winston.Logger;
  }) {
    this.contract = contract;
    this.blockSource = blockSource;
    this.heightSource = heightSource;
    this.log = log.child({ class: 'ContractEpochSource' });
  }

  async getEpochParams(): Promise<EpochTimestampParams> {
    // cache the epoch params for the duration of the epoch to avoid unnecessary contract calls
    const height = await this.heightSource.getHeight();
    const block = await this.blockSource.getBlockByHeight(height);
    const networkTimestamp = block.timestamp * 1000;
    if (
      this.epochParams !== undefined &&
      this.epochParams.epochEndTimestamp > networkTimestamp
    ) {
      return this.epochParams;
    }
    const { startTimestamp, startHeight, endTimestamp, epochIndex } =
      await this.contract.getCurrentEpoch();

    // log the epoch params for debugging
    this.log.info('Fetched epoch params', {
      startTimestamp,
      startHeight,
      endTimestamp,
      epochIndex,
    });

    this.epochParams = {
      epochStartTimestamp: startTimestamp,
      epochStartHeight: startHeight,
      epochEndTimestamp: endTimestamp,
      epochIndex,
    };
    return this.epochParams;
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
