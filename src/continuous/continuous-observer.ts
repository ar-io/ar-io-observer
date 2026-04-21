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

import pMap from 'p-map';
import { Logger } from 'winston';

import { GatewayAssessor } from '../assessment/gateway-assessor.js';
import * as metrics from '../metrics.js';
import { REPORT_FORMAT_VERSION } from '../observer.js';
import {
  ArnsNamesSource,
  EntropySource,
  EpochTimestampSource,
  GatewayAssessments,
  GatewayHostsSource,
  ObserverReport,
  ReferenceGatewaySource,
  ReportSink,
} from '../types.js';
import { ContinuousObservationScheduler } from './continuous-observation-scheduler.js';
import { ObservationStateStore } from './observation-state-store.js';
import {
  ContinuousObserverConfig,
  GatewayObservationResult,
  ObservationState,
  ScheduledObservation,
} from './types.js';

// Default configuration values
const DEFAULT_CYCLE_INTERVAL_MS = 30 * 1000; // 30 seconds
const DEFAULT_GATEWAY_ASSESSMENT_CONCURRENCY = 3;
const DEFAULT_OBSERVATIONS_PER_GATEWAY = 3;
const DEFAULT_MAJORITY_THRESHOLD = 2;

// Sleep utility
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * ContinuousObserver spreads gateway observations across an epoch window
 * instead of performing batch observations.
 *
 * Key features:
 * - Deterministic scheduling based on composite entropy
 * - Multiple observations per gateway with majority vote
 * - State persistence for restart recovery
 * - Graceful shutdown support
 */
export class ContinuousObserver {
  private readonly observerAddress: string;
  private readonly epochSource: EpochTimestampSource;
  private readonly hostsSource: GatewayHostsSource;
  private readonly prescribedNamesSource: ArnsNamesSource;
  private readonly chosenNamesSource: ArnsNamesSource;
  private readonly entropySource: EntropySource;
  private readonly stateStore: ObservationStateStore;
  private readonly reportSink: ReportSink;
  private readonly config: ContinuousObserverConfig;
  private readonly log: Logger;

  private readonly scheduler: ContinuousObservationScheduler;
  private readonly assessor: GatewayAssessor;

  private state?: ObservationState;
  private prescribedNames: string[] = [];
  private chosenNames: string[] = [];
  private stopped = false;

  constructor({
    observerAddress,
    referenceGateway,
    epochSource,
    hostsSource,
    prescribedNamesSource,
    chosenNamesSource,
    entropySource,
    stateStore,
    reportSink,
    nodeReleaseVersion,
    nameAssessmentConcurrency,
    config,
    log,
  }: {
    observerAddress: string;
    referenceGateway: ReferenceGatewaySource;
    epochSource: EpochTimestampSource;
    hostsSource: GatewayHostsSource;
    prescribedNamesSource: ArnsNamesSource;
    chosenNamesSource: ArnsNamesSource;
    entropySource: EntropySource;
    stateStore: ObservationStateStore;
    reportSink: ReportSink;
    nodeReleaseVersion: string;
    nameAssessmentConcurrency: number;
    config?: Partial<ContinuousObserverConfig>;
    log: Logger;
  }) {
    this.observerAddress = observerAddress;
    this.epochSource = epochSource;
    this.hostsSource = hostsSource;
    this.prescribedNamesSource = prescribedNamesSource;
    this.chosenNamesSource = chosenNamesSource;
    this.entropySource = entropySource;
    this.stateStore = stateStore;
    this.reportSink = reportSink;
    this.log = log.child({ class: 'ContinuousObserver' });

    this.config = {
      cycleIntervalMs: config?.cycleIntervalMs ?? DEFAULT_CYCLE_INTERVAL_MS,
      gatewayAssessmentConcurrency:
        config?.gatewayAssessmentConcurrency ??
        DEFAULT_GATEWAY_ASSESSMENT_CONCURRENCY,
      observationsPerGateway:
        config?.observationsPerGateway ?? DEFAULT_OBSERVATIONS_PER_GATEWAY,
      majorityThreshold:
        config?.majorityThreshold ?? DEFAULT_MAJORITY_THRESHOLD,
    };

    this.scheduler = new ContinuousObservationScheduler({
      entropySource: this.entropySource,
      config: {
        observationsPerGateway: this.config.observationsPerGateway,
      },
      log: this.log,
    });

    this.assessor = new GatewayAssessor({
      referenceGateway,
      nodeReleaseVersion,
      nameAssessmentConcurrency,
      log: this.log,
    });
  }

  /**
   * Start the continuous observer.
   *
   * This method runs indefinitely until stop() is called.
   */
  async start(): Promise<void> {
    this.log.info('Starting continuous observer', {
      observerAddress: this.observerAddress,
      config: this.config,
    });

    await this.initializeOrRestore();

    while (!this.stopped) {
      try {
        await this.runObservationCycle();
      } catch (error: any) {
        this.log.error('Error in observation cycle', {
          error: error.message,
          stack: error.stack,
        });
      }
      await sleep(this.config.cycleIntervalMs);
    }

    this.log.info('Continuous observer stopped');
  }

  /**
   * Stop the continuous observer gracefully.
   */
  stop(): void {
    this.log.info('Stopping continuous observer...');
    this.stopped = true;
  }

  /**
   * Initialize for a new epoch or restore from saved state.
   */
  private async initializeOrRestore(): Promise<void> {
    const currentEpochIndex = await this.epochSource.getEpochIndex();

    // Try to restore from saved state
    const savedState = await this.stateStore.load();
    if (savedState !== null && savedState.epochIndex === currentEpochIndex) {
      this.log.info('Restoring from saved state', {
        epochIndex: savedState.epochIndex,
        gatewayCount: savedState.gatewayObservations.size,
        reportSubmitted: savedState.reportSubmitted,
      });

      this.state = savedState;
      this.scheduler.restoreFromState(savedState);

      // Restore names and initialize assessor
      await this.loadNamesAndInitializeAssessor();
    } else {
      // Initialize fresh for current epoch
      if (savedState !== null) {
        this.log.info('Saved state is from different epoch, reinitializing', {
          savedEpochIndex: savedState.epochIndex,
          currentEpochIndex,
        });
        await this.stateStore.clear();
      }

      await this.initializeEpoch(currentEpochIndex);
    }
  }

  /**
   * Initialize for a new epoch.
   */
  private async initializeEpoch(epochIndex: number): Promise<void> {
    const epochStartTimestamp = await this.epochSource.getEpochStartTimestamp();
    const epochEndTimestamp = await this.epochSource.getEpochEndTimestamp();
    const epochStartHeight = await this.epochSource.getEpochStartHeight();

    this.log.info('Initializing epoch', {
      epochIndex,
      epochStartTimestamp,
      epochEndTimestamp,
      epochStartHeight,
    });

    // Fetch gateways
    const gateways = await this.hostsSource.getHosts();

    // Initialize scheduler
    const { windowStart, windowEnd, schedule } =
      await this.scheduler.initializeEpoch({
        gateways,
        epochStartTimestamp,
        epochEndTimestamp,
        epochStartHeight,
      });

    // Build gateway wallet mapping (handle duplicates)
    const gatewayWallets = new Map<string, string[]>();
    const walletByFqdn = new Map<string, string>();
    for (const gateway of gateways) {
      const existing = gatewayWallets.get(gateway.fqdn) ?? [];
      if (!existing.includes(gateway.wallet)) {
        existing.push(gateway.wallet);
      }
      gatewayWallets.set(gateway.fqdn, existing);
      walletByFqdn.set(gateway.fqdn, gateway.wallet);
    }

    // Initialize state
    const uniqueFqdns = [...new Set(gateways.map((gateway) => gateway.fqdn))];

    this.state = {
      epochIndex,
      epochStartTimestamp,
      epochEndTimestamp,
      epochStartHeight,
      windowStart,
      windowEnd,
      pendingObservations: [...schedule],
      gatewayObservations: new Map(
        uniqueFqdns.map((fqdn) => {
          const wallet = walletByFqdn.get(fqdn);
          if (wallet === undefined) {
            throw new Error(`Missing wallet for gateway ${fqdn}`);
          }

          return [
            fqdn,
            {
              fqdn,
              wallet,
              observations: [],
            },
          ];
        }),
      ),
      gatewayWallets,
      offsetAssessmentGateways: new Set(), // TODO: implement offset selection
      lastCycleTimestamp: Date.now(),
      reportSubmitted: false,
    };

    // Load names and initialize assessor
    await this.loadNamesAndInitializeAssessor();

    // Persist initial state
    await this.stateStore.save(this.state);

    this.log.info('Epoch initialized', {
      epochIndex,
      gatewayCount: uniqueFqdns.length,
      windowStart: new Date(windowStart).toISOString(),
      windowEnd: new Date(windowEnd).toISOString(),
      totalObservations: schedule.length,
    });
  }

  /**
   * Load ArNS names and initialize the assessor for the current epoch.
   */
  private async loadNamesAndInitializeAssessor(): Promise<void> {
    if (!this.state) {
      throw new Error('State not initialized');
    }

    // Fetch names
    const [prescribed, chosen] = await Promise.all([
      this.prescribedNamesSource.getNames({
        epochStartHeight: this.state.epochStartHeight,
      }),
      this.chosenNamesSource.getNames({
        height: this.state.epochStartHeight,
      }),
    ]);

    this.prescribedNames = prescribed;
    this.chosenNames = chosen;

    // Get entropy for this epoch
    const entropy = await this.entropySource.getEntropy({
      height: this.state.epochStartHeight,
    });

    // Initialize assessor
    this.assessor.initializeForEpoch({
      entropy,
      namesCount: this.prescribedNames.length + this.chosenNames.length,
    });
  }

  /**
   * Run a single observation cycle.
   */
  private async runObservationCycle(): Promise<void> {
    if (!this.state) {
      await this.initializeOrRestore();
      return;
    }

    const now = Date.now();

    // Update progress and state metrics
    this.updateCycleMetrics(now);

    // Check for epoch transition
    const currentEpochIndex = await this.epochSource.getEpochIndex();
    if (currentEpochIndex !== this.state.epochIndex) {
      this.log.info('New epoch detected', {
        previousEpoch: this.state.epochIndex,
        currentEpoch: currentEpochIndex,
      });

      // Finalize current epoch if we haven't submitted yet
      if (!this.state.reportSubmitted) {
        this.forceMissedObservations(
          'Observation deadline exceeded before epoch transition',
        );
        const submitted = await this.finalizeAndSubmitReport();
        if (!submitted) {
          this.log.warn(
            'Deferring epoch transition until report submission succeeds',
            {
              epochIndex: this.state.epochIndex,
              nextEpochIndex: currentEpochIndex,
            },
          );
          return;
        }

        this.state.reportSubmitted = true;
      }

      // Clear state and reinitialize
      await this.stateStore.clear();
      this.assessor.clearEpochState();
      await this.initializeEpoch(currentEpochIndex);
      return;
    }

    // Not yet in window? Wait
    if (this.scheduler.isBeforeWindow(now)) {
      this.log.debug('Before observation window, waiting', {
        windowStart: new Date(this.scheduler.getWindowStart()).toISOString(),
        now: new Date(now).toISOString(),
      });
      return;
    }

    // Get due gateways and observe with limited concurrency
    const dueObservations = this.scheduler.getObservationsDue(now);
    if (dueObservations.length > 0) {
      const observationsByGateway = new Map<string, ScheduledObservation[]>();
      for (const observation of dueObservations) {
        const existing = observationsByGateway.get(observation.fqdn) ?? [];
        existing.push(observation);
        observationsByGateway.set(observation.fqdn, existing);
      }

      this.log.debug('Observing due gateway batches', {
        observationCount: dueObservations.length,
        gatewayCount: observationsByGateway.size,
        gateways: [...observationsByGateway.keys()].slice(0, 5),
      });

      await pMap(
        observationsByGateway.entries(),
        async ([fqdn, observations]) => {
          for (const observation of observations) {
            try {
              const result = await this.observeGateway({
                fqdn,
                scheduledAt: observation.scheduledAt,
              });
              const aggregate = this.state!.gatewayObservations.get(fqdn);
              if (aggregate) {
                aggregate.observations.push(result);
              }
              this.scheduler.markObservationComplete(observation.id);

              metrics.gatewayObservationsCounter?.inc({
                fqdn,
                status: result.pass ? 'pass' : 'fail',
              });
            } catch (error: any) {
              metrics.gatewayObservationsCounter?.inc({
                fqdn,
                status: 'error',
              });
              this.log.error('Error observing gateway', {
                fqdn,
                scheduledAt: observation.scheduledAt,
                error: error.message,
              });
            }
          }
        },
        { concurrency: this.config.gatewayAssessmentConcurrency },
      );

      this.state.lastCycleTimestamp = now;
      this.state.pendingObservations = this.scheduler.getSchedule();

      await this.stateStore.save(this.state);
    }

    if (
      this.scheduler.isWindowComplete(now) &&
      now >= this.scheduler.getSubmissionDeadline() &&
      this.scheduler.getPendingObservationCount() > 0
    ) {
      this.forceMissedObservations(
        'Observation deadline exceeded after repeated errors',
      );
      await this.stateStore.save(this.state);
    }

    if (
      this.scheduler.isWindowComplete(now) &&
      this.scheduler.getPendingObservationCount() === 0
    ) {
      if (!this.state.reportSubmitted) {
        const submitted = await this.finalizeAndSubmitReport();
        if (submitted) {
          this.state.reportSubmitted = true;
          await this.stateStore.save(this.state);
        }
      }
    }
  }

  private forceMissedObservations(failureReason: string): void {
    if (!this.state) {
      throw new Error('State not initialized');
    }

    for (const observation of this.scheduler.getSchedule()) {
      const aggregate = this.state.gatewayObservations.get(observation.fqdn);
      if (aggregate) {
        aggregate.observations.push(
          this.createMissedObservation(observation, failureReason),
        );
      }
      this.scheduler.markObservationComplete(observation.id);
      metrics.gatewayObservationsCounter?.inc({
        fqdn: observation.fqdn,
        status: 'error',
      });
    }

    this.state.pendingObservations = this.scheduler.getSchedule();
  }

  /**
   * Observe a single gateway.
   */
  private async observeGateway({
    fqdn,
    scheduledAt,
  }: {
    fqdn: string;
    scheduledAt: number;
  }): Promise<GatewayObservationResult> {
    const observedAt = Date.now();

    const expectedWallets = this.state!.gatewayWallets.get(fqdn) ?? [];

    // Run assessments
    const ownershipAssessment = await this.assessor.assessOwnership({
      host: fqdn,
      expectedWallets,
    });

    const arnsAssessments = await this.assessor.assessGatewayArns({
      host: fqdn,
      prescribedNames: this.prescribedNames,
      chosenNames: this.chosenNames,
    });

    // Calculate pass (for now, skip offset assessment)
    const pass = ownershipAssessment.pass && arnsAssessments.pass;

    // Log observation delay
    const delay = (observedAt - scheduledAt) / 1000;
    metrics.observationDelayHistogram?.observe(delay);

    this.log.debug('Gateway observed', {
      fqdn,
      pass,
      ownershipPass: ownershipAssessment.pass,
      arnsPass: arnsAssessments.pass,
      delaySeconds: delay.toFixed(1),
    });

    return {
      fqdn,
      observedAt,
      scheduledAt,
      ownershipAssessment,
      arnsAssessments,
      pass,
    };
  }

  private createMissedObservation(
    observation: ScheduledObservation,
    failureReason: string,
  ): GatewayObservationResult {
    return {
      fqdn: observation.fqdn,
      observedAt: Date.now(),
      scheduledAt: observation.scheduledAt,
      ownershipAssessment: {
        expectedWallets: this.state!.gatewayWallets.get(observation.fqdn) ?? [],
        observedWallet: null,
        failureReason,
        pass: false,
      },
      arnsAssessments: {
        prescribedNames: {},
        chosenNames: {},
        pass: false,
      },
      pass: false,
    };
  }

  /**
   * Finalize observations and submit the report.
   */
  private async finalizeAndSubmitReport(): Promise<boolean> {
    if (!this.state) {
      throw new Error('State not initialized');
    }

    this.log.info('Finalizing and submitting report', {
      epochIndex: this.state.epochIndex,
      gatewayCount: this.state.gatewayObservations.size,
    });

    const report = this.aggregateObservations();

    try {
      await this.reportSink.saveReport({ report });
      this.log.info('Report submitted successfully', {
        epochIndex: report.epochIndex,
      });
      return true;
    } catch (error: any) {
      this.log.error('Failed to submit report', {
        epochIndex: report.epochIndex,
        error: error.message,
      });
      return false;
    }
  }

  /**
   * Aggregate observations using majority vote.
   */
  private aggregateObservations(): ObserverReport {
    if (!this.state) {
      throw new Error('State not initialized');
    }

    const gatewayAssessments: GatewayAssessments = {};

    for (const [fqdn, aggregate] of this.state.gatewayObservations) {
      const observations = aggregate.observations;

      if (observations.length === 0) {
        // No observations - mark as failed
        gatewayAssessments[fqdn] = {
          ownershipAssessment: {
            expectedWallets: this.state.gatewayWallets.get(fqdn) ?? [],
            observedWallet: null,
            failureReason: 'No observations completed',
            pass: false,
          },
          arnsAssessments: {
            prescribedNames: {},
            chosenNames: {},
            pass: false,
          },
          pass: false,
        };
        continue;
      }

      // Majority vote: count passes
      const passCount = observations.filter((o) => o.pass).length;
      const gatewayPass = passCount >= this.config.majorityThreshold;

      // Use the best observation for report details
      const bestObservation = this.selectBestObservation(observations);

      gatewayAssessments[fqdn] = {
        ownershipAssessment: bestObservation.ownershipAssessment,
        arnsAssessments: bestObservation.arnsAssessments,
        // Override pass with majority vote result
        pass: gatewayPass,
      };
    }

    return {
      formatVersion: REPORT_FORMAT_VERSION,
      observerAddress: this.observerAddress,
      epochIndex: this.state.epochIndex,
      epochStartTimestamp: this.state.epochStartTimestamp,
      epochEndTimestamp: this.state.epochEndTimestamp,
      epochStartHeight: this.state.epochStartHeight,
      generatedAt: Math.floor(Date.now() / 1000),
      gatewayAssessments,
    };
  }

  /**
   * Select the best observation for a gateway.
   * Prefers passing observations, then most recent.
   */
  private selectBestObservation(
    observations: GatewayObservationResult[],
  ): GatewayObservationResult {
    const passing = observations.filter((o) => o.pass);
    if (passing.length > 0) {
      // Return most recent passing observation
      return passing[passing.length - 1];
    }
    // Return most recent observation overall
    return observations[observations.length - 1];
  }

  /**
   * Update cycle metrics for monitoring.
   */
  private updateCycleMetrics(now: number): void {
    if (!this.state) {
      return;
    }

    // Window progress (0-1)
    const windowStart = this.scheduler.getWindowStart();
    const windowEnd = this.scheduler.getWindowEnd();
    const windowDuration = windowEnd - windowStart;
    const progress =
      windowDuration > 0
        ? Math.max(0, Math.min(1, (now - windowStart) / windowDuration))
        : 0;
    metrics.windowProgressGauge.set(progress);

    // Observer state: 0=waiting, 1=observing, 2=finalizing
    if (this.scheduler.isBeforeWindow(now)) {
      metrics.continuousObserverStateGauge.set(0);
    } else if (
      this.scheduler.isWindowComplete(now) &&
      this.scheduler.getPendingObservationCount() === 0
    ) {
      metrics.continuousObserverStateGauge.set(2);
    } else {
      metrics.continuousObserverStateGauge.set(1);
    }

    // Epoch coverage (percentage of gateways with at least one observation)
    const totalGateways = this.state.gatewayObservations.size;
    const observedGateways = [
      ...this.state.gatewayObservations.values(),
    ].filter((agg) => agg.observations.length > 0).length;
    const coverage = totalGateways > 0 ? observedGateways / totalGateways : 0;
    metrics.epochCoverageGauge.set(coverage);
  }
}
