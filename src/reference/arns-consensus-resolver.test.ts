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
import nock from 'nock';
import * as sinon from 'sinon';
import * as winston from 'winston';

import * as metrics from '../metrics.js';
import { NetworkGateway, NetworkGatewaySource } from '../types.js';
import { DefaultArnsConsensusResolver } from './arns-consensus-resolver.js';

describe('DefaultArnsConsensusResolver', function () {
  let logStub: winston.Logger;
  let mockNetworkGatewaySource: NetworkGatewaySource;
  let getEligibleGatewaysStub: sinon.SinonStub;
  let consensusHistogramStub: sinon.SinonStub;
  let markUnresponsiveStub: sinon.SinonStub;

  const entropy = Buffer.from('test-entropy');
  const defaultResolvedId = 'test-resolved-id';
  const defaultTtlSeconds = '300';

  const createGateway = (fqdn: string): NetworkGateway => ({
    fqdn,
    protocol: 'https',
    port: 443,
    gatewayAddress: `wallet-${fqdn}`,
    passRate: 0.9,
    passedConsecutiveEpochs: 5,
  });

  const setupSuccessfulResponse = (fqdn: string, resolvedId?: string) => {
    const data = Buffer.alloc(100, 'a').toString();
    const id = resolvedId ?? defaultResolvedId;

    nock(`https://testname.${fqdn}`)
      .head('/')
      .reply(200, undefined, {
        'Content-Type': 'application/octet-stream',
        'x-arns-resolved-id': id,
        'x-arns-ttl-seconds': defaultTtlSeconds,
        'Content-Length': String(data.length),
      });
    nock(`https://testname.${fqdn}`)
      .get('/')
      .reply(200, data, {
        'Content-Type': 'application/octet-stream',
        'x-arns-resolved-id': id,
        'x-arns-ttl-seconds': defaultTtlSeconds,
        'Content-Length': String(data.length),
      });
  };

  beforeEach(function () {
    nock.cleanAll();

    logStub = {
      child: sinon.stub().returnsThis(),
      debug: sinon.stub(),
      verbose: sinon.stub(),
      warn: sinon.stub(),
      error: sinon.stub(),
    } as any;

    markUnresponsiveStub = sinon.stub();
    getEligibleGatewaysStub = sinon.stub();
    mockNetworkGatewaySource = {
      getEligibleGateways: getEligibleGatewaysStub,
      markUnresponsive: markUnresponsiveStub,
    };

    consensusHistogramStub = sinon.stub(
      metrics.networkConsensusAgreementHistogram,
      'observe',
    );
  });

  afterEach(function () {
    sinon.restore();
    nock.cleanAll();
  });

  describe('resolveWithConsensus', function () {
    it('should return resolution when consensus is achieved (2 of 3 agree)', async function () {
      const gateways = [
        createGateway('gw1.example.com'),
        createGateway('gw2.example.com'),
        createGateway('gw3.example.com'),
      ];

      getEligibleGatewaysStub.resolves(gateways);

      const resolver = new DefaultArnsConsensusResolver({
        networkGatewaySource: mockNetworkGatewaySource,
        consensusSize: 3,
        consensusThreshold: 2,
        maxAttempts: 2,
        nodeReleaseVersion: 'test',
        log: logStub,
      });

      // Two agree, one disagrees
      setupSuccessfulResponse('gw1.example.com', 'id-A');
      setupSuccessfulResponse('gw2.example.com', 'id-A');
      setupSuccessfulResponse('gw3.example.com', 'id-B');

      const result = await resolver.resolveWithConsensus({
        arnsName: 'testname',
        entropy,
      });

      expect(result.resolution.resolvedId).to.equal('id-A');
      expect(consensusHistogramStub.calledWith(2)).to.be.true;
    });

    it('should return resolution when all gateways agree', async function () {
      const gateways = [
        createGateway('gw1.example.com'),
        createGateway('gw2.example.com'),
        createGateway('gw3.example.com'),
      ];

      getEligibleGatewaysStub.resolves(gateways);

      const resolver = new DefaultArnsConsensusResolver({
        networkGatewaySource: mockNetworkGatewaySource,
        consensusSize: 3,
        consensusThreshold: 2,
        maxAttempts: 2,
        nodeReleaseVersion: 'test',
        log: logStub,
      });

      setupSuccessfulResponse('gw1.example.com', 'id-unanimous');
      setupSuccessfulResponse('gw2.example.com', 'id-unanimous');
      setupSuccessfulResponse('gw3.example.com', 'id-unanimous');

      const result = await resolver.resolveWithConsensus({
        arnsName: 'testname',
        entropy,
      });

      expect(result.resolution.resolvedId).to.equal('id-unanimous');
      expect(consensusHistogramStub.calledWith(3)).to.be.true;
    });

    it('should throw when no consensus is reached (all disagree)', async function () {
      const gateways = [
        createGateway('gw1.example.com'),
        createGateway('gw2.example.com'),
        createGateway('gw3.example.com'),
      ];

      // First attempt returns 3 gateways, second attempt returns empty (no more)
      getEligibleGatewaysStub.onFirstCall().resolves(gateways);
      getEligibleGatewaysStub.onSecondCall().resolves([]);

      const resolver = new DefaultArnsConsensusResolver({
        networkGatewaySource: mockNetworkGatewaySource,
        consensusSize: 3,
        consensusThreshold: 2,
        maxAttempts: 2,
        nodeReleaseVersion: 'test',
        log: logStub,
      });

      setupSuccessfulResponse('gw1.example.com', 'id-A');
      setupSuccessfulResponse('gw2.example.com', 'id-B');
      setupSuccessfulResponse('gw3.example.com', 'id-C');

      try {
        await resolver.resolveWithConsensus({
          arnsName: 'testname',
          entropy,
        });
        expect.fail('Should have thrown');
      } catch (error: any) {
        expect(error.message).to.include('No consensus');
        expect(error.message).to.include('threshold 2');
      }
    });

    it('should throw when threshold not met after all attempts', async function () {
      const gateways = [
        createGateway('gw1.example.com'),
        createGateway('gw2.example.com'),
        createGateway('gw3.example.com'),
      ];

      getEligibleGatewaysStub.onFirstCall().resolves(gateways);
      getEligibleGatewaysStub.onSecondCall().resolves([]);

      const resolver = new DefaultArnsConsensusResolver({
        networkGatewaySource: mockNetworkGatewaySource,
        consensusSize: 3,
        consensusThreshold: 3, // Require unanimous agreement
        maxAttempts: 2,
        nodeReleaseVersion: 'test',
        log: logStub,
      });

      // Two agree but we need 3
      setupSuccessfulResponse('gw1.example.com', 'id-A');
      setupSuccessfulResponse('gw2.example.com', 'id-A');
      setupSuccessfulResponse('gw3.example.com', 'id-B');

      try {
        await resolver.resolveWithConsensus({
          arnsName: 'testname',
          entropy,
        });
        expect.fail('Should have thrown');
      } catch (error: any) {
        expect(error.message).to.include('No consensus');
        expect(error.message).to.include('threshold 3');
      }
    });

    it('should mark failed gateways as unresponsive', async function () {
      const gateways = [
        createGateway('gw1.example.com'),
        createGateway('gw2.example.com'),
        createGateway('gw3.example.com'),
      ];

      getEligibleGatewaysStub.resolves(gateways);

      const resolver = new DefaultArnsConsensusResolver({
        networkGatewaySource: mockNetworkGatewaySource,
        consensusSize: 3,
        consensusThreshold: 2,
        maxAttempts: 1,
        nodeReleaseVersion: 'test',
        log: logStub,
      });

      // gw1 fails, gw2 and gw3 succeed
      nock(`https://testname.gw1.example.com`)
        .head('/')
        .replyWithError('Connection timeout');

      setupSuccessfulResponse('gw2.example.com', 'id-A');
      setupSuccessfulResponse('gw3.example.com', 'id-A');

      await resolver.resolveWithConsensus({
        arnsName: 'testname',
        entropy,
      });

      expect(markUnresponsiveStub.calledWith('gw1.example.com')).to.be.true;
      expect(markUnresponsiveStub.calledOnce).to.be.true;
    });

    it('should throw when all gateways fail', async function () {
      const gateways = [
        createGateway('gw1.example.com'),
        createGateway('gw2.example.com'),
        createGateway('gw3.example.com'),
      ];

      getEligibleGatewaysStub.onFirstCall().resolves(gateways);
      getEligibleGatewaysStub.onSecondCall().resolves([]);

      const resolver = new DefaultArnsConsensusResolver({
        networkGatewaySource: mockNetworkGatewaySource,
        consensusSize: 3,
        consensusThreshold: 2,
        maxAttempts: 2,
        nodeReleaseVersion: 'test',
        log: logStub,
      });

      // All fail
      nock(`https://testname.gw1.example.com`)
        .head('/')
        .replyWithError('Connection timeout');
      nock(`https://testname.gw2.example.com`)
        .head('/')
        .replyWithError('Connection timeout');
      nock(`https://testname.gw3.example.com`)
        .head('/')
        .replyWithError('Connection timeout');

      try {
        await resolver.resolveWithConsensus({
          arnsName: 'testname',
          entropy,
        });
        expect.fail('Should have thrown');
      } catch (error: any) {
        // Error is the last gateway failure error
        expect(error.message).to.include('Connection timeout');
      }
    });

    it('should throw when no gateways available', async function () {
      getEligibleGatewaysStub.resolves([]);

      const resolver = new DefaultArnsConsensusResolver({
        networkGatewaySource: mockNetworkGatewaySource,
        consensusSize: 3,
        consensusThreshold: 2,
        maxAttempts: 2,
        nodeReleaseVersion: 'test',
        log: logStub,
      });

      try {
        await resolver.resolveWithConsensus({
          arnsName: 'testname',
          entropy,
        });
        expect.fail('Should have thrown');
      } catch (error: any) {
        expect(error.message).to.include('All gateways failed');
      }
    });

    it('should handle 404 responses correctly', async function () {
      const gateways = [
        createGateway('gw1.example.com'),
        createGateway('gw2.example.com'),
      ];

      getEligibleGatewaysStub.resolves(gateways);

      const resolver = new DefaultArnsConsensusResolver({
        networkGatewaySource: mockNetworkGatewaySource,
        consensusSize: 2,
        consensusThreshold: 2,
        maxAttempts: 1,
        nodeReleaseVersion: 'test',
        log: logStub,
      });

      // Both return 404
      nock(`https://testname.gw1.example.com`).head('/').reply(404);
      nock(`https://testname.gw2.example.com`).head('/').reply(404);

      const result = await resolver.resolveWithConsensus({
        arnsName: 'testname',
        entropy,
      });

      expect(result.resolution.statusCode).to.equal(404);
      expect(result.resolution.resolvedId).to.be.null;
    });

    it('should treat missing x-arns-resolved-id header as failure', async function () {
      const gateways = [
        createGateway('gw1.example.com'),
        createGateway('gw2.example.com'),
        createGateway('gw3.example.com'),
      ];

      getEligibleGatewaysStub.resolves(gateways);

      const resolver = new DefaultArnsConsensusResolver({
        networkGatewaySource: mockNetworkGatewaySource,
        consensusSize: 3,
        consensusThreshold: 2,
        maxAttempts: 1,
        nodeReleaseVersion: 'test',
        log: logStub,
      });

      // gw1 returns 200 but missing x-arns-resolved-id header
      nock(`https://testname.gw1.example.com`).head('/').reply(200, undefined, {
        'Content-Type': 'application/octet-stream',
        'x-arns-ttl-seconds': '300',
        'Content-Length': '100',
      });

      // gw2 and gw3 succeed with proper headers
      setupSuccessfulResponse('gw2.example.com', 'id-A');
      setupSuccessfulResponse('gw3.example.com', 'id-A');

      const result = await resolver.resolveWithConsensus({
        arnsName: 'testname',
        entropy,
      });

      // Should achieve consensus from gw2 and gw3
      expect(result.resolution.resolvedId).to.equal('id-A');
      // gw1 should be marked as unresponsive due to missing header
      expect(markUnresponsiveStub.calledWith('gw1.example.com')).to.be.true;
    });

    it('should treat missing x-arns-ttl-seconds header as failure', async function () {
      const gateways = [
        createGateway('gw1.example.com'),
        createGateway('gw2.example.com'),
        createGateway('gw3.example.com'),
      ];

      getEligibleGatewaysStub.resolves(gateways);

      const resolver = new DefaultArnsConsensusResolver({
        networkGatewaySource: mockNetworkGatewaySource,
        consensusSize: 3,
        consensusThreshold: 2,
        maxAttempts: 1,
        nodeReleaseVersion: 'test',
        log: logStub,
      });

      // gw1 returns 200 but missing x-arns-ttl-seconds header
      nock(`https://testname.gw1.example.com`).head('/').reply(200, undefined, {
        'Content-Type': 'application/octet-stream',
        'x-arns-resolved-id': 'id-A',
        'Content-Length': '100',
      });

      // gw2 and gw3 succeed with proper headers
      setupSuccessfulResponse('gw2.example.com', 'id-A');
      setupSuccessfulResponse('gw3.example.com', 'id-A');

      const result = await resolver.resolveWithConsensus({
        arnsName: 'testname',
        entropy,
      });

      // Should achieve consensus from gw2 and gw3
      expect(result.resolution.resolvedId).to.equal('id-A');
      // gw1 should be marked as unresponsive due to missing header
      expect(markUnresponsiveStub.calledWith('gw1.example.com')).to.be.true;
    });

    it('should pass excludeFqdns to getEligibleGateways', async function () {
      const gateways = [createGateway('gw1.example.com')];
      getEligibleGatewaysStub.resolves(gateways);

      const resolver = new DefaultArnsConsensusResolver({
        networkGatewaySource: mockNetworkGatewaySource,
        consensusSize: 1,
        consensusThreshold: 1,
        maxAttempts: 1,
        nodeReleaseVersion: 'test',
        log: logStub,
      });

      setupSuccessfulResponse('gw1.example.com', 'id-A');

      await resolver.resolveWithConsensus({
        arnsName: 'testname',
        entropy,
        excludeFqdns: ['excluded.example.com'],
      });

      expect(getEligibleGatewaysStub.firstCall.args[0].excludeFqdns).to.include(
        'excluded.example.com',
      );
    });
  });

  describe('retry-with-replacement', function () {
    it('should retry with replacement gateways when first attempt fails', async function () {
      const firstBatchGateways = [
        createGateway('gw1.example.com'),
        createGateway('gw2.example.com'),
        createGateway('gw3.example.com'),
      ];
      const secondBatchGateways = [
        createGateway('gw4.example.com'),
        createGateway('gw5.example.com'),
      ];

      // First call returns first batch, second call returns second batch
      getEligibleGatewaysStub.onFirstCall().resolves(firstBatchGateways);
      getEligibleGatewaysStub.onSecondCall().resolves(secondBatchGateways);

      const resolver = new DefaultArnsConsensusResolver({
        networkGatewaySource: mockNetworkGatewaySource,
        consensusSize: 3,
        consensusThreshold: 2,
        maxAttempts: 2,
        nodeReleaseVersion: 'test',
        log: logStub,
      });

      // First batch all fail
      nock(`https://testname.gw1.example.com`)
        .head('/')
        .replyWithError('Timeout');
      nock(`https://testname.gw2.example.com`)
        .head('/')
        .replyWithError('Timeout');
      nock(`https://testname.gw3.example.com`)
        .head('/')
        .replyWithError('Timeout');

      // Second batch succeeds
      setupSuccessfulResponse('gw4.example.com', 'id-retry');
      setupSuccessfulResponse('gw5.example.com', 'id-retry');

      const result = await resolver.resolveWithConsensus({
        arnsName: 'testname',
        entropy,
      });

      expect(result.resolution.resolvedId).to.equal('id-retry');
      expect(getEligibleGatewaysStub.calledTwice).to.be.true;

      // Second call should exclude first batch gateways
      const secondCallExcludes =
        getEligibleGatewaysStub.secondCall.args[0].excludeFqdns;
      expect(secondCallExcludes).to.include('gw1.example.com');
      expect(secondCallExcludes).to.include('gw2.example.com');
      expect(secondCallExcludes).to.include('gw3.example.com');
    });

    it('should accumulate successful results across attempts', async function () {
      const firstBatchGateways = [
        createGateway('gw1.example.com'),
        createGateway('gw2.example.com'),
      ];
      const secondBatchGateways = [createGateway('gw3.example.com')];

      getEligibleGatewaysStub.onFirstCall().resolves(firstBatchGateways);
      getEligibleGatewaysStub.onSecondCall().resolves(secondBatchGateways);

      const resolver = new DefaultArnsConsensusResolver({
        networkGatewaySource: mockNetworkGatewaySource,
        consensusSize: 3,
        consensusThreshold: 2,
        maxAttempts: 2,
        nodeReleaseVersion: 'test',
        log: logStub,
      });

      // First gateway succeeds, second fails
      setupSuccessfulResponse('gw1.example.com', 'id-accumulated');
      nock(`https://testname.gw2.example.com`)
        .head('/')
        .replyWithError('Timeout');

      // Third gateway succeeds with same ID
      setupSuccessfulResponse('gw3.example.com', 'id-accumulated');

      const result = await resolver.resolveWithConsensus({
        arnsName: 'testname',
        entropy,
      });

      // Should achieve consensus from gw1 (attempt 1) + gw3 (attempt 2)
      expect(result.resolution.resolvedId).to.equal('id-accumulated');
    });

    it('should stop retrying when maxAttempts is reached', async function () {
      const gateways = [createGateway('gw1.example.com')];

      // Return one gateway per attempt, then empty
      getEligibleGatewaysStub.onFirstCall().resolves(gateways);
      getEligibleGatewaysStub
        .onSecondCall()
        .resolves([createGateway('gw2.example.com')]);
      getEligibleGatewaysStub
        .onThirdCall()
        .resolves([createGateway('gw3.example.com')]);

      const resolver = new DefaultArnsConsensusResolver({
        networkGatewaySource: mockNetworkGatewaySource,
        consensusSize: 3,
        consensusThreshold: 2,
        maxAttempts: 2, // Only 2 attempts allowed
        nodeReleaseVersion: 'test',
        log: logStub,
      });

      // All return different IDs (no consensus possible with 1 gateway each)
      setupSuccessfulResponse('gw1.example.com', 'id-A');
      setupSuccessfulResponse('gw2.example.com', 'id-B');
      setupSuccessfulResponse('gw3.example.com', 'id-C');

      try {
        await resolver.resolveWithConsensus({
          arnsName: 'testname',
          entropy,
        });
        expect.fail('Should have thrown');
      } catch (error: any) {
        expect(error.message).to.include('No consensus');
        // Should have only made 2 calls (maxAttempts)
        expect(getEligibleGatewaysStub.calledTwice).to.be.true;
      }
    });
  });
});
