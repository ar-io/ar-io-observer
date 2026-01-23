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
import {
  ArnsConsensusResolver,
  ArnsResolution,
  NetworkGateway,
  NetworkGatewaySource,
  ReferenceGatewaySource,
} from '../types.js';
import { CompositeReferenceGateway } from './composite-reference-gateway.js';

describe('CompositeReferenceGateway', function () {
  let logStub: winston.Logger;
  let mockExplicitGateway: ReferenceGatewaySource;
  let mockNetworkGatewaySource: NetworkGatewaySource;
  let mockConsensusResolver: ArnsConsensusResolver;
  let networkFallbackCounterStub: sinon.SinonStub;

  const entropy = Buffer.from('test-entropy');
  const defaultResolution: ArnsResolution = {
    statusCode: 200,
    resolvedId: 'test-resolved-id',
    ttlSeconds: '300',
    contentLength: '1000',
    contentType: 'application/octet-stream',
    dataHashDigest: 'hash123',
    timings: null,
  };

  const createGateway = (fqdn: string): NetworkGateway => ({
    fqdn,
    protocol: 'https',
    port: 443,
    gatewayAddress: `wallet-${fqdn}`,
    passRate: 0.9,
    passedConsecutiveEpochs: 5,
  });

  beforeEach(function () {
    nock.cleanAll();

    logStub = {
      child: sinon.stub().returnsThis(),
      debug: sinon.stub(),
      verbose: sinon.stub(),
      warn: sinon.stub(),
      error: sinon.stub(),
    } as any;

    mockExplicitGateway = {
      getArnsResolution: sinon.stub(),
      checkChunkAvailability: sinon.stub(),
    };

    mockNetworkGatewaySource = {
      getEligibleGateways: sinon.stub(),
      markUnresponsive: sinon.stub(),
    };

    mockConsensusResolver = {
      resolveWithConsensus: sinon.stub(),
    };

    networkFallbackCounterStub = sinon.stub(
      metrics.networkFallbackCounter,
      'inc',
    );
  });

  afterEach(function () {
    sinon.restore();
    nock.cleanAll();
  });

  describe('constructor', function () {
    it('should throw if networkOnly but no networkGatewaySource', function () {
      expect(
        () =>
          new CompositeReferenceGateway({
            explicitGateway: null,
            networkGatewaySource: null,
            consensusResolver: mockConsensusResolver,
            networkOnly: true,
            networkFallback: false,
            nodeReleaseVersion: 'test',
            log: logStub,
          }),
      ).to.throw('Network gateway source required');
    });

    it('should throw if networkOnly but no consensusResolver', function () {
      expect(
        () =>
          new CompositeReferenceGateway({
            explicitGateway: null,
            networkGatewaySource: mockNetworkGatewaySource,
            consensusResolver: null,
            networkOnly: true,
            networkFallback: false,
            nodeReleaseVersion: 'test',
            log: logStub,
          }),
      ).to.throw('Consensus resolver required');
    });

    it('should throw if not networkOnly but no explicitGateway', function () {
      expect(
        () =>
          new CompositeReferenceGateway({
            explicitGateway: null,
            networkGatewaySource: mockNetworkGatewaySource,
            consensusResolver: mockConsensusResolver,
            networkOnly: false,
            networkFallback: true,
            nodeReleaseVersion: 'test',
            log: logStub,
          }),
      ).to.throw('Explicit gateway required');
    });
  });

  describe('Mode 1: Explicit only', function () {
    it('should use only explicit gateway when network fallback is disabled', async function () {
      (mockExplicitGateway.getArnsResolution as sinon.SinonStub).resolves({
        host: 'explicit.example.com',
        resolution: defaultResolution,
      });

      const gateway = new CompositeReferenceGateway({
        explicitGateway: mockExplicitGateway,
        networkGatewaySource: null,
        consensusResolver: null,
        networkOnly: false,
        networkFallback: false,
        nodeReleaseVersion: 'test',
        log: logStub,
      });

      const result = await gateway.getArnsResolution({
        arnsName: 'testname',
        entropy,
      });

      expect(result.host).to.equal('explicit.example.com');
      expect(result.resolution.resolvedId).to.equal('test-resolved-id');
    });

    it('should throw when explicit gateway fails and network fallback is disabled', async function () {
      (mockExplicitGateway.getArnsResolution as sinon.SinonStub).rejects(
        new Error('Explicit gateway failed'),
      );

      const gateway = new CompositeReferenceGateway({
        explicitGateway: mockExplicitGateway,
        networkGatewaySource: null,
        consensusResolver: null,
        networkOnly: false,
        networkFallback: false,
        nodeReleaseVersion: 'test',
        log: logStub,
      });

      try {
        await gateway.getArnsResolution({
          arnsName: 'testname',
          entropy,
        });
        expect.fail('Should have thrown');
      } catch (error: any) {
        expect(error.message).to.equal('Explicit gateway failed');
      }
    });
  });

  describe('Mode 2: Explicit + network fallback', function () {
    it('should use explicit gateway when successful', async function () {
      (mockExplicitGateway.getArnsResolution as sinon.SinonStub).resolves({
        host: 'explicit.example.com',
        resolution: defaultResolution,
      });

      const gateway = new CompositeReferenceGateway({
        explicitGateway: mockExplicitGateway,
        networkGatewaySource: mockNetworkGatewaySource,
        consensusResolver: mockConsensusResolver,
        networkOnly: false,
        networkFallback: true,
        nodeReleaseVersion: 'test',
        log: logStub,
      });

      const result = await gateway.getArnsResolution({
        arnsName: 'testname',
        entropy,
      });

      expect(result.host).to.equal('explicit.example.com');
      expect(
        (mockConsensusResolver.resolveWithConsensus as sinon.SinonStub).called,
      ).to.be.false;
    });

    it('should fall back to network when explicit gateway fails', async function () {
      (mockExplicitGateway.getArnsResolution as sinon.SinonStub).rejects(
        new Error('Explicit gateway failed'),
      );

      (
        mockNetworkGatewaySource.getEligibleGateways as sinon.SinonStub
      ).resolves([
        createGateway('network1.example.com'),
        createGateway('network2.example.com'),
      ]);

      (mockConsensusResolver.resolveWithConsensus as sinon.SinonStub).resolves({
        host: 'network1.example.com',
        resolution: { ...defaultResolution, resolvedId: 'network-resolved-id' },
      });

      const gateway = new CompositeReferenceGateway({
        explicitGateway: mockExplicitGateway,
        networkGatewaySource: mockNetworkGatewaySource,
        consensusResolver: mockConsensusResolver,
        networkOnly: false,
        networkFallback: true,
        nodeReleaseVersion: 'test',
        log: logStub,
      });

      const result = await gateway.getArnsResolution({
        arnsName: 'testname',
        entropy,
      });

      expect(result.host).to.equal('network1.example.com');
      expect(result.resolution.resolvedId).to.equal('network-resolved-id');
      expect(
        networkFallbackCounterStub.calledWith({
          operation: 'getArnsResolution',
          status: 'triggered',
        }),
      ).to.be.true;
      expect(
        networkFallbackCounterStub.calledWith({
          operation: 'getArnsResolution',
          status: 'success',
        }),
      ).to.be.true;
    });

    it('should throw when both explicit and network fail', async function () {
      (mockExplicitGateway.getArnsResolution as sinon.SinonStub).rejects(
        new Error('Explicit gateway failed'),
      );

      (
        mockNetworkGatewaySource.getEligibleGateways as sinon.SinonStub
      ).resolves([createGateway('network1.example.com')]);

      (mockConsensusResolver.resolveWithConsensus as sinon.SinonStub).rejects(
        new Error('Network consensus failed'),
      );

      const gateway = new CompositeReferenceGateway({
        explicitGateway: mockExplicitGateway,
        networkGatewaySource: mockNetworkGatewaySource,
        consensusResolver: mockConsensusResolver,
        networkOnly: false,
        networkFallback: true,
        nodeReleaseVersion: 'test',
        log: logStub,
      });

      try {
        await gateway.getArnsResolution({
          arnsName: 'testname',
          entropy,
        });
        expect.fail('Should have thrown');
      } catch (error: any) {
        expect(error.message).to.include('Both explicit and network');
        expect(error.message).to.include('Explicit gateway failed');
        expect(error.message).to.include('Network consensus failed');
      }

      expect(
        networkFallbackCounterStub.calledWith({
          operation: 'getArnsResolution',
          status: 'failure',
        }),
      ).to.be.true;
    });
  });

  describe('Mode 3: Network only', function () {
    it('should use only network gateways with consensus', async function () {
      (
        mockNetworkGatewaySource.getEligibleGateways as sinon.SinonStub
      ).resolves([
        createGateway('network1.example.com'),
        createGateway('network2.example.com'),
      ]);

      (mockConsensusResolver.resolveWithConsensus as sinon.SinonStub).resolves({
        host: 'network1.example.com',
        resolution: { ...defaultResolution, resolvedId: 'network-only-id' },
      });

      const gateway = new CompositeReferenceGateway({
        explicitGateway: null,
        networkGatewaySource: mockNetworkGatewaySource,
        consensusResolver: mockConsensusResolver,
        networkOnly: true,
        networkFallback: false,
        nodeReleaseVersion: 'test',
        log: logStub,
      });

      const result = await gateway.getArnsResolution({
        arnsName: 'testname',
        entropy,
      });

      expect(result.host).to.equal('network1.example.com');
      expect(result.resolution.resolvedId).to.equal('network-only-id');
    });

    it('should throw when consensus resolver fails in network only mode', async function () {
      // Consensus resolver throws when no gateways available
      (mockConsensusResolver.resolveWithConsensus as sinon.SinonStub).rejects(
        new Error('All gateways failed for consensus resolution'),
      );

      const gateway = new CompositeReferenceGateway({
        explicitGateway: null,
        networkGatewaySource: mockNetworkGatewaySource,
        consensusResolver: mockConsensusResolver,
        networkOnly: true,
        networkFallback: false,
        nodeReleaseVersion: 'test',
        log: logStub,
      });

      try {
        await gateway.getArnsResolution({
          arnsName: 'testname',
          entropy,
        });
        expect.fail('Should have thrown');
      } catch (error: any) {
        expect(error.message).to.include('All gateways failed');
      }
    });
  });

  describe('setObservedGateway', function () {
    it('should exclude observed gateway from consensus resolution', async function () {
      (mockExplicitGateway.getArnsResolution as sinon.SinonStub).rejects(
        new Error('Explicit gateway failed'),
      );

      (mockConsensusResolver.resolveWithConsensus as sinon.SinonStub).resolves({
        host: 'network1.example.com',
        resolution: defaultResolution,
      });

      const gateway = new CompositeReferenceGateway({
        explicitGateway: mockExplicitGateway,
        networkGatewaySource: mockNetworkGatewaySource,
        consensusResolver: mockConsensusResolver,
        networkOnly: false,
        networkFallback: true,
        nodeReleaseVersion: 'test',
        log: logStub,
      });

      gateway.setObservedGateway('observed.example.com');

      await gateway.getArnsResolution({
        arnsName: 'testname',
        entropy,
      });

      // Consensus resolver should receive excludeFqdns with the observed gateway
      const resolverCall = (
        mockConsensusResolver.resolveWithConsensus as sinon.SinonStub
      ).firstCall;
      expect(resolverCall.args[0].excludeFqdns).to.include(
        'observed.example.com',
      );
    });
  });

  describe('checkChunkAvailability', function () {
    it('should check explicit gateway in mode 1', async function () {
      (mockExplicitGateway.checkChunkAvailability as sinon.SinonStub).resolves({
        host: 'explicit.example.com',
        available: true,
      });

      const gateway = new CompositeReferenceGateway({
        explicitGateway: mockExplicitGateway,
        networkGatewaySource: null,
        consensusResolver: null,
        networkOnly: false,
        networkFallback: false,
        nodeReleaseVersion: 'test',
        log: logStub,
      });

      const result = await gateway.checkChunkAvailability({ offset: 12345 });

      expect(result.host).to.equal('explicit.example.com');
      expect(result.available).to.be.true;
    });

    it('should NOT fall back to network when explicit returns available=false in mode 2', async function () {
      // When explicit gateway returns available: false (from 404/410), it's authoritative
      // No network fallback should occur
      (mockExplicitGateway.checkChunkAvailability as sinon.SinonStub).resolves({
        host: 'explicit.example.com',
        available: false,
      });

      const gateway = new CompositeReferenceGateway({
        explicitGateway: mockExplicitGateway,
        networkGatewaySource: mockNetworkGatewaySource,
        consensusResolver: mockConsensusResolver,
        networkOnly: false,
        networkFallback: true,
        nodeReleaseVersion: 'test',
        log: logStub,
      });

      const result = await gateway.checkChunkAvailability({ offset: 12345 });

      // Should return the explicit gateway's authoritative answer
      expect(result.host).to.equal('explicit.example.com');
      expect(result.available).to.be.false;
      // Network fallback counter should NOT be incremented
      expect(networkFallbackCounterStub.called).to.be.false;
    });

    it('should fall back to network when explicit gateway throws in mode 2', async function () {
      // When explicit gateway throws (network error, all hosts failed), fall back to network
      (mockExplicitGateway.checkChunkAvailability as sinon.SinonStub).rejects(
        new Error('checkChunkAvailability failed on all hosts'),
      );

      (
        mockNetworkGatewaySource.getEligibleGateways as sinon.SinonStub
      ).resolves([createGateway('network1.example.com')]);

      nock('https://network1.example.com')
        .get('/chunk/12345')
        .reply(200, { chunk: 'test-chunk', data_path: 'path' });

      const gateway = new CompositeReferenceGateway({
        explicitGateway: mockExplicitGateway,
        networkGatewaySource: mockNetworkGatewaySource,
        consensusResolver: mockConsensusResolver,
        networkOnly: false,
        networkFallback: true,
        nodeReleaseVersion: 'test',
        log: logStub,
      });

      const result = await gateway.checkChunkAvailability({ offset: 12345 });

      expect(result.host).to.equal('network1.example.com');
      expect(result.available).to.be.true;
      expect(
        networkFallbackCounterStub.calledWith({
          operation: 'checkChunkAvailability',
          status: 'triggered',
        }),
      ).to.be.true;
    });

    it('should use network only for chunk check in mode 3', async function () {
      (
        mockNetworkGatewaySource.getEligibleGateways as sinon.SinonStub
      ).resolves([createGateway('network1.example.com')]);

      nock('https://network1.example.com')
        .get('/chunk/12345')
        .reply(200, { chunk: 'test-chunk', data_path: 'path' });

      const gateway = new CompositeReferenceGateway({
        explicitGateway: null,
        networkGatewaySource: mockNetworkGatewaySource,
        consensusResolver: mockConsensusResolver,
        networkOnly: true,
        networkFallback: false,
        nodeReleaseVersion: 'test',
        log: logStub,
      });

      const result = await gateway.checkChunkAvailability({ offset: 12345 });

      expect(result.host).to.equal('network1.example.com');
      expect(result.available).to.be.true;
    });

    it('should try network gateways sequentially for chunk check', async function () {
      (
        mockNetworkGatewaySource.getEligibleGateways as sinon.SinonStub
      ).resolves([
        createGateway('network1.example.com'),
        createGateway('network2.example.com'),
      ]);

      // First gateway fails
      nock('https://network1.example.com')
        .get('/chunk/12345')
        .replyWithError('Connection failed');

      // Second gateway succeeds
      nock('https://network2.example.com')
        .get('/chunk/12345')
        .reply(200, { chunk: 'test-chunk', data_path: 'path' });

      const gateway = new CompositeReferenceGateway({
        explicitGateway: null,
        networkGatewaySource: mockNetworkGatewaySource,
        consensusResolver: mockConsensusResolver,
        networkOnly: true,
        networkFallback: false,
        nodeReleaseVersion: 'test',
        log: logStub,
      });

      const result = await gateway.checkChunkAvailability({ offset: 12345 });

      expect(result.host).to.equal('network2.example.com');
      expect(result.available).to.be.true;
      expect(
        (
          mockNetworkGatewaySource.markUnresponsive as sinon.SinonStub
        ).calledWith('network1.example.com'),
      ).to.be.true;
    });
  });
});
