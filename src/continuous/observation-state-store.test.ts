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
import fs from 'node:fs';
import path from 'node:path';
import { createLogger, transports } from 'winston';

import { FsObservationStateStore } from './observation-state-store.js';
import { ObservationState } from './types.js';

const testLog = createLogger({
  level: 'error',
  transports: new transports.Console(),
});

describe('FsObservationStateStore', function () {
  const testDir = './data/test';
  const testStatePath = path.join(testDir, 'test-observation-state.json');

  beforeEach(async function () {
    // Ensure test directory exists
    await fs.promises.mkdir(testDir, { recursive: true });

    // Clean up any existing test file
    try {
      await fs.promises.unlink(testStatePath);
    } catch {
      // Ignore if file doesn't exist
    }
  });

  afterEach(async function () {
    // Clean up test file
    try {
      await fs.promises.unlink(testStatePath);
    } catch {
      // Ignore if file doesn't exist
    }
  });

  function createTestState(): ObservationState {
    return {
      epochIndex: 42,
      epochStartTimestamp: Date.now() - 60 * 60 * 1000,
      epochEndTimestamp: Date.now() + 23 * 60 * 60 * 1000,
      epochStartHeight: 1000,
      windowStart: Date.now(),
      windowEnd: Date.now() + 12 * 60 * 60 * 1000,
      pendingObservations: [
        {
          id: 'gateway1.example.com:0',
          fqdn: 'gateway1.example.com',
          scheduledAt: Date.now() + 1000,
        },
        {
          id: 'gateway1.example.com:1',
          fqdn: 'gateway1.example.com',
          scheduledAt: Date.now() + 2000,
        },
        {
          id: 'gateway2.example.com:0',
          fqdn: 'gateway2.example.com',
          scheduledAt: Date.now() + 3000,
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
      gatewayWallets: new Map([
        ['gateway1.example.com', ['wallet1']],
        ['gateway2.example.com', ['wallet2']],
      ]),
      offsetAssessmentGateways: new Set(['gateway1.example.com']),
      lastCycleTimestamp: Date.now(),
      reportSubmitted: false,
    };
  }

  describe('save', function () {
    it('should write state to JSON file', async function () {
      const store = new FsObservationStateStore({
        statePath: testStatePath,
        log: testLog,
      });

      const state = createTestState();
      await store.save(state);

      // Verify file exists
      const exists = await fs.promises
        .access(testStatePath)
        .then(() => true)
        .catch(() => false);
      expect(exists).to.be.true;

      // Verify content is valid JSON
      const content = await fs.promises.readFile(testStatePath, 'utf-8');
      const parsed = JSON.parse(content);
      expect(parsed.epochIndex).to.equal(state.epochIndex);
    });
  });

  describe('load', function () {
    it('should return null when file does not exist', async function () {
      const store = new FsObservationStateStore({
        statePath: testStatePath,
        log: testLog,
      });

      const result = await store.load();
      expect(result).to.be.null;
    });

    it('should parse and restore Map structures', async function () {
      const store = new FsObservationStateStore({
        statePath: testStatePath,
        log: testLog,
      });

      const originalState = createTestState();
      await store.save(originalState);

      const loadedState = await store.load();

      expect(loadedState).to.not.be.null;
      expect(loadedState!.epochIndex).to.equal(originalState.epochIndex);
      expect(loadedState!.windowStart).to.equal(originalState.windowStart);
      expect(loadedState!.windowEnd).to.equal(originalState.windowEnd);

      // Verify collection structures are restored
      expect(loadedState!.pendingObservations).to.be.an('array');
      expect(loadedState!.gatewayObservations).to.be.instanceOf(Map);
      expect(loadedState!.gatewayWallets).to.be.instanceOf(Map);
      expect(loadedState!.offsetAssessmentGateways).to.be.instanceOf(Set);

      // Verify content is preserved
      expect(loadedState!.pendingObservations).to.deep.equal(
        originalState.pendingObservations,
      );
    });

    it('should migrate legacy pending observation tuples', async function () {
      const store = new FsObservationStateStore({
        statePath: testStatePath,
        log: testLog,
      });

      await fs.promises.writeFile(
        testStatePath,
        JSON.stringify({
          epochIndex: 42,
          epochStartTimestamp: 100,
          epochEndTimestamp: 200,
          epochStartHeight: 1000,
          windowStart: 110,
          windowEnd: 150,
          pendingObservations: [
            ['gateway2.example.com', [140]],
            ['gateway1.example.com', [120, 130]],
          ],
          gatewayObservations: [],
          gatewayWallets: [],
          offsetAssessmentGateways: [],
          lastCycleTimestamp: 123,
          reportSubmitted: false,
        }),
      );

      const loadedState = await store.load();

      expect(loadedState).to.not.be.null;
      expect(loadedState!.pendingObservations).to.deep.equal([
        {
          id: 'gateway1.example.com:0',
          fqdn: 'gateway1.example.com',
          scheduledAt: 120,
        },
        {
          id: 'gateway1.example.com:1',
          fqdn: 'gateway1.example.com',
          scheduledAt: 130,
        },
        {
          id: 'gateway2.example.com:0',
          fqdn: 'gateway2.example.com',
          scheduledAt: 140,
        },
      ]);
    });
  });

  describe('clear', function () {
    it('should remove state file', async function () {
      const store = new FsObservationStateStore({
        statePath: testStatePath,
        log: testLog,
      });

      // Save state first
      await store.save(createTestState());

      // Verify file exists
      let exists = await fs.promises
        .access(testStatePath)
        .then(() => true)
        .catch(() => false);
      expect(exists).to.be.true;

      // Clear state
      await store.clear();

      // Verify file is removed
      exists = await fs.promises
        .access(testStatePath)
        .then(() => true)
        .catch(() => false);
      expect(exists).to.be.false;
    });

    it('should not throw when file does not exist', async function () {
      const store = new FsObservationStateStore({
        statePath: testStatePath,
        log: testLog,
      });

      // Should not throw
      await store.clear();
    });
  });
});
