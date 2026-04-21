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

import fs from 'node:fs';
import path from 'node:path';
import { Logger } from 'winston';

import { ObservationState, SerializedObservationState } from './types.js';

/**
 * Interface for persisting observation state
 */
export interface ObservationStateStore {
  save(state: ObservationState): Promise<void>;
  load(): Promise<ObservationState | null>;
  clear(): Promise<void>;
}

/**
 * Filesystem-based observation state store with atomic writes
 */
export class FsObservationStateStore implements ObservationStateStore {
  private readonly statePath: string;
  private readonly log: Logger;

  constructor({
    statePath = './data/observer/observation-state.json',
    log,
  }: {
    statePath?: string;
    log: Logger;
  }) {
    this.statePath = statePath;
    this.log = log.child({ class: 'FsObservationStateStore' });
  }

  async save(state: ObservationState): Promise<void> {
    const serialized: SerializedObservationState = {
      epochIndex: state.epochIndex,
      epochStartTimestamp: state.epochStartTimestamp,
      epochEndTimestamp: state.epochEndTimestamp,
      epochStartHeight: state.epochStartHeight,
      windowStart: state.windowStart,
      windowEnd: state.windowEnd,
      pendingObservations: state.pendingObservations,
      gatewayObservations: Array.from(state.gatewayObservations.entries()),
      gatewayWallets: Array.from(state.gatewayWallets.entries()),
      offsetAssessmentGateways: Array.from(state.offsetAssessmentGateways),
      lastCycleTimestamp: state.lastCycleTimestamp,
      reportSubmitted: state.reportSubmitted,
    };

    // Atomic write: write to temp file then rename
    const tempPath = `${this.statePath}.tmp`;
    await fs.promises.mkdir(path.dirname(this.statePath), { recursive: true });
    await fs.promises.writeFile(tempPath, JSON.stringify(serialized, null, 2));
    await fs.promises.rename(tempPath, this.statePath);

    this.log.debug('Observation state saved', {
      epochIndex: state.epochIndex,
      gatewayCount: state.gatewayObservations.size,
      pendingCount: state.pendingObservations.length,
    });
  }

  async load(): Promise<ObservationState | null> {
    try {
      const data = await fs.promises.readFile(this.statePath, 'utf-8');
      const parsed: SerializedObservationState = JSON.parse(data);

      const state: ObservationState = {
        epochIndex: parsed.epochIndex,
        epochStartTimestamp: parsed.epochStartTimestamp,
        epochEndTimestamp: parsed.epochEndTimestamp,
        epochStartHeight: parsed.epochStartHeight,
        windowStart: parsed.windowStart,
        windowEnd: parsed.windowEnd,
        pendingObservations: parsed.pendingObservations,
        gatewayObservations: new Map(parsed.gatewayObservations),
        gatewayWallets: new Map(parsed.gatewayWallets),
        offsetAssessmentGateways: new Set(parsed.offsetAssessmentGateways),
        lastCycleTimestamp: parsed.lastCycleTimestamp,
        reportSubmitted: parsed.reportSubmitted,
      };

      this.log.debug('Observation state loaded', {
        epochIndex: state.epochIndex,
        gatewayCount: state.gatewayObservations.size,
      });

      return state;
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        this.log.debug('No observation state file found');
        return null;
      }
      this.log.error('Failed to load observation state', {
        error: error.message,
      });
      return null;
    }
  }

  async clear(): Promise<void> {
    try {
      await fs.promises.unlink(this.statePath);
      this.log.debug('Observation state cleared');
    } catch (error: any) {
      if (error.code !== 'ENOENT') {
        this.log.error('Failed to clear observation state', {
          error: error.message,
        });
      }
    }
  }
}
