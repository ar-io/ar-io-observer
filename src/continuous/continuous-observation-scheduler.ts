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

import { Logger } from 'winston';

import { customHashPRNG, shuffleWithPRNG } from '../lib/prng.js';
import { EntropySource, GatewayHost } from '../types.js';
import { ObservationState, SchedulerConfig } from './types.js';

// Default configuration values
const DEFAULT_OBSERVATIONS_PER_GATEWAY = 3;
const DEFAULT_WINDOW_FRACTION = 0.5; // 50% of epoch
const DEFAULT_STABILITY_BUFFER_MS = 36 * 60 * 1000; // 36 minutes
const DEFAULT_SUBMISSION_BUFFER_MS = 72 * 60 * 1000; // 72 minutes

/**
 * Scheduler for continuous gateway observations.
 *
 * Calculates deterministic observation schedules spread across an observation
 * window within each epoch. Each observer gets a unique but deterministic
 * schedule based on composite entropy (chain + local random).
 */
export class ContinuousObservationScheduler {
  private readonly entropySource: EntropySource;
  private readonly config: SchedulerConfig;
  private readonly log: Logger;

  private windowStart: number = 0;
  private windowEnd: number = 0;
  private schedule: Map<string, number[]> = new Map();

  constructor({
    entropySource,
    config,
    log,
  }: {
    entropySource: EntropySource;
    config?: Partial<SchedulerConfig>;
    log: Logger;
  }) {
    this.entropySource = entropySource;
    this.config = {
      observationsPerGateway:
        config?.observationsPerGateway ?? DEFAULT_OBSERVATIONS_PER_GATEWAY,
      windowFraction: config?.windowFraction ?? DEFAULT_WINDOW_FRACTION,
      stabilityBufferMs:
        config?.stabilityBufferMs ?? DEFAULT_STABILITY_BUFFER_MS,
      submissionBufferMs:
        config?.submissionBufferMs ?? DEFAULT_SUBMISSION_BUFFER_MS,
    };
    this.log = log.child({ class: 'ContinuousObservationScheduler' });
  }

  /**
   * Initialize the scheduler for a new epoch.
   *
   * Calculates the observation window and schedules observation times
   * for each gateway based on deterministic entropy.
   */
  async initializeEpoch({
    gateways,
    epochStartTimestamp,
    epochEndTimestamp,
    epochStartHeight,
  }: {
    gateways: GatewayHost[];
    epochStartTimestamp: number;
    epochEndTimestamp: number;
    epochStartHeight: number;
  }): Promise<{
    windowStart: number;
    windowEnd: number;
    schedule: Map<string, number[]>;
  }> {
    const epochDuration = epochEndTimestamp - epochStartTimestamp;
    const windowLength = epochDuration * this.config.windowFraction;

    // Calculate valid range for window starts
    const earliestStart = epochStartTimestamp + this.config.stabilityBufferMs;
    const latestEnd = epochEndTimestamp - this.config.submissionBufferMs;
    const availableStartRange = latestEnd - windowLength - earliestStart;

    if (availableStartRange <= 0) {
      throw new Error(
        `Epoch duration too short for configured buffers and window fraction. ` +
          `epochDuration=${epochDuration}ms, windowLength=${windowLength}ms, ` +
          `stabilityBuffer=${this.config.stabilityBufferMs}ms, submissionBuffer=${this.config.submissionBufferMs}ms`,
      );
    }

    // Get composite entropy (chain + local random = observer-unique but deterministic)
    const entropy = await this.entropySource.getEntropy({
      height: epochStartHeight,
    });
    const rng = customHashPRNG(entropy);

    // Calculate this observer's window start offset
    const startOffset = rng() * availableStartRange;
    this.windowStart = earliestStart + startOffset;
    this.windowEnd = this.windowStart + windowLength;

    // Shuffle gateways deterministically
    const shuffledGateways = shuffleWithPRNG(gateways, rng);

    // Schedule observations for each gateway
    this.schedule = new Map();
    const slotLength = windowLength / this.config.observationsPerGateway;

    for (const gateway of shuffledGateways) {
      const times: number[] = [];

      for (let i = 0; i < this.config.observationsPerGateway; i++) {
        const slotStart = this.windowStart + i * slotLength;
        // Use 80% of slot for jitter to avoid observations bunching at slot boundaries
        const jitter = rng() * slotLength * 0.8;
        times.push(slotStart + jitter);
      }

      // Sort times to ensure they're in chronological order
      this.schedule.set(
        gateway.fqdn,
        times.sort((a, b) => a - b),
      );
    }

    this.log.info('Epoch observation schedule initialized', {
      epochStartTimestamp,
      epochEndTimestamp,
      epochDuration,
      windowStart: this.windowStart,
      windowEnd: this.windowEnd,
      windowLength,
      gatewayCount: gateways.length,
      observationsPerGateway: this.config.observationsPerGateway,
      totalObservations: gateways.length * this.config.observationsPerGateway,
    });

    return {
      windowStart: this.windowStart,
      windowEnd: this.windowEnd,
      schedule: this.schedule,
    };
  }

  /**
   * Restore scheduler state from persisted observation state.
   */
  restoreFromState(state: ObservationState): void {
    this.windowStart = state.windowStart;
    this.windowEnd = state.windowEnd;
    this.schedule = new Map(state.pendingObservations);

    this.log.info('Scheduler state restored', {
      epochIndex: state.epochIndex,
      windowStart: this.windowStart,
      windowEnd: this.windowEnd,
      pendingGateways: this.schedule.size,
      pendingObservations: Array.from(this.schedule.values()).reduce(
        (sum, times) => sum + times.length,
        0,
      ),
    });
  }

  /**
   * Get the window start timestamp.
   */
  getWindowStart(): number {
    return this.windowStart;
  }

  /**
   * Get the window end timestamp.
   */
  getWindowEnd(): number {
    return this.windowEnd;
  }

  /**
   * Get the full schedule map.
   */
  getSchedule(): Map<string, number[]> {
    return this.schedule;
  }

  /**
   * Get gateways that have observations due at or before the current time.
   *
   * Returns gateways with at least one scheduled observation time that has passed.
   * This handles catch-up after observer downtime.
   */
  getGatewaysDue(currentTime: number): string[] {
    if (currentTime < this.windowStart || currentTime > this.windowEnd) {
      return [];
    }

    const due: string[] = [];
    for (const [fqdn, times] of this.schedule) {
      // Find any scheduled time that has passed
      const overdueTime = times.find((t) => t <= currentTime);
      if (overdueTime !== undefined) {
        due.push(fqdn);
      }
    }
    return due;
  }

  /**
   * Mark an observation as complete for a gateway.
   *
   * Removes the earliest due observation time from the schedule.
   */
  markObservationComplete(fqdn: string, completedAt: number): void {
    const times = this.schedule.get(fqdn);
    if (times) {
      // Remove the first time that's at or before completedAt
      const idx = times.findIndex((t) => t <= completedAt);
      if (idx !== -1) {
        times.splice(idx, 1);
      }

      // If no more observations for this gateway, remove from schedule
      if (times.length === 0) {
        this.schedule.delete(fqdn);
      }
    }
  }

  /**
   * Check if the observation window has completed.
   */
  isWindowComplete(currentTime: number): boolean {
    return currentTime >= this.windowEnd;
  }

  /**
   * Check if we're still before the observation window.
   */
  isBeforeWindow(currentTime: number): boolean {
    return currentTime < this.windowStart;
  }

  /**
   * Get the number of pending observations across all gateways.
   */
  getPendingObservationCount(): number {
    return Array.from(this.schedule.values()).reduce(
      (sum, times) => sum + times.length,
      0,
    );
  }

  /**
   * Get the number of gateways with pending observations.
   */
  getPendingGatewayCount(): number {
    return this.schedule.size;
  }
}
