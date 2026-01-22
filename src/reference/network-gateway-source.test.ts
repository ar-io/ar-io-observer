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
import * as winston from 'winston';

import * as metrics from '../metrics.js';
import { CachedNetworkGatewaySource } from './network-gateway-source.js';

describe('CachedNetworkGatewaySource', function () {
  let logStub: winston.Logger;
  let mockContract: any;
  let eligibleGatewaysGaugeStub: sinon.SinonStub;

  const defaultConfig = {
    minPassRate: 0.8,
    minConsecutivePasses: 2,
    minEpochCount: 5,
    maxCount: 10,
    cacheTtlSeconds: 3600, // 1 hour
  };

  const createGateway = (overrides: any = {}) => ({
    gatewayAddress: overrides.gatewayAddress ?? 'gateway-wallet-1',
    settings: {
      fqdn: overrides.fqdn ?? 'gateway1.example.com',
      protocol: overrides.protocol ?? 'https',
      port: overrides.port ?? 443,
    },
    stats: {
      totalEpochCount: overrides.totalEpochCount ?? 10,
      passedEpochCount: overrides.passedEpochCount ?? 9,
      passedConsecutiveEpochs: overrides.passedConsecutiveEpochs ?? 5,
    },
    ...overrides,
  });

  beforeEach(function () {
    logStub = {
      child: sinon.stub().returnsThis(),
      debug: sinon.stub(),
      verbose: sinon.stub(),
      warn: sinon.stub(),
      error: sinon.stub(),
    } as any;

    mockContract = {
      getGateways: sinon.stub(),
    };

    eligibleGatewaysGaugeStub = sinon.stub(
      metrics.networkEligibleGatewaysGauge,
      'set',
    );
  });

  afterEach(function () {
    sinon.restore();
  });

  describe('getEligibleGateways', function () {
    it('should return gateways that meet all criteria', async function () {
      mockContract.getGateways.resolves({
        items: [
          createGateway({
            fqdn: 'good1.example.com',
            gatewayAddress: 'wallet1',
            totalEpochCount: 10,
            passedEpochCount: 9,
            passedConsecutiveEpochs: 5,
          }),
          createGateway({
            fqdn: 'good2.example.com',
            gatewayAddress: 'wallet2',
            totalEpochCount: 20,
            passedEpochCount: 18,
            passedConsecutiveEpochs: 10,
          }),
        ],
        nextCursor: undefined,
      });

      const source = new CachedNetworkGatewaySource({
        contract: mockContract,
        config: defaultConfig,
        log: logStub,
      });

      const gateways = await source.getEligibleGateways({});

      expect(gateways).to.have.length(2);
      expect(gateways[0].fqdn).to.equal('good2.example.com'); // Higher pass rate first
      expect(gateways[1].fqdn).to.equal('good1.example.com');
    });

    it('should filter out gateways without FQDN', async function () {
      mockContract.getGateways.resolves({
        items: [
          createGateway({ fqdn: 'valid.example.com' }),
          { ...createGateway(), settings: { protocol: 'https', port: 443 } }, // No FQDN
        ],
        nextCursor: undefined,
      });

      const source = new CachedNetworkGatewaySource({
        contract: mockContract,
        config: defaultConfig,
        log: logStub,
      });

      const gateways = await source.getEligibleGateways({});

      expect(gateways).to.have.length(1);
      expect(gateways[0].fqdn).to.equal('valid.example.com');
    });

    it('should filter out non-HTTPS gateways', async function () {
      mockContract.getGateways.resolves({
        items: [
          createGateway({ fqdn: 'https.example.com', protocol: 'https' }),
          createGateway({ fqdn: 'http.example.com', protocol: 'http' }),
        ],
        nextCursor: undefined,
      });

      const source = new CachedNetworkGatewaySource({
        contract: mockContract,
        config: defaultConfig,
        log: logStub,
      });

      const gateways = await source.getEligibleGateways({});

      expect(gateways).to.have.length(1);
      expect(gateways[0].fqdn).to.equal('https.example.com');
    });

    it('should filter out gateways with low epoch count', async function () {
      mockContract.getGateways.resolves({
        items: [
          createGateway({
            fqdn: 'enough.example.com',
            totalEpochCount: 10,
            passedEpochCount: 9,
          }),
          createGateway({
            fqdn: 'notenough.example.com',
            totalEpochCount: 3, // Below minEpochCount of 5
            passedEpochCount: 3,
          }),
        ],
        nextCursor: undefined,
      });

      const source = new CachedNetworkGatewaySource({
        contract: mockContract,
        config: defaultConfig,
        log: logStub,
      });

      const gateways = await source.getEligibleGateways({});

      expect(gateways).to.have.length(1);
      expect(gateways[0].fqdn).to.equal('enough.example.com');
    });

    it('should filter out gateways with low pass rate', async function () {
      mockContract.getGateways.resolves({
        items: [
          createGateway({
            fqdn: 'highpass.example.com',
            totalEpochCount: 10,
            passedEpochCount: 9, // 90% pass rate
          }),
          createGateway({
            fqdn: 'lowpass.example.com',
            totalEpochCount: 10,
            passedEpochCount: 5, // 50% pass rate
          }),
        ],
        nextCursor: undefined,
      });

      const source = new CachedNetworkGatewaySource({
        contract: mockContract,
        config: defaultConfig,
        log: logStub,
      });

      const gateways = await source.getEligibleGateways({});

      expect(gateways).to.have.length(1);
      expect(gateways[0].fqdn).to.equal('highpass.example.com');
    });

    it('should filter out gateways with insufficient consecutive passes', async function () {
      mockContract.getGateways.resolves({
        items: [
          createGateway({
            fqdn: 'consistent.example.com',
            passedConsecutiveEpochs: 5,
          }),
          createGateway({
            fqdn: 'inconsistent.example.com',
            passedConsecutiveEpochs: 1, // Below minConsecutivePasses of 2
          }),
        ],
        nextCursor: undefined,
      });

      const source = new CachedNetworkGatewaySource({
        contract: mockContract,
        config: defaultConfig,
        log: logStub,
      });

      const gateways = await source.getEligibleGateways({});

      expect(gateways).to.have.length(1);
      expect(gateways[0].fqdn).to.equal('consistent.example.com');
    });

    it('should exclude specified FQDNs', async function () {
      mockContract.getGateways.resolves({
        items: [
          createGateway({ fqdn: 'keep.example.com' }),
          createGateway({ fqdn: 'exclude.example.com' }),
        ],
        nextCursor: undefined,
      });

      const source = new CachedNetworkGatewaySource({
        contract: mockContract,
        config: defaultConfig,
        log: logStub,
      });

      const gateways = await source.getEligibleGateways({
        excludeFqdns: ['exclude.example.com'],
      });

      expect(gateways).to.have.length(1);
      expect(gateways[0].fqdn).to.equal('keep.example.com');
    });

    it('should respect maxCount parameter', async function () {
      mockContract.getGateways.resolves({
        items: [
          createGateway({ fqdn: 'g1.example.com', gatewayAddress: 'w1' }),
          createGateway({ fqdn: 'g2.example.com', gatewayAddress: 'w2' }),
          createGateway({ fqdn: 'g3.example.com', gatewayAddress: 'w3' }),
        ],
        nextCursor: undefined,
      });

      const source = new CachedNetworkGatewaySource({
        contract: mockContract,
        config: defaultConfig,
        log: logStub,
      });

      const gateways = await source.getEligibleGateways({ maxCount: 2 });

      expect(gateways).to.have.length(2);
    });

    it('should use cached gateways within TTL', async function () {
      mockContract.getGateways.resolves({
        items: [createGateway({ fqdn: 'cached.example.com' })],
        nextCursor: undefined,
      });

      const source = new CachedNetworkGatewaySource({
        contract: mockContract,
        config: defaultConfig,
        log: logStub,
      });

      // First call - populates cache
      await source.getEligibleGateways({});

      // Second call - should use cache
      await source.getEligibleGateways({});

      expect(mockContract.getGateways.calledOnce).to.be.true;
    });

    it('should handle pagination', async function () {
      mockContract.getGateways
        .onFirstCall()
        .resolves({
          items: [createGateway({ fqdn: 'page1.example.com' })],
          nextCursor: 'cursor1',
        })
        .onSecondCall()
        .resolves({
          items: [createGateway({ fqdn: 'page2.example.com' })],
          nextCursor: undefined,
        });

      const source = new CachedNetworkGatewaySource({
        contract: mockContract,
        config: defaultConfig,
        log: logStub,
      });

      const gateways = await source.getEligibleGateways({});

      expect(gateways).to.have.length(2);
      expect(mockContract.getGateways.calledTwice).to.be.true;
    });
  });

  describe('markUnresponsive', function () {
    it('should skip unresponsive gateways in subsequent selections', async function () {
      mockContract.getGateways.resolves({
        items: [
          createGateway({ fqdn: 'responsive.example.com' }),
          createGateway({ fqdn: 'unresponsive.example.com' }),
        ],
        nextCursor: undefined,
      });

      const source = new CachedNetworkGatewaySource({
        contract: mockContract,
        config: defaultConfig,
        log: logStub,
      });

      // First call to populate cache
      let gateways = await source.getEligibleGateways({});
      expect(gateways).to.have.length(2);

      // Mark as unresponsive after cache is populated
      source.markUnresponsive('unresponsive.example.com');

      // Second call should skip unresponsive gateway (cache still valid)
      gateways = await source.getEligibleGateways({});

      expect(gateways).to.have.length(1);
      expect(gateways[0].fqdn).to.equal('responsive.example.com');
    });
  });

  describe('stale-while-error', function () {
    it('should use stale cache if refresh fails', async function () {
      const source = new CachedNetworkGatewaySource({
        contract: mockContract,
        config: { ...defaultConfig, cacheTtlSeconds: 0 }, // Immediately stale
        log: logStub,
      });

      // First call succeeds
      mockContract.getGateways.resolves({
        items: [createGateway({ fqdn: 'cached.example.com' })],
        nextCursor: undefined,
      });

      await source.getEligibleGateways({});

      // Second call fails
      mockContract.getGateways.rejects(new Error('Network error'));

      // Should still return cached data
      const gateways = await source.getEligibleGateways({});

      expect(gateways).to.have.length(1);
      expect(gateways[0].fqdn).to.equal('cached.example.com');
    });

    it('should throw if no cache exists and refresh fails', async function () {
      mockContract.getGateways.rejects(new Error('Network error'));

      const source = new CachedNetworkGatewaySource({
        contract: mockContract,
        config: defaultConfig,
        log: logStub,
      });

      try {
        await source.getEligibleGateways({});
        expect.fail('Should have thrown');
      } catch (error: any) {
        expect(error.message).to.equal('Network error');
      }
    });
  });

  describe('cache refresh', function () {
    it('should clear unresponsive list when cache refreshes', async function () {
      // Use a short but non-zero TTL to control refresh timing
      const source = new CachedNetworkGatewaySource({
        contract: mockContract,
        config: { ...defaultConfig, cacheTtlSeconds: 1 }, // 1 second TTL
        log: logStub,
      });

      // First call - populates cache
      mockContract.getGateways.resolves({
        items: [
          createGateway({ fqdn: 'g1.example.com' }),
          createGateway({ fqdn: 'g2.example.com' }),
        ],
        nextCursor: undefined,
      });

      await source.getEligibleGateways({});
      source.markUnresponsive('g2.example.com');

      // Verify g2 is excluded (cache still valid)
      let gateways = await source.getEligibleGateways({});
      expect(gateways).to.have.length(1);
      expect(gateways[0].fqdn).to.equal('g1.example.com');

      // Wait for cache to expire
      await new Promise((resolve) => setTimeout(resolve, 1100));

      // Cache should refresh and clear unresponsive list
      gateways = await source.getEligibleGateways({});
      expect(gateways).to.have.length(2);
    });
  });

  describe('metrics', function () {
    it('should update eligible gateways gauge', async function () {
      mockContract.getGateways.resolves({
        items: [
          createGateway({ fqdn: 'g1.example.com' }),
          createGateway({ fqdn: 'g2.example.com' }),
          createGateway({ fqdn: 'g3.example.com' }),
        ],
        nextCursor: undefined,
      });

      const source = new CachedNetworkGatewaySource({
        contract: mockContract,
        config: defaultConfig,
        log: logStub,
      });

      await source.getEligibleGateways({});

      expect(eligibleGatewaysGaugeStub.calledWith(3)).to.be.true;
    });
  });
});
