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

import { expect } from 'chai';
import * as sinon from 'sinon';
import { createLogger, transports } from 'winston';

import { ContinuousObserver } from './continuous-observer.js';
import { EntropySource, GatewayHost } from '../types.js';
import { ContinuousObservationScheduler } from './continuous-observation-scheduler.js';
import { FsObservationStateStore } from './observation-state-store.js';
import { ObservationState } from './types.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const testLog = createLogger({
  level: 'error',
  transports: new transports.Console(),
});

// Mock entropy source
class MockEntropySource implements EntropySource {
  private entropy: Buffer;

  constructor(entropy: Buffer) {
    this.entropy = entropy;
  }

  async getEntropy(): Promise<Buffer> {
    return this.entropy;
  }
}

describe('ContinuousObserver Integration', function () {
  const entropy = Buffer.from('test-entropy-deterministic');
  const entropySource = new MockEntropySource(entropy);

  const gateways: GatewayHost[] = [
    { fqdn: 'gateway1.example.com', wallet: 'wallet1' },
    { fqdn: 'gateway2.example.com', wallet: 'wallet2' },
    { fqdn: 'gateway3.example.com', wallet: 'wallet3' },
  ];

  const epochStartTimestamp = Date.now();
  const epochEndTimestamp = epochStartTimestamp + 24 * 60 * 60 * 1000;
  const epochStartHeight = 1000;

  describe('Scheduler + State Store Integration', function () {
    let tempDir: string;
    let stateStore: FsObservationStateStore;

    beforeEach(function () {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'observer-test-'));
      stateStore = new FsObservationStateStore({
        statePath: path.join(tempDir, 'state.json'),
        log: testLog,
      });
    });

    afterEach(function () {
      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it('should persist scheduler state and restore correctly', async function () {
      // Initialize scheduler and create schedule
      const scheduler = new ContinuousObservationScheduler({
        entropySource,
        config: { observationsPerGateway: 3 },
        log: testLog,
      });

      const { windowStart, windowEnd, schedule } =
        await scheduler.initializeEpoch({
          gateways,
          epochStartTimestamp,
          epochEndTimestamp,
          epochStartHeight,
        });

      // Create full observation state
      const state: ObservationState = {
        epochIndex: 1,
        epochStartTimestamp,
        epochEndTimestamp,
        epochStartHeight,
        windowStart,
        windowEnd,
        pendingObservations: schedule,
        gatewayObservations: new Map(
          gateways.map((g) => [
            g.fqdn,
            { fqdn: g.fqdn, wallet: g.wallet, observations: [] },
          ]),
        ),
        gatewayWallets: new Map(gateways.map((g) => [g.fqdn, [g.wallet]])),
        offsetAssessmentGateways: new Set(['gateway1.example.com']),
        lastCycleTimestamp: Date.now(),
        reportSubmitted: false,
        submissionDeadlineExceeded: false,
      };

      // Persist state
      await stateStore.save(state);

      // Load state in new store instance
      const newStoreInstance = new FsObservationStateStore({
        statePath: path.join(tempDir, 'state.json'),
        log: testLog,
      });
      const loadedState = await newStoreInstance.load();

      expect(loadedState).to.not.be.null;
      expect(loadedState!.epochIndex).to.equal(1);
      expect(loadedState!.windowStart).to.equal(windowStart);
      expect(loadedState!.windowEnd).to.equal(windowEnd);
      expect(loadedState!.pendingObservations).to.deep.equal(schedule);
      expect(loadedState!.gatewayObservations.size).to.equal(3);
      expect(loadedState!.offsetAssessmentGateways.has('gateway1.example.com'))
        .to.be.true;

      // Restore scheduler from loaded state
      const restoredScheduler = new ContinuousObservationScheduler({
        entropySource,
        config: { observationsPerGateway: 3 },
        log: testLog,
      });

      restoredScheduler.restoreFromState(loadedState!);

      // Verify scheduler state matches
      expect(restoredScheduler.getWindowStart()).to.equal(windowStart);
      expect(restoredScheduler.getWindowEnd()).to.equal(windowEnd);
      expect(restoredScheduler.getSchedule()).to.deep.equal(schedule);
    });

    it('should track observation completion through save/restore cycle', async function () {
      const scheduler = new ContinuousObservationScheduler({
        entropySource,
        config: { observationsPerGateway: 3 },
        log: testLog,
      });

      const { windowStart, windowEnd, schedule } =
        await scheduler.initializeEpoch({
          gateways,
          epochStartTimestamp,
          epochEndTimestamp,
          epochStartHeight,
        });

      const firstGateway = gateways[0].fqdn;
      const initialCount = schedule.filter(
        (observation) => observation.fqdn === firstGateway,
      ).length;
      expect(initialCount).to.equal(3);

      // Mark one observation complete
      const observation = schedule.find(
        (scheduledObservation) => scheduledObservation.fqdn === firstGateway,
      );
      expect(observation).to.not.be.undefined;
      scheduler.markObservationComplete(observation!.id);

      // Save state
      const state: ObservationState = {
        epochIndex: 1,
        epochStartTimestamp,
        epochEndTimestamp,
        epochStartHeight,
        windowStart,
        windowEnd,
        pendingObservations: scheduler.getSchedule(),
        gatewayObservations: new Map(),
        gatewayWallets: new Map(),
        offsetAssessmentGateways: new Set(),
        lastCycleTimestamp: Date.now(),
        reportSubmitted: false,
        submissionDeadlineExceeded: false,
      };

      await stateStore.save(state);

      // Restore to new scheduler
      const loadedState = await stateStore.load();
      const newScheduler = new ContinuousObservationScheduler({
        entropySource,
        config: { observationsPerGateway: 3 },
        log: testLog,
      });
      newScheduler.restoreFromState(loadedState!);

      // Should have 2 remaining observations for first gateway
      const remainingCount = newScheduler
        .getSchedule()
        .filter(
          (scheduledObservation) => scheduledObservation.fqdn === firstGateway,
        ).length;
      expect(remainingCount).to.equal(2);
    });
  });

  describe('Report Submission State', function () {
    let clock: sinon.SinonFakeTimers;

    beforeEach(function () {
      clock = sinon.useFakeTimers({
        now: new Date('2026-01-01T00:00:00.000Z'),
        shouldAdvanceTime: false,
      });
    });

    afterEach(function () {
      clock.restore();
      sinon.restore();
    });

    function createObserver({
      epochIndex,
      reportSink,
      stateStore,
    }: {
      epochIndex: number;
      reportSink: { saveReport: sinon.SinonStub };
      stateStore: {
        load: sinon.SinonStub;
        save: sinon.SinonStub;
        clear: sinon.SinonStub;
      };
    }): ContinuousObserver {
      return new ContinuousObserver({
        observerAddress: 'observer-wallet',
        referenceGateway: {
          getArnsResolution: sinon.stub().rejects(new Error('unused')),
          checkChunkAvailability: sinon.stub().rejects(new Error('unused')),
          getChunkMetadata: sinon.stub().rejects(new Error('unused')),
        },
        epochSource: {
          getEpochIndex: sinon.stub().resolves(epochIndex),
          getEpochStartTimestamp: sinon.stub().resolves(epochStartTimestamp),
          getEpochEndTimestamp: sinon.stub().resolves(epochEndTimestamp),
          getEpochStartHeight: sinon.stub().resolves(epochStartHeight),
          getEpochSettings: sinon.stub().resolves({
            epochZeroStartTimestamp: 0,
            durationMs: epochEndTimestamp - epochStartTimestamp,
          }),
        },
        hostsSource: {
          getHosts: sinon.stub().resolves(gateways),
        },
        // Non-empty prescribed list — the observer's new
        // `prescribedNamesReady` gate skips the whole cycle when the
        // contract hasn't run `prescribe_epoch` yet (returns []).
        // These tests exercise the post-prescription flow, so stub
        // realistic protocol-spec values.
        prescribedNamesSource: {
          getNames: sinon.stub().resolves(['prescribed-1', 'prescribed-2']),
        },
        chosenNamesSource: {
          getNames: sinon.stub().resolves(['chosen-1', 'chosen-2']),
        },
        entropySource,
        stateStore,
        // Wire the single test stub as the persistence sink. Tests
        // that exercise the submission pipeline explicitly pass a
        // distinct `submissionSink` (none of these do today, but the
        // split is observable to callers).
        persistenceSink: reportSink,
        nodeReleaseVersion: 'test-release',
        nameAssessmentConcurrency: 1,
        config: {
          cycleIntervalMs: 1000,
          observationsPerGateway: 3,
          majorityThreshold: 2,
          gatewayAssessmentConcurrency: 1,
        },
        log: testLog,
      });
    }

    function createState({
      reportSubmitted = false,
      epoch = 1,
      windowStartOffsetMs = -60_000,
      windowEndOffsetMs = -1_000,
    }: {
      reportSubmitted?: boolean;
      epoch?: number;
      windowStartOffsetMs?: number;
      windowEndOffsetMs?: number;
    }): ObservationState {
      return {
        epochIndex: epoch,
        epochStartTimestamp,
        epochEndTimestamp,
        epochStartHeight,
        windowStart: Date.now() + windowStartOffsetMs,
        windowEnd: Date.now() + windowEndOffsetMs,
        pendingObservations: [],
        gatewayObservations: new Map(
          gateways.map((g) => [
            g.fqdn,
            {
              fqdn: g.fqdn,
              wallet: g.wallet,
              observations: [],
            },
          ]),
        ),
        gatewayWallets: new Map(gateways.map((g) => [g.fqdn, [g.wallet]])),
        offsetAssessmentGateways: new Set(),
        lastCycleTimestamp: Date.now(),
        reportSubmitted,
        submissionDeadlineExceeded: false,
      };
    }

    function restoreObserverState(
      observer: ContinuousObserver,
      state: ObservationState,
    ): void {
      (observer as any).state = state;
      (observer as any).scheduler.restoreFromState(state);
    }

    it('keeps reportSubmitted false when submission fails at window close', async function () {
      const reportSink = {
        saveReport: sinon
          .stub()
          .onFirstCall()
          .rejects(new Error('sink unavailable'))
          .onSecondCall()
          .resolves({ report: {} as any, reportTxId: 'mock-arweave-tx-id' }),
      };
      const stateStore = {
        load: sinon.stub().resolves(null),
        save: sinon.stub().resolves(),
        clear: sinon.stub().resolves(),
      };
      const observer = createObserver({
        epochIndex: 1,
        reportSink,
        stateStore,
      });
      const state = createState({});

      restoreObserverState(observer, state);

      await (observer as any).runObservationCycle();

      expect(state.reportSubmitted).to.be.false;
      expect(stateStore.save.called).to.be.false;

      await (observer as any).runObservationCycle();

      expect(state.reportSubmitted).to.be.true;
      expect(stateStore.save.calledOnceWithExactly(state)).to.be.true;
    });

    it('discards stale unsubmitted epoch state on rollover', async function () {
      const reportSink = {
        saveReport: sinon
          .stub()
          .onFirstCall()
          .rejects(new Error('sink unavailable')),
      };
      const stateStore = {
        load: sinon.stub().resolves(null),
        save: sinon.stub().resolves(),
        clear: sinon.stub().resolves(),
      };
      const observer = createObserver({
        epochIndex: 2,
        reportSink,
        stateStore,
      });
      const state = createState({
        epoch: 1,
        windowStartOffsetMs: -120_000,
        windowEndOffsetMs: 120_000,
      });

      restoreObserverState(observer, state);

      await (observer as any).runObservationCycle();

      expect(reportSink.saveReport.called).to.be.false;
      expect(stateStore.clear.calledOnce).to.be.true;
      expect(stateStore.save.calledOnce).to.be.true;
      expect((observer as any).state.epochIndex).to.equal(2);
    });
  });

  describe('Overdue Observation Catch-up', function () {
    let clock: sinon.SinonFakeTimers;

    beforeEach(function () {
      clock = sinon.useFakeTimers({
        now: new Date('2026-01-01T00:00:00.000Z'),
        shouldAdvanceTime: false,
      });
    });

    afterEach(function () {
      clock.restore();
      sinon.restore();
    });

    function createObserverForCatchUp({
      stateStore,
      reportSink,
      epochIndex = 1,
    }: {
      stateStore: {
        load: sinon.SinonStub;
        save: sinon.SinonStub;
        clear: sinon.SinonStub;
      };
      reportSink: { saveReport: sinon.SinonStub };
      epochIndex?: number;
    }): ContinuousObserver {
      return new ContinuousObserver({
        observerAddress: 'observer-wallet',
        referenceGateway: {
          getArnsResolution: sinon.stub().rejects(new Error('unused')),
          checkChunkAvailability: sinon.stub().rejects(new Error('unused')),
          getChunkMetadata: sinon.stub().rejects(new Error('unused')),
        },
        epochSource: {
          getEpochIndex: sinon.stub().resolves(epochIndex),
          getEpochStartTimestamp: sinon.stub().resolves(epochStartTimestamp),
          getEpochEndTimestamp: sinon.stub().resolves(epochEndTimestamp),
          getEpochStartHeight: sinon.stub().resolves(epochStartHeight),
          getEpochSettings: sinon.stub().resolves({
            epochZeroStartTimestamp: 0,
            durationMs: epochEndTimestamp - epochStartTimestamp,
          }),
        },
        hostsSource: {
          getHosts: sinon.stub().resolves(gateways),
        },
        // Non-empty prescribed list — the observer's new
        // `prescribedNamesReady` gate skips the whole cycle when the
        // contract hasn't run `prescribe_epoch` yet (returns []).
        // These tests exercise the post-prescription flow, so stub
        // realistic protocol-spec values.
        prescribedNamesSource: {
          getNames: sinon.stub().resolves(['prescribed-1', 'prescribed-2']),
        },
        chosenNamesSource: {
          getNames: sinon.stub().resolves(['chosen-1', 'chosen-2']),
        },
        entropySource,
        stateStore,
        // Wire the single test stub as the persistence sink. Tests
        // that exercise the submission pipeline explicitly pass a
        // distinct `submissionSink` (none of these do today, but the
        // split is observable to callers).
        persistenceSink: reportSink,
        nodeReleaseVersion: 'test-release',
        nameAssessmentConcurrency: 1,
        config: {
          cycleIntervalMs: 1000,
          observationsPerGateway: 3,
          majorityThreshold: 2,
          gatewayAssessmentConcurrency: 2,
        },
        log: testLog,
      });
    }

    function restoreState(
      observer: ContinuousObserver,
      state: ObservationState,
    ): void {
      (observer as any).state = state;
      (observer as any).scheduler.restoreFromState(state);
      // Tests in this block pre-inject `prescribedNames` + `chosenNames`
      // and swap in a hand-rolled assessor mock that doesn't implement
      // `initializeForEpoch`. Mark names as already-loaded so
      // `runObservationCycle` skips the lazy load that would otherwise
      // crash on the stub. Tests of the lazy-load gate live separately.
      (observer as any).prescribedNamesReady = true;
    }

    it('drains multiple overdue observations for the same gateway in one cycle', async function () {
      const stateStore = {
        load: sinon.stub().resolves(null),
        save: sinon.stub().resolves(),
        clear: sinon.stub().resolves(),
      };
      const reportSink = {
        saveReport: sinon.stub().resolves({ report: {} as any, reportTxId: 'mock-arweave-tx-id' }),
      };
      const observer = createObserverForCatchUp({
        stateStore,
        reportSink,
      });
      (observer as any).prescribedNames = ['prescribed1', 'prescribed2'];
      (observer as any).chosenNames = ['chosen1'];
      const state: ObservationState = {
        epochIndex: 1,
        epochStartTimestamp,
        epochEndTimestamp,
        epochStartHeight,
        windowStart: Date.now() - 120_000,
        windowEnd: Date.now() - 1_000,
        pendingObservations: [
          {
            id: 'gateway1.example.com:0',
            fqdn: 'gateway1.example.com',
            scheduledAt: Date.now() - 10_000,
          },
          {
            id: 'gateway1.example.com:1',
            fqdn: 'gateway1.example.com',
            scheduledAt: Date.now() - 5_000,
          },
        ],
        gatewayObservations: new Map([
          [
            'gateway1.example.com',
            {
              fqdn: 'gateway1.example.com',
              wallet: 'wallet1',
              observations: [],
            },
          ],
        ]),
        gatewayWallets: new Map([['gateway1.example.com', ['wallet1']]]),
        offsetAssessmentGateways: new Set(),
        lastCycleTimestamp: Date.now(),
        reportSubmitted: false,
        submissionDeadlineExceeded: false,
      };
      const assessor = {
        assessOwnership: sinon.stub().resolves({
          expectedWallets: ['wallet1'],
          observedWallet: 'wallet1',
          pass: true,
        }),
        assessGatewayArns: sinon.stub().resolves({
          prescribedNames: {},
          chosenNames: {},
          pass: true,
        }),
        clearEpochState: sinon.stub(),
      };

      restoreState(observer, state);
      (observer as any).assessor = assessor;

      await (observer as any).runObservationCycle();

      expect(assessor.assessOwnership.callCount).to.equal(2);
      expect(
        state.gatewayObservations.get('gateway1.example.com')!.observations,
      ).to.have.length(2);
      expect(state.pendingObservations).to.be.empty;
      expect(state.reportSubmitted).to.be.true;
      expect(reportSink.saveReport.calledOnce).to.be.true;
    });

    it('retries overdue observations after window close before submitting', async function () {
      const stateStore = {
        load: sinon.stub().resolves(null),
        save: sinon.stub().resolves(),
        clear: sinon.stub().resolves(),
      };
      const reportSink = {
        saveReport: sinon.stub().resolves({ report: {} as any, reportTxId: 'mock-arweave-tx-id' }),
      };
      const observer = createObserverForCatchUp({
        stateStore,
        reportSink,
      });
      (observer as any).prescribedNames = ['prescribed1', 'prescribed2'];
      (observer as any).chosenNames = ['chosen1'];
      const state: ObservationState = {
        epochIndex: 1,
        epochStartTimestamp,
        epochEndTimestamp,
        epochStartHeight,
        windowStart: Date.now() - 120_000,
        windowEnd: Date.now() - 1_000,
        pendingObservations: [
          {
            id: 'gateway1.example.com:0',
            fqdn: 'gateway1.example.com',
            scheduledAt: Date.now() - 10_000,
          },
          {
            id: 'gateway2.example.com:0',
            fqdn: 'gateway2.example.com',
            scheduledAt: Date.now() - 5_000,
          },
        ],
        gatewayObservations: new Map([
          [
            'gateway1.example.com',
            {
              fqdn: 'gateway1.example.com',
              wallet: 'wallet1',
              observations: [],
            },
          ],
          [
            'gateway2.example.com',
            {
              fqdn: 'gateway2.example.com',
              wallet: 'wallet2',
              observations: [],
            },
          ],
        ]),
        gatewayWallets: new Map([
          ['gateway1.example.com', ['wallet1']],
          ['gateway2.example.com', ['wallet2']],
        ]),
        offsetAssessmentGateways: new Set(),
        lastCycleTimestamp: Date.now(),
        reportSubmitted: false,
        submissionDeadlineExceeded: false,
      };
      let gateway2FailuresRemaining = 1;
      const assessor = {
        assessOwnership: sinon
          .stub()
          .callsFake(async ({ host }: { host: string }) => {
            if (
              host === 'gateway2.example.com' &&
              gateway2FailuresRemaining > 0
            ) {
              gateway2FailuresRemaining -= 1;
              throw new Error('temporary failure');
            }

            return {
              expectedWallets:
                host === 'gateway1.example.com' ? ['wallet1'] : ['wallet2'],
              observedWallet:
                host === 'gateway1.example.com' ? 'wallet1' : 'wallet2',
              pass: true,
            };
          }),
        assessGatewayArns: sinon.stub().resolves({
          prescribedNames: {},
          chosenNames: {},
          pass: true,
        }),
        clearEpochState: sinon.stub(),
      };

      restoreState(observer, state);
      (observer as any).assessor = assessor;

      await (observer as any).runObservationCycle();

      expect(state.reportSubmitted).to.be.false;
      expect(state.pendingObservations).to.have.length(1);
      expect(reportSink.saveReport.called).to.be.false;

      await (observer as any).runObservationCycle();

      expect(state.pendingObservations).to.be.empty;
      expect(state.reportSubmitted).to.be.true;
      expect(reportSink.saveReport.calledOnce).to.be.true;
    });

    it('closes the epoch without submitting once the submission deadline is reached', async function () {
      const stateStore = {
        load: sinon.stub().resolves(null),
        save: sinon.stub().resolves(),
        clear: sinon.stub().resolves(),
      };
      const reportSink = {
        saveReport: sinon.stub().resolves({ report: {} as any, reportTxId: 'mock-arweave-tx-id' }),
      };
      const observer = createObserverForCatchUp({
        stateStore,
        reportSink,
      });
      const state: ObservationState = {
        epochIndex: 1,
        epochStartTimestamp,
        epochEndTimestamp,
        epochStartHeight,
        windowStart: Date.now() - 5_000_000,
        windowEnd: Date.now() - 5_000_000,
        pendingObservations: [
          {
            id: 'gateway1.example.com:0',
            fqdn: 'gateway1.example.com',
            scheduledAt: Date.now() - 5_100_000,
          },
        ],
        gatewayObservations: new Map([
          [
            'gateway1.example.com',
            {
              fqdn: 'gateway1.example.com',
              wallet: 'wallet1',
              observations: [],
            },
          ],
        ]),
        gatewayWallets: new Map([['gateway1.example.com', ['wallet1']]]),
        offsetAssessmentGateways: new Set(),
        lastCycleTimestamp: Date.now(),
        reportSubmitted: false,
        submissionDeadlineExceeded: false,
      };
      const assessor = {
        assessOwnership: sinon.stub().rejects(new Error('persistent failure')),
        assessGatewayArns: sinon.stub().resolves({
          prescribedNames: {},
          chosenNames: {},
          pass: true,
        }),
        clearEpochState: sinon.stub(),
      };

      restoreState(observer, state);
      (observer as any).assessor = assessor;

      await (observer as any).runObservationCycle();

      expect(state.pendingObservations).to.be.empty;
      expect(state.reportSubmitted).to.be.false;
      expect(state.submissionDeadlineExceeded).to.be.true;
      expect(reportSink.saveReport.called).to.be.false;
    });

    it('does not keep retrying after the submission deadline is reached', async function () {
      const stateStore = {
        load: sinon.stub().resolves(null),
        save: sinon.stub().resolves(),
        clear: sinon.stub().resolves(),
      };
      const reportSink = {
        saveReport: sinon.stub().resolves({ report: {} as any, reportTxId: 'mock-arweave-tx-id' }),
      };
      const observer = createObserverForCatchUp({
        stateStore,
        reportSink,
      });
      (observer as any).prescribedNames = ['prescribed1', 'prescribed2'];
      (observer as any).chosenNames = ['chosen1'];
      const state: ObservationState = {
        epochIndex: 1,
        epochStartTimestamp,
        epochEndTimestamp,
        epochStartHeight,
        windowStart: Date.now() - 5_000_000,
        windowEnd: Date.now() - 5_000_000,
        pendingObservations: [
          {
            id: 'gateway1.example.com:0',
            fqdn: 'gateway1.example.com',
            scheduledAt: Date.now() - 5_100_000,
          },
        ],
        gatewayObservations: new Map([
          [
            'gateway1.example.com',
            {
              fqdn: 'gateway1.example.com',
              wallet: 'wallet1',
              observations: [],
            },
          ],
        ]),
        gatewayWallets: new Map([['gateway1.example.com', ['wallet1']]]),
        offsetAssessmentGateways: new Set(),
        lastCycleTimestamp: Date.now(),
        reportSubmitted: false,
        submissionDeadlineExceeded: false,
      };
      const assessor = {
        assessOwnership: sinon.stub().rejects(new Error('persistent failure')),
        assessGatewayArns: sinon.stub().resolves({
          prescribedNames: {},
          chosenNames: {},
          pass: true,
        }),
        clearEpochState: sinon.stub(),
      };
      restoreState(observer, state);
      (observer as any).assessor = assessor;

      await (observer as any).runObservationCycle();

      const firstCallCount = assessor.assessOwnership.callCount;
      expect(state.submissionDeadlineExceeded).to.be.true;
      expect(firstCallCount).to.equal(0);
      expect(reportSink.saveReport.called).to.be.false;

      await (observer as any).runObservationCycle();

      expect(assessor.assessOwnership.callCount).to.equal(firstCallCount);
      expect(reportSink.saveReport.called).to.be.false;
    });

    it('does not run restored overdue observations after restart past the submission deadline', async function () {
      const deadlinePassedWindowEnd = Date.now() - 5_000_000;
      const state: ObservationState = {
        epochIndex: 1,
        epochStartTimestamp,
        epochEndTimestamp,
        epochStartHeight,
        windowStart: deadlinePassedWindowEnd - 60_000,
        windowEnd: deadlinePassedWindowEnd,
        pendingObservations: [
          {
            id: 'gateway1.example.com:0',
            fqdn: 'gateway1.example.com',
            scheduledAt: deadlinePassedWindowEnd - 120_000,
          },
        ],
        gatewayObservations: new Map([
          [
            'gateway1.example.com',
            {
              fqdn: 'gateway1.example.com',
              wallet: 'wallet1',
              observations: [],
            },
          ],
        ]),
        gatewayWallets: new Map([['gateway1.example.com', ['wallet1']]]),
        offsetAssessmentGateways: new Set(),
        lastCycleTimestamp: Date.now(),
        reportSubmitted: false,
        submissionDeadlineExceeded: false,
      };
      const stateStore = {
        load: sinon.stub().resolves(state),
        save: sinon.stub().resolves(),
        clear: sinon.stub().resolves(),
      };
      const reportSink = {
        saveReport: sinon.stub().resolves({ report: {} as any, reportTxId: 'mock-arweave-tx-id' }),
      };
      const observer = createObserverForCatchUp({
        stateStore,
        reportSink,
      });
      const assessor = {
        assessOwnership: sinon.stub().rejects(new Error('should not run')),
        assessGatewayArns: sinon.stub().resolves({
          prescribedNames: {},
          chosenNames: {},
          pass: true,
        }),
        initializeForEpoch: sinon.stub(),
        clearEpochState: sinon.stub(),
      };
      (observer as any).assessor = assessor;

      await (observer as any).initializeOrRestore();
      await (observer as any).runObservationCycle();

      expect(assessor.assessOwnership.called).to.be.false;
      expect(state.submissionDeadlineExceeded).to.be.true;
      expect(state.pendingObservations).to.be.empty;
      expect(stateStore.save.calledOnceWithExactly(state)).to.be.true;
      expect(reportSink.saveReport.called).to.be.false;
    });
  });

  describe('Majority Vote Logic', function () {
    it('should correctly determine pass with 2/3 passing observations', function () {
      // Simple majority vote logic test (extracted from aggregateObservations)
      const observations = [{ pass: true }, { pass: false }, { pass: true }];

      const passCount = observations.filter((o) => o.pass).length;
      const majorityThreshold = 2;
      const gatewayPass = passCount >= majorityThreshold;

      expect(gatewayPass).to.be.true;
    });

    it('should correctly determine fail with 1/3 passing observations', function () {
      const observations = [{ pass: false }, { pass: false }, { pass: true }];

      const passCount = observations.filter((o) => o.pass).length;
      const majorityThreshold = 2;
      const gatewayPass = passCount >= majorityThreshold;

      expect(gatewayPass).to.be.false;
    });

    it('should correctly determine fail with 0/3 passing observations', function () {
      const observations = [{ pass: false }, { pass: false }, { pass: false }];

      const passCount = observations.filter((o) => o.pass).length;
      const majorityThreshold = 2;
      const gatewayPass = passCount >= majorityThreshold;

      expect(gatewayPass).to.be.false;
    });

    it('should correctly determine pass with 3/3 passing observations', function () {
      const observations = [{ pass: true }, { pass: true }, { pass: true }];

      const passCount = observations.filter((o) => o.pass).length;
      const majorityThreshold = 2;
      const gatewayPass = passCount >= majorityThreshold;

      expect(gatewayPass).to.be.true;
    });
  });

  describe('Gateway Wallet Mapping', function () {
    it('should handle multiple wallets for same FQDN', function () {
      const hostsWithDuplicates: GatewayHost[] = [
        { fqdn: 'shared-gateway.com', wallet: 'wallet1' },
        { fqdn: 'shared-gateway.com', wallet: 'wallet2' },
        { fqdn: 'unique-gateway.com', wallet: 'wallet3' },
      ];

      // Build mapping (same logic as ContinuousObserver.initializeEpoch)
      const gatewayWallets = new Map<string, string[]>();
      for (const gateway of hostsWithDuplicates) {
        const existing = gatewayWallets.get(gateway.fqdn) ?? [];
        if (!existing.includes(gateway.wallet)) {
          existing.push(gateway.wallet);
        }
        gatewayWallets.set(gateway.fqdn, existing);
      }

      expect(gatewayWallets.get('shared-gateway.com')).to.deep.equal([
        'wallet1',
        'wallet2',
      ]);
      expect(gatewayWallets.get('unique-gateway.com')).to.deep.equal([
        'wallet3',
      ]);
    });

    it('should deduplicate duplicate wallet entries', function () {
      const hostsWithDuplicateWallets: GatewayHost[] = [
        { fqdn: 'gateway.com', wallet: 'wallet1' },
        { fqdn: 'gateway.com', wallet: 'wallet1' }, // Duplicate
        { fqdn: 'gateway.com', wallet: 'wallet2' },
      ];

      const gatewayWallets = new Map<string, string[]>();
      for (const gateway of hostsWithDuplicateWallets) {
        const existing = gatewayWallets.get(gateway.fqdn) ?? [];
        if (!existing.includes(gateway.wallet)) {
          existing.push(gateway.wallet);
        }
        gatewayWallets.set(gateway.fqdn, existing);
      }

      expect(gatewayWallets.get('gateway.com')).to.deep.equal([
        'wallet1',
        'wallet2',
      ]);
    });
  });

  describe('Window Timing Logic', function () {
    it('should correctly identify before window state', async function () {
      const scheduler = new ContinuousObservationScheduler({
        entropySource,
        log: testLog,
      });

      await scheduler.initializeEpoch({
        gateways,
        epochStartTimestamp,
        epochEndTimestamp,
        epochStartHeight,
      });

      // Time before window start
      expect(scheduler.isBeforeWindow(epochStartTimestamp)).to.be.true;
      expect(scheduler.isWindowComplete(epochStartTimestamp)).to.be.false;
    });

    it('should correctly identify within window state', async function () {
      const scheduler = new ContinuousObservationScheduler({
        entropySource,
        log: testLog,
      });

      const { windowStart, windowEnd } = await scheduler.initializeEpoch({
        gateways,
        epochStartTimestamp,
        epochEndTimestamp,
        epochStartHeight,
      });

      const midWindow = windowStart + (windowEnd - windowStart) / 2;
      expect(scheduler.isBeforeWindow(midWindow)).to.be.false;
      expect(scheduler.isWindowComplete(midWindow)).to.be.false;
    });

    it('should correctly identify after window state', async function () {
      const scheduler = new ContinuousObservationScheduler({
        entropySource,
        log: testLog,
      });

      const { windowEnd } = await scheduler.initializeEpoch({
        gateways,
        epochStartTimestamp,
        epochEndTimestamp,
        epochStartHeight,
      });

      expect(scheduler.isBeforeWindow(windowEnd + 1000)).to.be.false;
      expect(scheduler.isWindowComplete(windowEnd + 1000)).to.be.true;
    });
  });

  describe('Best Observation Selection', function () {
    it('should select passing observation over failing', function () {
      // Simulate selectBestObservation logic
      const observations = [
        { pass: false, observedAt: 1000 },
        { pass: true, observedAt: 2000 },
        { pass: false, observedAt: 3000 },
      ];

      const passing = observations.filter((o) => o.pass);
      const best =
        passing.length > 0
          ? passing[passing.length - 1]
          : observations[observations.length - 1];

      expect(best.pass).to.be.true;
      expect(best.observedAt).to.equal(2000);
    });

    it('should select most recent passing observation', function () {
      const observations = [
        { pass: true, observedAt: 1000 },
        { pass: true, observedAt: 2000 },
        { pass: false, observedAt: 3000 },
      ];

      const passing = observations.filter((o) => o.pass);
      const best =
        passing.length > 0
          ? passing[passing.length - 1]
          : observations[observations.length - 1];

      expect(best.observedAt).to.equal(2000);
    });

    it('should select most recent failing when all fail', function () {
      const observations = [
        { pass: false, observedAt: 1000 },
        { pass: false, observedAt: 2000 },
        { pass: false, observedAt: 3000 },
      ];

      const passing = observations.filter((o) => o.pass);
      const best =
        passing.length > 0
          ? passing[passing.length - 1]
          : observations[observations.length - 1];

      expect(best.observedAt).to.equal(3000);
    });
  });

  describe('Persistence + Submission Split', function () {
    // Exercises `finalizeAndSubmitReport` directly with a hand-rolled
    // observer so we can verify the two-phase semantics without
    // standing up the whole scheduler.
    function newObserver(opts: {
      persistenceSink: { saveReport: sinon.SinonStub };
      submissionSink?: { saveReport: sinon.SinonStub };
      submissionGate?: sinon.SinonStub;
    }): ContinuousObserver {
      const observer = new ContinuousObserver({
        observerAddress: 'observer-wallet',
        referenceGateway: {
          getArnsResolution: sinon.stub().rejects(new Error('unused')),
          checkChunkAvailability: sinon.stub().rejects(new Error('unused')),
          getChunkMetadata: sinon.stub().rejects(new Error('unused')),
        },
        epochSource: {
          getEpochIndex: sinon.stub().resolves(1),
          getEpochStartTimestamp: sinon.stub().resolves(epochStartTimestamp),
          getEpochEndTimestamp: sinon.stub().resolves(epochEndTimestamp),
          getEpochStartHeight: sinon.stub().resolves(epochStartHeight),
          getEpochSettings: sinon.stub().resolves({
            epochZeroStartTimestamp: 0,
            durationMs: epochEndTimestamp - epochStartTimestamp,
          }),
        },
        hostsSource: { getHosts: sinon.stub().resolves(gateways) },
        prescribedNamesSource: { getNames: sinon.stub().resolves([]) },
        chosenNamesSource: { getNames: sinon.stub().resolves([]) },
        entropySource,
        stateStore: {
          load: sinon.stub().resolves(null),
          save: sinon.stub().resolves(),
          clear: sinon.stub().resolves(),
        } as any,
        persistenceSink: opts.persistenceSink,
        submissionSink: opts.submissionSink,
        submissionGate: opts.submissionGate as any,
        nodeReleaseVersion: 'test-release',
        nameAssessmentConcurrency: 1,
        log: testLog,
      });
      // Minimal state so finalize doesn't trip the "not initialized" guard.
      (observer as any).state = {
        epochIndex: 7,
        epochStartTimestamp,
        epochEndTimestamp,
        epochStartHeight,
        windowStart: epochStartTimestamp,
        windowEnd: epochEndTimestamp,
        gatewayObservations: new Map(),
        gatewayWallets: new Map(),
        pendingObservations: [],
        prescribedNames: [],
        chosenNames: [],
        reportSubmitted: false,
        submissionDeadlineExceeded: false,
      };
      return observer;
    }

    function persistenceSinkStub(): { saveReport: sinon.SinonStub } {
      return {
        saveReport: sinon
          .stub()
          .callsFake(async (info: any) => ({ ...info, persistedLocally: true })),
      };
    }

    function submissionSinkStub(reportTxId = 'arweave-mock-tx'): {
      saveReport: sinon.SinonStub;
    } {
      return {
        saveReport: sinon
          .stub()
          .callsFake(async (info: any) => ({ ...info, reportTxId })),
      };
    }

    afterEach(() => sinon.restore());

    it('persistence always runs; submission runs when gate proceeds', async function () {
      const persistence = persistenceSinkStub();
      const submission = submissionSinkStub();
      const gate = sinon.stub().resolves({ proceed: true });
      const observer = newObserver({
        persistenceSink: persistence,
        submissionSink: submission,
        submissionGate: gate,
      });

      const submitted = await (observer as any).finalizeAndSubmitReport();

      expect(submitted).to.equal(true);
      expect(persistence.saveReport.calledOnce).to.be.true;
      expect(gate.calledOnce).to.be.true;
      expect(submission.saveReport.calledOnce).to.be.true;
      // Submission must receive the persistence-augmented info object
      // (so any sink-injected fields propagate downstream).
      expect(submission.saveReport.firstCall.args[0]).to.have.property(
        'persistedLocally',
        true,
      );
    });

    it('persistence runs but submission is SKIPPED when gate denies (not prescribed)', async function () {
      const persistence = persistenceSinkStub();
      const submission = submissionSinkStub();
      const gate = sinon.stub().resolves({
        proceed: false,
        reason: 'observer not prescribed for this epoch',
      });
      const observer = newObserver({
        persistenceSink: persistence,
        submissionSink: submission,
        submissionGate: gate,
      });

      const submitted = await (observer as any).finalizeAndSubmitReport();

      // `true` so the caller flips reportSubmitted and won't retry —
      // there's no on-chain pathway, retrying is pointless.
      expect(submitted).to.equal(true);
      expect(persistence.saveReport.calledOnce).to.be.true;
      expect(gate.calledOnce).to.be.true;
      expect(submission.saveReport.called).to.be.false;
    });

    it('gate threw → returns false (retry next cycle, do NOT submit)', async function () {
      // The whole point of the split: if we can't determine
      // prescription, don't burn credits on a Turbo upload we may not
      // be able to back with an on-chain tx.
      const persistence = persistenceSinkStub();
      const submission = submissionSinkStub();
      const gate = sinon.stub().rejects(new Error('RPC timeout'));
      const observer = newObserver({
        persistenceSink: persistence,
        submissionSink: submission,
        submissionGate: gate,
      });

      const submitted = await (observer as any).finalizeAndSubmitReport();

      expect(submitted).to.equal(false);
      expect(persistence.saveReport.calledOnce).to.be.true;
      expect(submission.saveReport.called).to.be.false;
    });

    it('no submission pipeline wired → persistence runs, returns true (terminal)', async function () {
      // Dev / dry-run setup with no Turbo + no contract submission.
      const persistence = persistenceSinkStub();
      const observer = newObserver({ persistenceSink: persistence });

      const submitted = await (observer as any).finalizeAndSubmitReport();

      expect(submitted).to.equal(true);
      expect(persistence.saveReport.calledOnce).to.be.true;
    });

    it('no gate but submission wired → submission always runs (legacy behavior)', async function () {
      // Back-compat path for setups that don't wire a Solana gate
      // (e.g. older AO configs where the contract itself rejected
      // non-prescribed submissions).
      const persistence = persistenceSinkStub();
      const submission = submissionSinkStub();
      const observer = newObserver({
        persistenceSink: persistence,
        submissionSink: submission,
      });

      const submitted = await (observer as any).finalizeAndSubmitReport();

      expect(submitted).to.equal(true);
      expect(persistence.saveReport.calledOnce).to.be.true;
      expect(submission.saveReport.calledOnce).to.be.true;
    });

    it('persistence sink threw → returns false (retry); submission must NOT run', async function () {
      const persistence = {
        saveReport: sinon.stub().rejects(new Error('disk full')),
      };
      const submission = submissionSinkStub();
      const gate = sinon.stub().resolves({ proceed: true });
      const observer = newObserver({
        persistenceSink: persistence,
        submissionSink: submission,
        submissionGate: gate,
      });

      const submitted = await (observer as any).finalizeAndSubmitReport();

      expect(submitted).to.equal(false);
      expect(gate.called).to.be.false;
      expect(submission.saveReport.called).to.be.false;
    });

    it('submission pipeline returned no reportTxId → returns false (retry)', async function () {
      // E.g. PipelineReportSink's 80%-failure threshold dropped the
      // report mid-submission, or a network blip swallowed in the
      // Turbo sink's catch.
      const persistence = persistenceSinkStub();
      const submission = {
        saveReport: sinon
          .stub()
          .callsFake(async (info: any) => info /* no reportTxId */),
      };
      const gate = sinon.stub().resolves({ proceed: true });
      const observer = newObserver({
        persistenceSink: persistence,
        submissionSink: submission,
        submissionGate: gate,
      });

      const submitted = await (observer as any).finalizeAndSubmitReport();

      expect(submitted).to.equal(false);
      expect(persistence.saveReport.calledOnce).to.be.true;
      expect(submission.saveReport.calledOnce).to.be.true;
    });

    it('gate is called with the same report that submission sees', async function () {
      const persistence = persistenceSinkStub();
      const submission = submissionSinkStub();
      const gate = sinon.stub().resolves({ proceed: true });
      const observer = newObserver({
        persistenceSink: persistence,
        submissionSink: submission,
        submissionGate: gate,
      });

      await (observer as any).finalizeAndSubmitReport();

      const gateArg = gate.firstCall.args[0];
      const submissionArg = submission.saveReport.firstCall.args[0];
      // Both look at the same epoch + observer identity.
      expect(gateArg.epochIndex).to.equal(submissionArg.report.epochIndex);
      expect(gateArg.observerAddress).to.equal(
        submissionArg.report.observerAddress,
      );
    });
  });

  describe('Prescribed-Name Lazy Load (prescribe_epoch race)', function () {
    // Exercises the deferred name-load path. The cranker calls
    // `prescribe_epoch` ~30-60s AFTER `create_epoch` (it has to wait
    // on `tally_weights` to finish first). Eagerly reading prescribed
    // names at epoch-detection time always returned []. The observer
    // now retries each cycle until the cranker has run.

    function newLazyLoadObserver(opts: {
      prescribedNamesSource: { getNames: sinon.SinonStub };
      chosenNamesSource: { getNames: sinon.SinonStub };
      assessor?: any;
    }): ContinuousObserver {
      const observer = new ContinuousObserver({
        observerAddress: 'observer-wallet',
        referenceGateway: {
          getArnsResolution: sinon.stub().rejects(new Error('unused')),
          checkChunkAvailability: sinon.stub().rejects(new Error('unused')),
          getChunkMetadata: sinon.stub().rejects(new Error('unused')),
        },
        epochSource: {
          getEpochIndex: sinon.stub().resolves(1),
          getEpochStartTimestamp: sinon.stub().resolves(epochStartTimestamp),
          getEpochEndTimestamp: sinon.stub().resolves(epochEndTimestamp),
          getEpochStartHeight: sinon.stub().resolves(epochStartHeight),
          getEpochSettings: sinon.stub().resolves({
            epochZeroStartTimestamp: 0,
            durationMs: epochEndTimestamp - epochStartTimestamp,
          }),
        },
        hostsSource: { getHosts: sinon.stub().resolves(gateways) },
        prescribedNamesSource: opts.prescribedNamesSource,
        chosenNamesSource: opts.chosenNamesSource,
        entropySource,
        stateStore: {
          load: sinon.stub().resolves(null),
          save: sinon.stub().resolves(),
          clear: sinon.stub().resolves(),
        } as any,
        persistenceSink: { saveReport: sinon.stub().resolves({}) },
        nodeReleaseVersion: 'test-release',
        nameAssessmentConcurrency: 1,
        log: testLog,
      });
      // Minimal state — past the epoch transition check but BEFORE the
      // observation window opens, so the cycle exits after the lazy
      // load attempt without trying to schedule any work.
      (observer as any).state = {
        epochIndex: 1,
        epochStartTimestamp,
        epochEndTimestamp,
        epochStartHeight,
        // Window in the future → `isBeforeWindow` returns true → cycle
        // returns early after the load attempt, so we can assert
        // purely on the prescribedNamesSource call count.
        windowStart: Date.now() + 60_000,
        windowEnd: Date.now() + 120_000,
        gatewayObservations: new Map(),
        gatewayWallets: new Map(),
        pendingObservations: [],
        prescribedNames: [],
        chosenNames: [],
        reportSubmitted: false,
        submissionDeadlineExceeded: false,
      };
      if (opts.assessor) (observer as any).assessor = opts.assessor;
      return observer;
    }

    afterEach(() => sinon.restore());

    it('does NOT load names at epoch construction (defers to cycle)', async function () {
      const prescribedNamesSource = {
        getNames: sinon.stub().resolves(['p1', 'p2']),
      };
      const chosenNamesSource = {
        getNames: sinon.stub().resolves(['c1']),
      };
      newLazyLoadObserver({ prescribedNamesSource, chosenNamesSource });
      // Construction alone must not have triggered a load — that was
      // the eager path that raced the cranker.
      expect(prescribedNamesSource.getNames.called).to.equal(false);
      expect(chosenNamesSource.getNames.called).to.equal(false);
    });

    it('skips the cycle and re-tries when prescribed names is empty (pre-prescribe_epoch)', async function () {
      const prescribedNamesSource = {
        getNames: sinon.stub().resolves([]), // cranker hasn't run yet
      };
      const chosenNamesSource = {
        getNames: sinon.stub().resolves(['c1', 'c2']),
      };
      const assessor = {
        initializeForEpoch: sinon.stub(),
        assessOwnership: sinon.stub(),
        assessGatewayArns: sinon.stub(),
        clearEpochState: sinon.stub(),
      };
      const observer = newLazyLoadObserver({
        prescribedNamesSource,
        chosenNamesSource,
        assessor,
      });

      await (observer as any).runObservationCycle();
      await (observer as any).runObservationCycle();
      await (observer as any).runObservationCycle();

      // Each cycle retries the prescribed read; chosen is never
      // fetched while prescribed is empty (would otherwise burn a
      // RandomArnsNamesSource entropy read on stale state).
      expect(prescribedNamesSource.getNames.callCount).to.equal(3);
      expect(chosenNamesSource.getNames.called).to.equal(false);
      expect(assessor.initializeForEpoch.called).to.equal(false);
      expect((observer as any).prescribedNamesReady).to.equal(false);
    });

    it('initializes assessor + flips ready once prescribed names land', async function () {
      const prescribedNamesSource = {
        getNames: sinon
          .stub()
          .onFirstCall()
          .resolves([]) // pre-prescribe
          .onSecondCall()
          .resolves(['p1', 'p2']), // post-prescribe
      };
      const chosenNamesSource = {
        getNames: sinon.stub().resolves(['c1', 'c2', 'c3']),
      };
      const assessor = {
        initializeForEpoch: sinon.stub(),
        assessOwnership: sinon.stub(),
        assessGatewayArns: sinon.stub(),
        clearEpochState: sinon.stub(),
      };
      const observer = newLazyLoadObserver({
        prescribedNamesSource,
        chosenNamesSource,
        assessor,
      });

      await (observer as any).runObservationCycle();
      expect((observer as any).prescribedNamesReady).to.equal(false);

      await (observer as any).runObservationCycle();
      expect((observer as any).prescribedNamesReady).to.equal(true);
      expect((observer as any).prescribedNames).to.deep.equal(['p1', 'p2']);
      expect((observer as any).chosenNames).to.deep.equal(['c1', 'c2', 'c3']);
      expect(assessor.initializeForEpoch.calledOnce).to.equal(true);
      // namesCount = prescribed + chosen
      expect(
        assessor.initializeForEpoch.firstCall.args[0].namesCount,
      ).to.equal(5);

      // Third cycle — flag is already set, no re-fetch.
      await (observer as any).runObservationCycle();
      expect(prescribedNamesSource.getNames.callCount).to.equal(2);
      expect(assessor.initializeForEpoch.callCount).to.equal(1);
    });
  });
});
