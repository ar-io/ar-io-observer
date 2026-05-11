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
  // On a live cranker-driven cluster, transient "epoch N not found"
  // errors are EXPECTED in two cases:
  //   1. We just closed epoch N-1; current_epoch_index advanced to N
  //      but Epoch[N] PDA hasn't been created yet (race between
  //      close_epoch and create_epoch txs landing).
  //   2. Fast-epoch devnets where the lookahead reader can poll while
  //      the cranker is mid-cycle.
  // Both resolve within seconds-to-minutes. The legacy 3-retry, 5min-
  // delay policy escalated these to fatal errors after ~15min, killing
  // the service. We now use much shorter delays + a much larger ceiling
  // (~30min worst case) so transient states never tip the process.
  private static readonly CURRENT_EPOCH_MAX_RETRIES = 60;
  private static readonly CURRENT_EPOCH_RETRY_DELAY_MS = 30 * 1000;
  /** Regex matching transient "next epoch not yet created" errors that
   *  resolve on their own. We log these at info level (vs warn) so they
   *  don't blow up an operator's alerting. */
  private static readonly TRANSIENT_ERROR_PATTERNS = [
    /Epoch \d+ not found/i,
    /EpochSettings not found/i,
    /Account does not exist/i,
  ];

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

  private isTransientEpochError(message: string): boolean {
    return ContractEpochSource.TRANSIENT_ERROR_PATTERNS.some((p) =>
      p.test(message),
    );
  }

  private async getCurrentEpochWithRetry(attempt = 1): Promise<any> {
    try {
      return await this.contract.getCurrentEpoch();
    } catch (error: any) {
      const transient = this.isTransientEpochError(error.message ?? '');
      if (attempt >= ContractEpochSource.CURRENT_EPOCH_MAX_RETRIES) {
        throw error;
      }
      // Transient errors get info-level logging (expected on live
      // clusters during epoch boundaries). Non-transient errors keep
      // the warn-level escalation so real failures are visible.
      const logFn = transient ? this.log.info : this.log.warn;
      logFn.call(this.log, 'Failed to get current epoch. Retrying...', {
        attempt: attempt,
        maxRetries: ContractEpochSource.CURRENT_EPOCH_MAX_RETRIES,
        retryDelayMs: ContractEpochSource.CURRENT_EPOCH_RETRY_DELAY_MS,
        transient,
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

      // if they are undefined, we are either before the first epoch or received a bad response from the CU
      if (
        startTimestamp === undefined &&
        startHeight === undefined &&
        endTimestamp === undefined &&
        epochIndex === undefined
      ) {
        this.log.error('No epoch data available', { currentEpoch });
        throw new Error('No epoch data available');
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
