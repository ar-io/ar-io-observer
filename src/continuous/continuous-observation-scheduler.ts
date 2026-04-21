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
import {
  ObservationState,
  ScheduledObservation,
  SchedulerConfig,
} from './types.js';

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
  private schedule: ScheduledObservation[] = [];

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
    schedule: ScheduledObservation[];
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

    // Schedule unique gateways only; wallet multiplicity is handled separately.
    const uniqueFqdns = [...new Set(gateways.map((gateway) => gateway.fqdn))];
    const observationAssignments = shuffleWithPRNG(
      uniqueFqdns.flatMap((fqdn) =>
        Array.from({ length: this.config.observationsPerGateway }, () => fqdn),
      ),
      rng,
    );

    // Spread every observation event across the full window.
    const slotLength =
      observationAssignments.length > 0
        ? windowLength / observationAssignments.length
        : windowLength;

    this.schedule = observationAssignments
      .map((fqdn, index) => {
        const slotStart = this.windowStart + index * slotLength;
        const jitter = rng() * slotLength * 0.8;

        return {
          id: `${fqdn}:${index}`,
          fqdn,
          scheduledAt: slotStart + jitter,
        };
      })
      .sort((left, right) => left.scheduledAt - right.scheduledAt);

    this.log.info('Epoch observation schedule initialized', {
      epochStartTimestamp,
      epochEndTimestamp,
      epochDuration,
      windowStart: this.windowStart,
      windowEnd: this.windowEnd,
      windowLength,
      gatewayCount: uniqueFqdns.length,
      observationsPerGateway: this.config.observationsPerGateway,
      totalObservations: this.schedule.length,
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
    this.schedule = [...state.pendingObservations].sort(
      (left, right) => left.scheduledAt - right.scheduledAt,
    );

    this.log.info('Scheduler state restored', {
      epochIndex: state.epochIndex,
      windowStart: this.windowStart,
      windowEnd: this.windowEnd,
      pendingGateways: new Set(this.schedule.map(({ fqdn }) => fqdn)).size,
      pendingObservations: this.schedule.length,
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
   * Get the hard deadline for submission after catch-up retries.
   */
  getSubmissionDeadline(): number {
    return this.windowEnd + this.config.submissionBufferMs;
  }

  /**
   * Get the full schedule map.
   */
  getSchedule(): ScheduledObservation[] {
    return [...this.schedule];
  }

  /**
   * Get observation events that are due at or before the current time.
   *
   * After the observation window closes, overdue events remain due so the
   * observer can catch up before finalizing the epoch.
   */
  getObservationsDue(currentTime: number): ScheduledObservation[] {
    if (currentTime < this.windowStart) {
      return [];
    }

    return this.schedule.filter(
      (observation) => observation.scheduledAt <= currentTime,
    );
  }

  /**
   * Mark an observation event as complete.
   */
  markObservationComplete(observationId: string): void {
    const index = this.schedule.findIndex(
      (observation) => observation.id === observationId,
    );
    if (index !== -1) {
      this.schedule.splice(index, 1);
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
    return this.schedule.length;
  }

  /**
   * Get the number of gateways with pending observations.
   */
  getPendingGatewayCount(): number {
    return new Set(this.schedule.map(({ fqdn }) => fqdn)).size;
  }
}
