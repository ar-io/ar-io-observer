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

import { MAX_FORK_DEPTH } from '../arweave.js';
import { GatewayAssessor } from '../assessment/gateway-assessor.js';
import {
  OffsetAssessor,
  offsetAssessmentPasses,
  recordOffsetAssessmentMetrics,
  selectGatewaysForOffsetAssessment,
} from '../assessment/offset-assessor.js';
import * as metrics from '../metrics.js';
import { REPORT_FORMAT_VERSION } from '../observer.js';
import {
  ArnsNamesSource,
  EntropySource,
  EpochTimestampSource,
  GatewayAssessments,
  GatewayHostsSource,
  GatewayOffsetAssessments,
  HeightSource,
  ObserverReport,
  ReferenceGatewaySource,
  ReportSink,
  SubmissionGate,
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

// The offset search space is the weave up to a stable Arweave height,
// rounded down to this many blocks (~33 hours) so that observers starting
// the same epoch at different times almost always draw the same planned
// offsets. Solana epochs carry no Arweave height to anchor to.
const OFFSET_SEARCH_HEIGHT_QUANTUM = 1000;

/**
 * Offset (chunk-proof) observation settings: the OFFSET_* env vars.
 */
export interface OffsetObservationConfig {
  /** OFFSET_OBSERVATION_ENABLED */
  enabled: boolean;
  /** OFFSET_OBSERVATION_SAMPLE_RATE: share of gateways sampled per epoch */
  sampleRate: number;
  /** OFFSET_SAMPLE_COUNT: offsets tried per sampled gateway */
  sampleCount: number;
  /** OFFSET_OBSERVATION_ENFORCEMENT_ENABLED: whether a failure fails the gateway */
  enforcementEnabled: boolean;
}

/**
 * Everything the continuous observer needs to run offset checks. Omit it
 * to disable them.
 */
export interface OffsetObservationDeps {
  assessor: OffsetAssessor;
  /**
   * Entropy every observer shares for the epoch. Do not pass the
   * composite source (it mixes in per-observer randomness): sampling must
   * be identical across observers so their votes are comparable.
   */
  sharedEntropySource: EntropySource;
  /** Current Arweave height, to bound the stable offset range. */
  heightSource: HeightSource;
  config: OffsetObservationConfig;
}

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
  // Pipeline split: persistence ALWAYS runs (local record, restart-restore);
  // submission runs only when `submissionGate` allows it (e.g. observer
  // is VRF-prescribed for this epoch + hasn't already submitted). On a
  // dev setup with no Solana wiring, both `submissionSink` and
  // `submissionGate` can be undefined — the observer behaves like a
  // pure persistence loop.
  private readonly persistenceSink: ReportSink;
  private readonly submissionSink: ReportSink | undefined;
  private readonly submissionGate: SubmissionGate | undefined;
  private readonly config: ContinuousObserverConfig;
  private readonly log: Logger;

  private readonly scheduler: ContinuousObservationScheduler;
  private readonly assessor: GatewayAssessor;
  private readonly offsetObservation: OffsetObservationDeps | undefined;

  // Per-epoch offset sampling state. The selected gateways are kept in
  // `state.offsetAssessmentGateways`; these are rebuilt after a restart.
  private offsetEntropy?: Buffer;
  private offsetSearchSpace?: Promise<{
    maxStableOffset: number;
    maxSearchHeight: number;
  }>;

  private state?: ObservationState;
  private prescribedNames: string[] = [];
  private chosenNames: string[] = [];
  // True once `loadNamesAndInitializeAssessor` succeeds AND
  // `prescribedNames.length > 0` for the current epoch. The cranker's
  // `prescribe_epoch` instruction runs ~30-60s AFTER `create_epoch`
  // (it has to wait for `tally_weights` to finish first). If we read
  // the Epoch PDA in that window, `prescribed_names` is empty and so
  // is the shared entropy that the chosen-name selector mixes in.
  // We defer the read until the first observation cycle and re-try
  // each cycle until it lands.
  private prescribedNamesReady = false;
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
    persistenceSink,
    submissionSink,
    submissionGate,
    nodeReleaseVersion,
    nameAssessmentConcurrency,
    offsetObservation,
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
    /** Local-only sinks (FsReportStore, LogReportSink). Always run. */
    persistenceSink: ReportSink;
    /** External-submission sinks (Turbo upload + Solana on-chain).
     *  Runs only when `submissionGate` returns `proceed: true`, or
     *  unconditionally when no gate is provided. Omit on dev setups
     *  that don't submit. */
    submissionSink?: ReportSink;
    /** Predicate that decides whether the submission pipeline should
     *  run this cycle (typically: am I prescribed? have I already
     *  submitted?). Omit to always submit (legacy / AO behavior). */
    submissionGate?: SubmissionGate;
    nodeReleaseVersion: string;
    nameAssessmentConcurrency: number;
    /** Offset (chunk-proof) checks. Omit to disable them. */
    offsetObservation?: OffsetObservationDeps;
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
    this.persistenceSink = persistenceSink;
    this.submissionSink = submissionSink;
    this.submissionGate = submissionGate;
    this.offsetObservation = offsetObservation;
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
      // Optional scheduler tunings — preserved as-is (no defaults) so
      // the scheduler's own DEFAULT_* constants kick in when callers
      // don't override. Forwarded into the scheduler config below.
      stabilityBufferMs: config?.stabilityBufferMs,
      submissionBufferMs: config?.submissionBufferMs,
      windowFraction: config?.windowFraction,
    };

    this.scheduler = new ContinuousObservationScheduler({
      entropySource: this.entropySource,
      config: {
        observationsPerGateway: this.config.observationsPerGateway,
        // Pass-through scheduler tunings (default to undefined → the
        // scheduler picks its production defaults). Lets callers
        // override for fast-epoch devnets where the production
        // 36min/72min buffers don't fit a 60min epoch.
        ...(this.config.stabilityBufferMs !== undefined
          ? { stabilityBufferMs: this.config.stabilityBufferMs }
          : {}),
        ...(this.config.submissionBufferMs !== undefined
          ? { submissionBufferMs: this.config.submissionBufferMs }
          : {}),
        ...(this.config.windowFraction !== undefined
          ? { windowFraction: this.config.windowFraction }
          : {}),
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

      // Names + assessor are loaded lazily on the first observation
      // cycle so we don't race the cranker's `prescribe_epoch`. See
      // `prescribedNamesReady`.
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
      // Filled once the shared epoch entropy is available; see
      // `initializeOffsetSampling`.
      offsetAssessmentGateways: new Set(),
      lastCycleTimestamp: Date.now(),
      reportSubmitted: false,
      submissionDeadlineExceeded: false,
    };

    // Persist initial state
    await this.stateStore.save(this.state);

    this.log.info('Epoch initialized', {
      epochIndex,
      gatewayCount: uniqueFqdns.length,
      windowStart: new Date(windowStart).toISOString(),
      windowEnd: new Date(windowEnd).toISOString(),
      totalObservations: schedule.length,
    });

    // Names + assessor load lazily on the first observation cycle —
    // see `prescribedNamesReady` for the why.
  }

  /**
   * Load ArNS names and initialize the assessor for the current epoch.
   *
   * Returns `true` once prescribed names are actually available on-
   * chain (non-empty). The caller (`runObservationCycle`) treats
   * `false` as "cranker hasn't run `prescribe_epoch` yet — retry next
   * cycle." Until prescribed names are present, the shared epoch
   * entropy is derived from an empty observer/name list, which
   * weakens the chosen-name selection too — so we hold off on the
   * whole load.
   */
  private async loadNamesAndInitializeAssessor(): Promise<boolean> {
    if (!this.state) {
      throw new Error('State not initialized');
    }

    // `prescribedNamesSource` is keyed on `epochIndex` (the SDK's
    // prescribed-name lookup is epoch-relative, not block-height-
    // relative). Pre-prescribe_epoch this returns `[]`. Once the
    // cranker lands prescribe_epoch the same call returns 2 names.
    const prescribed = await this.prescribedNamesSource.getNames({
      epochIndex: this.state.epochIndex,
    });

    if (prescribed.length === 0) {
      this.log.verbose(
        'Prescribed names not yet available on-chain — waiting for cranker',
        { epochIndex: this.state.epochIndex },
      );
      return false;
    }

    // Only fetch chosen names once prescribed names are ready. Chosen
    // names use the shared epoch entropy (which mixes in the
    // prescribed observers + name hashes) — fetching pre-prescription
    // would derive them from an empty entropy state.
    const chosen = await this.chosenNamesSource.getNames({
      height: this.state.epochStartHeight,
    });

    this.prescribedNames = prescribed;
    this.chosenNames = chosen;

    // Entropy is now fetched post-prescribe_epoch, so the on-chain
    // observer list + name hashes are populated and feed into the
    // hash. Cache invalidation in `SolanaEpochEntropySource` ensures
    // any prior empty-state read is not reused.
    const entropy = await this.entropySource.getEntropy({
      height: this.state.epochStartHeight,
    });

    this.assessor.initializeForEpoch({
      entropy,
      namesCount: this.prescribedNames.length + this.chosenNames.length,
    });

    this.log.info('Names + assessor initialized for epoch', {
      epochIndex: this.state.epochIndex,
      prescribedCount: this.prescribedNames.length,
      chosenCount: this.chosenNames.length,
    });

    await this.initializeOffsetSampling();

    return true;
  }

  /**
   * Choose this epoch's gateways for offset (chunk-proof) checks.
   *
   * Selection uses the shared epoch entropy over the gateway FQDNs in
   * sorted order, so every observer with the same gateway list samples
   * the same gateways, and each sampled gateway gets the same planned
   * offsets (seeded by entropy + FQDN). Runs again after a restart and
   * gives the same answer.
   */
  private async initializeOffsetSampling(): Promise<void> {
    if (!this.state) {
      throw new Error('State not initialized');
    }

    const offsetObservation = this.offsetObservation;
    if (offsetObservation === undefined || !offsetObservation.config.enabled) {
      this.state.offsetAssessmentGateways = new Set();
      return;
    }

    // Same argument the batch observer passes for its entropy.
    this.offsetEntropy = await offsetObservation.sharedEntropySource.getEntropy(
      { height: this.state.epochStartHeight },
    );

    const fqdns = [...this.state.gatewayObservations.keys()].sort();
    this.state.offsetAssessmentGateways = selectGatewaysForOffsetAssessment({
      fqdns,
      entropy: this.offsetEntropy,
      enabled: offsetObservation.config.enabled,
      sampleRate: offsetObservation.config.sampleRate,
    });
    await this.stateStore.save(this.state);

    this.log.info('Selected gateways for offset observations', {
      epochIndex: this.state.epochIndex,
      totalGateways: fqdns.length,
      sampleRate: offsetObservation.config.sampleRate,
      selectedCount: this.state.offsetAssessmentGateways.size,
      enforcementEnabled: offsetObservation.config.enforcementEnabled,
      selectedGateways: [...this.state.offsetAssessmentGateways].sort(),
    });
  }

  /**
   * Stable offset range for this epoch, fetched once and reused by every
   * observation. A failed fetch is not cached, so the next observation
   * retries.
   */
  private getOffsetSearchSpace(
    offsetObservation: OffsetObservationDeps,
  ): Promise<{ maxStableOffset: number; maxSearchHeight: number }> {
    if (this.offsetSearchSpace === undefined) {
      const searchSpace = (async () => {
        const currentHeight = await offsetObservation.heightSource.getHeight();
        const stableHeight = Math.max(1, currentHeight - MAX_FORK_DEPTH);
        const maxSearchHeight = Math.max(
          1,
          Math.floor(stableHeight / OFFSET_SEARCH_HEIGHT_QUANTUM) *
            OFFSET_SEARCH_HEIGHT_QUANTUM,
        );
        const maxStableOffset =
          await offsetObservation.assessor.getWeaveSizeAtHeight(
            maxSearchHeight,
          );
        this.log.info('Offset search space set for epoch', {
          currentHeight,
          maxSearchHeight,
          maxStableOffset,
        });
        return { maxStableOffset, maxSearchHeight };
      })();
      searchSpace.catch(() => {
        if (this.offsetSearchSpace === searchSpace) {
          this.offsetSearchSpace = undefined;
        }
      });
      this.offsetSearchSpace = searchSpace;
    }
    return this.offsetSearchSpace;
  }

  /**
   * Offset assessment for one observation of a sampled gateway.
   *
   * Runs on every observation (not once per epoch), with the same planned
   * offsets each time, so a transient timeout gets the same 2-of-3
   * majority protection as the ownership and ArNS checks. Returns
   * undefined, which never fails a gateway, when the observer cannot
   * establish the search space itself.
   */
  private async assessOffsets(
    fqdn: string,
  ): Promise<GatewayOffsetAssessments | undefined> {
    const offsetObservation = this.offsetObservation;
    if (offsetObservation === undefined || this.offsetEntropy === undefined) {
      return undefined;
    }
    const { enforcementEnabled, sampleCount } = offsetObservation.config;

    let searchSpace;
    try {
      searchSpace = await this.getOffsetSearchSpace(offsetObservation);
    } catch (error: any) {
      this.log.warn(
        'Could not determine offset search space; skipping offset check',
        { fqdn, error: error?.message },
      );
      return undefined;
    }

    const offsetAssessments =
      await offsetObservation.assessor.assessSampledGateway({
        targetHost: fqdn,
        entropy: this.offsetEntropy,
        offsetSampleCount: sampleCount,
        maxStableOffset: searchSpace.maxStableOffset,
        maxSearchHeight: searchSpace.maxSearchHeight,
        enforcementEnabled,
      });

    recordOffsetAssessmentMetrics({
      sampled: true,
      offsetAssessments,
      enforcementEnabled,
    });

    return offsetAssessments;
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

    // Check for epoch transition
    const currentEpochIndex = await this.epochSource.getEpochIndex();
    if (currentEpochIndex !== this.state.epochIndex) {
      this.log.info('New epoch detected', {
        previousEpoch: this.state.epochIndex,
        currentEpoch: currentEpochIndex,
      });

      if (!this.state.reportSubmitted) {
        this.log.warn(
          'Discarding unsubmitted epoch state after submission window closed',
          {
            epochIndex: this.state.epochIndex,
            nextEpochIndex: currentEpochIndex,
            submissionDeadlineExceeded: this.state.submissionDeadlineExceeded,
          },
        );
      }

      // Clear state and reinitialize
      await this.stateStore.clear();
      this.assessor.clearEpochState();
      this.prescribedNamesReady = false;
      this.prescribedNames = [];
      this.chosenNames = [];
      this.offsetEntropy = undefined;
      this.offsetSearchSpace = undefined;
      await this.initializeEpoch(currentEpochIndex);
      return;
    }

    // Close the submission window FIRST, before the name-loading retry
    // below. If `prescribe_epoch` never lands, `prescribedNamesReady`
    // stays false and the lazy-load block would `return` every cycle —
    // never reaching the deadline check, so `submissionDeadlineExceeded`
    // would never persist and the epoch's state would linger until
    // rollover. Gating here ensures the window closes regardless.
    if (
      !this.state.submissionDeadlineExceeded &&
      now >= this.scheduler.getSubmissionDeadline()
    ) {
      this.state.submissionDeadlineExceeded = true;
      this.state.pendingObservations = [];
      this.scheduler.clearSchedule();
      await this.stateStore.save(this.state);
      this.log.warn('Submission window closed for epoch', {
        epochIndex: this.state.epochIndex,
      });
    }

    if (this.state.submissionDeadlineExceeded) {
      this.updateCycleMetrics(now);
      return;
    }

    // Lazy-load prescribed/chosen names + entropy once the cranker
    // has actually run `prescribe_epoch`. We retry every cycle until
    // it lands (typically within ~1 minute of epoch start). Without
    // this, every cycle of the entire epoch would observe with an
    // empty prescribed-name set — making pass/fail judgments off the
    // chosen names alone, weakening the bitmap submission.
    if (!this.prescribedNamesReady) {
      const ready = await this.loadNamesAndInitializeAssessor();
      if (!ready) {
        this.updateCycleMetrics(now);
        return;
      }
      this.prescribedNamesReady = true;
    }

    // Not yet in window? Wait
    if (this.scheduler.isBeforeWindow(now)) {
      this.updateCycleMetrics(now);
      this.log.debug('Before observation window, waiting', {
        windowStart: new Date(this.scheduler.getWindowStart()).toISOString(),
        now: new Date(now).toISOString(),
      });
      return;
    }

    // Update progress and state metrics for the active in-window cycle.
    // (Deadline transition + exceeded short-circuit are handled above,
    // before name loading.)
    this.updateCycleMetrics(now);

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

    // Draining observations above can take long enough to cross the
    // submission deadline; re-check before finalizing so we don't submit late.
    const finalizeTime = Date.now();
    if (finalizeTime >= this.scheduler.getSubmissionDeadline()) {
      if (!this.state.submissionDeadlineExceeded) {
        this.state.submissionDeadlineExceeded = true;
        this.state.pendingObservations = [];
        this.scheduler.clearSchedule();
        await this.stateStore.save(this.state);
        this.log.warn('Submission window closed for epoch', {
          epochIndex: this.state.epochIndex,
        });
        this.updateCycleMetrics(finalizeTime);
      }
      return;
    }

    if (
      this.scheduler.isWindowComplete(finalizeTime) &&
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

    // ArNS and offset checks run in parallel, as in batch mode.
    const offsetSampled =
      this.offsetObservation?.config.enabled === true &&
      this.state!.offsetAssessmentGateways.has(fqdn);
    const [arnsAssessments, offsetAssessments] = await Promise.all([
      this.assessor.assessGatewayArns({
        host: fqdn,
        prescribedNames: this.prescribedNames,
        chosenNames: this.chosenNames,
      }),
      offsetSampled ? this.assessOffsets(fqdn) : Promise.resolve(undefined),
    ]);
    if (!offsetSampled) {
      recordOffsetAssessmentMetrics({
        sampled: false,
        offsetAssessments: undefined,
        enforcementEnabled: false,
      });
    }

    // The batch observer's rule (r54+): a failed offset assessment fails
    // the gateway only when enforcement is on.
    const offsetPass = offsetAssessmentPasses({
      offsetAssessments,
      enforcementEnabled:
        this.offsetObservation?.config.enforcementEnabled === true,
    });
    const pass = ownershipAssessment.pass && arnsAssessments.pass && offsetPass;

    // Log observation delay
    const delay = (observedAt - scheduledAt) / 1000;
    metrics.observationDelayHistogram?.observe(delay);

    this.log.debug('Gateway observed', {
      fqdn,
      pass,
      ownershipPass: ownershipAssessment.pass,
      arnsPass: arnsAssessments.pass,
      offsetSampled,
      offsetAssessmentPass: offsetAssessments?.pass,
      offsetPass,
      delaySeconds: delay.toFixed(1),
    });

    return {
      fqdn,
      observedAt,
      scheduledAt,
      ownershipAssessment,
      arnsAssessments,
      ...(offsetAssessments !== undefined ? { offsetAssessments } : {}),
      pass,
    };
  }

  /**
   * Finalize the report for this epoch in two phases:
   *
   *   1. Persistence pipeline — ALWAYS runs. FsReportStore (and
   *      LogReportSink if enabled) record the report locally so we
   *      can restart-restore and operators can audit assessments
   *      whether or not we end up submitting.
   *
   *   2. Submission pipeline — runs ONLY if `submissionGate` proceeds
   *      (typically: we're VRF-prescribed for this epoch and haven't
   *      already submitted). Turbo uploads the bundle, then
   *      SolanaContractReportSink lands `save_observations` on-chain.
   *
   * Return semantics — what the caller uses to flip `reportSubmitted`
   * (so we don't re-run this for the rest of the epoch):
   *
   *   - true:   Submission ran and produced a `reportTxId`. Done.
   *   - true:   Gate said `proceed: false` (e.g. not prescribed). The
   *             epoch is terminal — nothing more to do this epoch.
   *   - true:   No submission pipeline wired at all (persistence-only
   *             dev setup). Persistence ran, nothing else to do.
   *   - false:  Submission pipeline ran but no `reportTxId` came back
   *             (a downstream gate dropped it — e.g. failure-rate
   *             threshold). Retry next cycle.
   *   - false:  A sink inside either pipeline threw. The pipeline logs
   *             and continues, so this is read from `failedSinks`.
   *             Retry next cycle.
   *   - false:  Submission pipeline threw. Retry next cycle.
   *   - false:  Gate threw (RPC indeterminate). Retry next cycle.
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

    // ----- Phase 1: persistence ALWAYS runs -----
    let persisted;
    try {
      persisted = await this.persistenceSink.saveReport({ report });
    } catch (error: any) {
      // A persistence failure is a real defect (disk full, permissions,
      // etc.). Log and bail — without local state we can't safely flip
      // `reportSubmitted`, since a restart wouldn't be able to restore.
      this.log.error('Persistence pipeline failed; will retry next cycle', {
        epochIndex: report.epochIndex,
        error: error.message,
      });
      return false;
    }

    // PipelineReportSink swallows per-sink errors so one bad sink can't
    // block the rest. It reports them in `failedSinks`, which must be
    // checked — otherwise a failed FsReportStore looks like success and
    // a restart finds no local state to restore.
    if (persisted.failedSinks !== undefined) {
      this.log.error('Persistence sink failed; will retry next cycle', {
        epochIndex: report.epochIndex,
        failedSinks: persisted.failedSinks,
      });
      return false;
    }

    // ----- Phase 2 (optional): external submission, gated -----
    if (this.submissionSink === undefined) {
      // Persistence-only setup (e.g. dev). Phase 1 already covered.
      this.log.info('Report persisted (no submission pipeline wired)', {
        epochIndex: report.epochIndex,
      });
      return true;
    }

    if (this.submissionGate !== undefined) {
      let decision;
      try {
        decision = await this.submissionGate(report);
      } catch (error: any) {
        // Indeterminate — don't burn credits, don't mark done; retry
        // next cycle. If the gate keeps failing, the submission window
        // will eventually close (the scheduler logs that as a warn).
        this.log.warn(
          'Submission gate threw (indeterminate); will retry next cycle',
          { epochIndex: report.epochIndex, error: error.message },
        );
        return false;
      }
      if (!decision.proceed) {
        // Terminal for this epoch — no on-chain pathway exists.
        // Persistence already saved the local copy.
        this.log.info('Submission skipped — epoch is terminal for us', {
          epochIndex: report.epochIndex,
          reason: decision.reason ?? 'gate returned proceed=false',
        });
        return true;
      }
    }

    // ----- Submission pipeline runs -----
    try {
      const result = await this.submissionSink.saveReport(persisted);
      // A Turbo upload followed by a failed `save_observations` returns
      // a `reportTxId` and no on-chain record. Checking only the txid
      // reads that as success and burns the rest of the epoch. Retry
      // instead — the observation window usually has hours left.
      if (result.failedSinks !== undefined) {
        this.log.error('Submission sink failed; will retry next cycle', {
          epochIndex: report.epochIndex,
          failedSinks: result.failedSinks,
          reportTxId: result.reportTxId,
        });
        return false;
      }
      if (result.reportTxId === undefined) {
        // The submission pipeline dropped the report (e.g. the 80%
        // failure-rate safety inside PipelineReportSink, or a Turbo
        // upload error logged but swallowed). Don't claim success.
        this.log.warn(
          'Submission pipeline produced no reportTxId; will retry next cycle',
          { epochIndex: report.epochIndex },
        );
        return false;
      }
      this.log.info('Report submitted', {
        epochIndex: report.epochIndex,
        reportTxId: result.reportTxId,
        interactionTxIds: result.interactionTxIds,
      });
      return true;
    } catch (error: any) {
      this.log.error('Submission pipeline failed; will retry next cycle', {
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
        ...(bestObservation.offsetAssessments !== undefined
          ? { offsetAssessments: bestObservation.offsetAssessments }
          : {}),
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

    // Observer state: 0=waiting, 1=observing, 2=finalizing, 3=expired
    if (this.state.submissionDeadlineExceeded) {
      metrics.continuousObserverStateGauge.set(3);
    } else if (this.scheduler.isBeforeWindow(now)) {
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
