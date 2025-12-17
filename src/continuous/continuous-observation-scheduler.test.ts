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

const testLog = createLogger({
  level: 'error',
  transports: new transports.Console(),
});

class MockEntropySource implements EntropySource {
  private entropy: Buffer;

  constructor(entropy: Buffer) {
    this.entropy = entropy;
  }

  async getEntropy(): Promise<Buffer> {
    return this.entropy;
  }
}

describe('ContinuousObservationScheduler', function () {
  const entropy = Buffer.from('test-entropy-for-scheduler');
  const entropySource = new MockEntropySource(entropy);

  const gateways: GatewayHost[] = [
    { fqdn: 'gateway1.example.com', wallet: 'wallet1' },
    { fqdn: 'gateway2.example.com', wallet: 'wallet2' },
    { fqdn: 'gateway3.example.com', wallet: 'wallet3' },
  ];

  // 24-hour epoch
  const epochStartTimestamp = Date.now();
  const epochEndTimestamp = epochStartTimestamp + 24 * 60 * 60 * 1000;
  const epochStartHeight = 1000;

  describe('initializeEpoch', function () {
    it('should calculate window within stability and submission buffers', async function () {
      const scheduler = new ContinuousObservationScheduler({
        entropySource,
        config: {
          observationsPerGateway: 3,
          windowFraction: 0.5,
          stabilityBufferMs: 36 * 60 * 1000,
          submissionBufferMs: 72 * 60 * 1000,
        },
        log: testLog,
      });

      const { windowStart, windowEnd } = await scheduler.initializeEpoch({
        gateways,
        epochStartTimestamp,
        epochEndTimestamp,
        epochStartHeight,
      });

      // Window should start after stability buffer
      expect(windowStart).to.be.at.least(epochStartTimestamp + 36 * 60 * 1000);

      // Window should end before submission buffer
      expect(windowEnd).to.be.at.most(epochEndTimestamp - 72 * 60 * 1000);

      // Window length should be 50% of epoch
      const windowLength = windowEnd - windowStart;
      const epochDuration = epochEndTimestamp - epochStartTimestamp;
      expect(windowLength).to.equal(epochDuration * 0.5);
    });

    it('should generate deterministic schedule from same entropy', async function () {
      const scheduler1 = new ContinuousObservationScheduler({
        entropySource,
        log: testLog,
      });

      const scheduler2 = new ContinuousObservationScheduler({
        entropySource,
        log: testLog,
      });

      const result1 = await scheduler1.initializeEpoch({
        gateways,
        epochStartTimestamp,
        epochEndTimestamp,
        epochStartHeight,
      });

      const result2 = await scheduler2.initializeEpoch({
        gateways,
        epochStartTimestamp,
        epochEndTimestamp,
        epochStartHeight,
      });

      // Same entropy should produce same window
      expect(result1.windowStart).to.equal(result2.windowStart);
      expect(result1.windowEnd).to.equal(result2.windowEnd);

      // Same schedule for each gateway
      for (const gateway of gateways) {
        const times1 = result1.schedule.get(gateway.fqdn);
        const times2 = result2.schedule.get(gateway.fqdn);
        expect(times1).to.deep.equal(times2);
      }
    });

    it('should schedule correct number of observations per gateway', async function () {
      const observationsPerGateway = 3;
      const scheduler = new ContinuousObservationScheduler({
        entropySource,
        config: { observationsPerGateway },
        log: testLog,
      });

      const { schedule } = await scheduler.initializeEpoch({
        gateways,
        epochStartTimestamp,
        epochEndTimestamp,
        epochStartHeight,
      });

      for (const gateway of gateways) {
        const times = schedule.get(gateway.fqdn);
        expect(times).to.have.length(observationsPerGateway);
      }
    });
  });

  describe('getGatewaysDue', function () {
    it('should return empty array before window starts', async function () {
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

      const due = scheduler.getGatewaysDue(epochStartTimestamp);
      expect(due).to.be.an('array').that.is.empty;
    });

    it('should return empty array after window ends', async function () {
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

      const due = scheduler.getGatewaysDue(epochEndTimestamp);
      expect(due).to.be.an('array').that.is.empty;
    });

    it('should return gateways with passed scheduled times', async function () {
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

      // Check at end of window - all observations should be due
      const due = scheduler.getGatewaysDue(windowEnd - 1);
      expect(due.length).to.be.greaterThan(0);
    });
  });

  describe('markObservationComplete', function () {
    it('should remove completed observation from schedule', async function () {
      const scheduler = new ContinuousObservationScheduler({
        entropySource,
        config: { observationsPerGateway: 3 },
        log: testLog,
      });

      await scheduler.initializeEpoch({
        gateways,
        epochStartTimestamp,
        epochEndTimestamp,
        epochStartHeight,
      });

      const fqdn = gateways[0].fqdn;
      const initialCount = scheduler.getSchedule().get(fqdn)?.length ?? 0;

      // Mark one observation complete
      scheduler.markObservationComplete(fqdn, Date.now() + 10 * 60 * 60 * 1000);

      const newCount = scheduler.getSchedule().get(fqdn)?.length ?? 0;
      expect(newCount).to.equal(initialCount - 1);
    });
  });
});
