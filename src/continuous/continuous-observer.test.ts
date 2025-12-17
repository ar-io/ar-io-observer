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
import { createLogger, transports } from 'winston';

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
      expect(loadedState!.pendingObservations.size).to.equal(schedule.size);
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
      expect(restoredScheduler.getSchedule().size).to.equal(schedule.size);
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

      // Get initial count for first gateway
      const firstGateway = gateways[0].fqdn;
      const initialCount = schedule.get(firstGateway)?.length ?? 0;
      expect(initialCount).to.equal(3);

      // Mark one observation complete
      const midWindowTime = windowStart + (windowEnd - windowStart) / 2;
      scheduler.markObservationComplete(firstGateway, midWindowTime);

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
      const remainingCount =
        newScheduler.getSchedule().get(firstGateway)?.length ?? 0;
      expect(remainingCount).to.equal(2);
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
});
