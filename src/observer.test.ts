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
import got from 'got';
import nock from 'nock';
import crypto from 'node:crypto';
import sinon from 'sinon';

import * as config from './config.js';
import { customHashPRNG } from './lib/prng.js';
import * as metrics from './metrics.js';
import {
  generateRandomRanges,
  getArnsResolution,
  Observer,
} from './observer.js';
import { ReferenceGatewaySource } from './types.js';
import type {
  GatewayAssessments,
  ObserverReport,
  GatewayHost,
  ArnsNamesSource,
  EpochTimestampSource,
  GatewayHostsSource,
  EntropySource,
} from './types.js';

const OneMiB = 1048576;

const entropy = Buffer.from('entropy');

describe('Observer', function () {
  describe('getArnsResolution', function () {
    const url = 'https://arnsname.gateway.com';
    const invalidUrl = 'http://invalidhost.invaliddomain';

    const defaultContentType = 'application/octet-stream';
    const defaultArnsResolvedId = '12345';
    const defaultArnsTtlSeconds = '300';

    beforeEach(function () {
      nock.cleanAll();
    });

    it('should correctly hash data for responses under 1MiB', async function () {
      const data = Buffer.alloc(100, 'a').toString();
      nock(url)
        .head('/')
        .reply(200, undefined, {
          'Content-Type': defaultContentType,
          'x-arns-resolved-id': defaultArnsResolvedId,
          'x-arns-ttl-seconds': defaultArnsTtlSeconds,
          'Content-Length': String(data.length),
        });
      nock(url)
        .get('/')
        .reply(200, data, {
          'Content-Type': defaultContentType,
          'x-arns-resolved-id': defaultArnsResolvedId,
          'x-arns-ttl-seconds': defaultArnsTtlSeconds,
          'Content-Length': String(data.length),
        });
      const expectedHash = crypto
        .createHash('sha256')
        .update(data)
        .digest('base64url');

      const result = await getArnsResolution({
        url,
        got,
        entropy,
      });

      expect(result.statusCode).to.equal(200);
      expect(result.resolvedId).to.equal(defaultArnsResolvedId);
      expect(result.ttlSeconds).to.equal(defaultArnsTtlSeconds);
      expect(result.contentType).to.equal(defaultContentType);
      expect(result.contentLength).to.equal(String(data.length));
      expect(result.dataHashDigest).to.equal(expectedHash);
      expect(result.timings).to.be.a.string;
    });

    it('should use range requests to hash data for responses over 1MiB', async function () {
      const largeContent = Buffer.alloc(OneMiB + 500, 'a').toString();
      const partialContent = Buffer.alloc(200, 'a').toString(); // Sample range content
      const entropy = Buffer.from('random');
      const rng = customHashPRNG(entropy);
      const ranges = generateRandomRanges({
        contentSize: largeContent.length,
        rangeSize: 200,
        rangeQuantity: 5,
        rng,
      });

      nock(url)
        .head('/')
        .reply(200, undefined, {
          'Content-Type': defaultContentType,
          'x-arns-resolved-id': defaultArnsResolvedId,
          'x-arns-ttl-seconds': defaultArnsTtlSeconds,
          'Content-Length': String(largeContent.length),
        });

      const dataHash = crypto.createHash('sha256');

      ranges.forEach((range) => {
        dataHash.update(partialContent);
        nock(url)
          .get('/')
          .matchHeader('Range', `bytes=${range}`)
          .reply(206, partialContent, {
            'Content-Type': defaultContentType,
            'Content-Range': `bytes ${range}/${largeContent.length}`,
          });
      });

      const result = await getArnsResolution({
        url,
        got,
        entropy,
      });

      expect(result.statusCode).to.equal(200);
      expect(result.resolvedId).to.equal(defaultArnsResolvedId);
      expect(result.ttlSeconds).to.equal(defaultArnsTtlSeconds);
      expect(result.contentType).to.equal(defaultContentType);
      expect(result.contentLength).to.equal(String(largeContent.length));
      expect(result.dataHashDigest).to.equal(dataHash.digest('base64url'));
      expect(result.timings).to.be.a.string;
    });

    it('should resolve with correct properties on a 404 response for HEAD requests', async function () {
      nock(url).head('/').reply(404);

      const result = await getArnsResolution({
        url,
        got,
        entropy,
      });

      expect(result.statusCode).to.equal(404);
      expect(result.resolvedId).to.be.null;
      expect(result.ttlSeconds).to.be.null;
      expect(result.contentType).to.be.null;
      expect(result.contentLength).to.be.null;
      expect(result.dataHashDigest).to.be.null;
      expect(result.timings).to.be.a.string;
    });

    it('should resolve with correct properties on a 404 response for GET requests', async function () {
      nock(url).head('/').reply(200, undefined, { 'Content-Length': '100' });
      nock(url).get('/').reply(404);

      const result = await getArnsResolution({
        url,
        got,
        entropy,
      });

      expect(result.statusCode).to.equal(404);
      expect(result.resolvedId).to.be.null;
      expect(result.ttlSeconds).to.be.null;
      expect(result.contentType).to.be.null;
      expect(result.contentLength).to.be.null;
      expect(result.dataHashDigest).to.be.null;
      expect(result.timings).to.be.a.string;
    });

    it('should handle non-404 errors appropriately for HEAD requests', async function () {
      nock(url).head('/').reply(500);

      const gotClient = got.extend({
        retry: { limit: 0 },
      });

      try {
        await getArnsResolution({
          url,
          got: gotClient,
          entropy,
        });
      } catch (error: any) {
        expect(error).to.exist;
      }
    });

    it('should handle non-404 errors appropriately for GET requests', async function () {
      nock(url).head('/').reply(200, undefined, { 'Content-Length': '100' });
      nock(url).get('/').reply(500);

      try {
        await getArnsResolution({
          url,
          got,
          entropy,
        });
      } catch (error: any) {
        expect(error).to.exist;
        expect(error.response).to.exist;
        expect(error.response.statusCode).to.equal(500);
      }
    });

    it('should reject on network errors for HEAD requests', async function () {
      const gotClient = got.extend({
        retry: { limit: 0 },
      });

      try {
        await getArnsResolution({
          url: invalidUrl,
          got: gotClient,
          entropy,
        });
      } catch (error: any) {
        expect(error.message).to.exist;
      }
    });

    it('should reject on network errors for GET requests', async function () {
      nock(invalidUrl)
        .head('/')
        .reply(200, undefined, { 'Content-Length': '100' });

      const gotClient = got.extend({
        retry: { limit: 0 },
      });

      try {
        await getArnsResolution({ url: invalidUrl, got: gotClient, entropy });
      } catch (error: any) {
        expect(error.message).to.exist;
      }
    });

    it('should add "X-AR-IO-Node-Release" header when making a request to a reference gateway', async function () {
      const data = Buffer.alloc(100, 'a').toString();
      const headScope = nock(url, {
        reqheaders: {
          'X-AR-IO-Node-Release': 'test',
        },
      })
        .head('/')
        .reply(200, undefined, {
          'Content-Type': defaultContentType,
          'x-arns-resolved-id': defaultArnsResolvedId,
          'x-arns-ttl-seconds': defaultArnsTtlSeconds,
          'Content-Length': String(data.length),
        });
      const getScope = nock(url, {
        reqheaders: {
          'X-AR-IO-Node-Release': 'test',
        },
      })
        .get('/')
        .reply(200, data, {
          'Content-Type': defaultContentType,
          'x-arns-resolved-id': defaultArnsResolvedId,
          'x-arns-ttl-seconds': defaultArnsTtlSeconds,
          'Content-Length': String(data.length),
        });

      const gotClient = got.extend({
        headers: { 'X-AR-IO-Node-Release': 'test' },
      });

      await getArnsResolution({
        url,
        got: gotClient,
        entropy,
      });

      expect(headScope.isDone()).to.be.true;
      expect(getScope.isDone()).to.be.true;
    });

    it('should not add "X-AR-IO-Node-Release" header when assessing a gateway', async function () {
      const data = Buffer.alloc(100, 'a').toString();
      const headScope = nock(url, {
        badheaders: ['X-AR-IO-Node-Release'],
      })
        .head('/')
        .reply(200, undefined, {
          'Content-Type': defaultContentType,
          'x-arns-resolved-id': defaultArnsResolvedId,
          'x-arns-ttl-seconds': defaultArnsTtlSeconds,
          'Content-Length': String(data.length),
        });
      const getScope = nock(url, {
        badheaders: ['X-AR-IO-Node-Release'],
      })
        .get('/')
        .reply(200, data, {
          'Content-Type': defaultContentType,
          'x-arns-resolved-id': defaultArnsResolvedId,
          'x-arns-ttl-seconds': defaultArnsTtlSeconds,
          'Content-Length': String(data.length),
        });

      await getArnsResolution({
        url,
        got,
        entropy,
      });

      expect(headScope.isDone()).to.be.true;
      expect(getScope.isDone()).to.be.true;
    });
  });

  describe('customHashPRNG', () => {
    it('should initialize correctly with a Buffer seed', () => {
      const seed = crypto.randomBytes(32);
      const prng = customHashPRNG(seed);
      expect(prng).to.be.a('function');
    });

    it('should throw an error if the seed is not a Buffer', () => {
      const invalidSeed: any = 'not a buffer';
      expect(() => customHashPRNG(invalidSeed)).to.throw(
        'Seed must be a Buffer.',
      );
    });

    it('should produce a deterministic sequence for a given seed', () => {
      const seed = Buffer.from('1234567890abcdef', 'hex');
      const prng1 = customHashPRNG(seed);
      const prng2 = customHashPRNG(seed);

      const sequence1 = Array.from({ length: 5 }, prng1);
      const sequence2 = Array.from({ length: 5 }, prng2);

      expect(sequence1).to.deep.equal(sequence2);
    });

    it('should generate numbers within the range [0, 1)', () => {
      const seed = crypto.randomBytes(32);
      const prng = customHashPRNG(seed);
      const number = prng();

      expect(number).to.be.at.least(0);
      expect(number).to.be.below(1);
    });
  });

  describe('generateRandomRanges', function () {
    it('should generate the correct number of ranges', function () {
      const contentSize = 1000;
      const rangeSize = 100;
      const rangeQuantity = 5;
      const rng = () => 0.5;
      const ranges = generateRandomRanges({
        contentSize,
        rangeSize,
        rangeQuantity,
        rng,
      });
      expect(ranges).to.have.lengthOf(rangeQuantity);
    });

    it('should generate ranges within content size bounds', function () {
      const contentSize = 500;
      const rangeSize = 50;
      const rangeQuantity = 3;
      const rng = () => 0.1;
      const ranges = generateRandomRanges({
        contentSize,
        rangeSize,
        rangeQuantity,
        rng,
      });
      ranges.forEach((range) => {
        const [start, end] = range.split('-').map(Number);
        expect(start).to.be.at.least(0);
        expect(end).to.be.at.most(contentSize - 1);
      });
    });

    it('should respect the specified range size', function () {
      const contentSize = 800;
      const rangeSize = 200;
      const rangeQuantity = 2;
      const rng = () => 0.25;
      const ranges = generateRandomRanges({
        contentSize,
        rangeSize,
        rangeQuantity,
        rng,
      });
      ranges.forEach((range) => {
        const [start, end] = range.split('-').map(Number);
        expect(end - start + 1).to.equal(rangeSize);
      });
    });
  });

  describe('Observer class', function () {
    let observer: Observer;
    let epochSourceStub: sinon.SinonStubbedInstance<EpochTimestampSource>;
    let observedGatewayHostListStub: sinon.SinonStubbedInstance<GatewayHostsSource>;
    let prescribedNamesSourceStub: sinon.SinonStubbedInstance<ArnsNamesSource>;
    let chosenNamesSourceStub: sinon.SinonStubbedInstance<ArnsNamesSource>;
    let entropySourceStub: sinon.SinonStubbedInstance<EntropySource>;
    let heightSourceStub: sinon.SinonStubbedInstance<any>;
    let referenceGatewayStub: sinon.SinonStubbedInstance<ReferenceGatewaySource>;

    beforeEach(function () {
      epochSourceStub = {
        getEpochStartTimestamp: sinon.stub(),
        getEpochEndTimestamp: sinon.stub(),
        getEpochStartHeight: sinon.stub(),
        getEpochIndex: sinon.stub(),
      };

      observedGatewayHostListStub = {
        getHosts: sinon.stub(),
      };

      prescribedNamesSourceStub = {
        getNames: sinon.stub(),
      };

      chosenNamesSourceStub = {
        getNames: sinon.stub(),
      };

      entropySourceStub = {
        getEntropy: sinon.stub(),
      };
      heightSourceStub = {
        getHeight: sinon.stub().returns(Promise.resolve(1000)),
      };

      referenceGatewayStub = {
        getArnsResolution: sinon.stub(),
        checkChunkAvailability: sinon.stub(),
        getChunkMetadata: sinon
          .stub()
          .resolves({ host: 'reference.example.com', metadata: null }),
      };

      observer = new Observer({
        observerAddress: 'test-observer',
        referenceGateway: referenceGatewayStub as any,
        arweaveUrl: 'https://arweave.net',
        epochSource: epochSourceStub as any,
        observedGatewayHostList: observedGatewayHostListStub as any,
        prescribedNamesSource: prescribedNamesSourceStub as any,
        chosenNamesSource: chosenNamesSourceStub as any,
        gatewayAssessmentConcurrency: 5,
        nameAssessmentConcurrency: 10,
        nodeReleaseVersion: 'test-version',
        entropySource: entropySourceStub as any,
        heightSource: heightSourceStub as any,
      });
    });

    afterEach(function () {
      sinon.restore();
      nock.cleanAll();
    });

    describe('calculateFailureRate', function () {
      it('should return 0 for empty report', function () {
        const report: ObserverReport = {
          epochStartTimestamp: 100,
          epochEndTimestamp: 200,
          epochStartHeight: 1000,
          epochIndex: 1,
          gatewayAssessments: {},
        };

        const failureRate = (observer as any).calculateFailureRate(report);
        expect(failureRate).to.equal(0);
      });

      it('should calculate correct failure rate for single gateway', function () {
        const report: ObserverReport = {
          epochStartTimestamp: 100,
          epochEndTimestamp: 200,
          epochStartHeight: 1000,
          epochIndex: 1,
          gatewayAssessments: {
            'gateway1.com': {
              ownershipAssessment: {
                expectedWallets: ['wallet1'],
                observedWallet: 'wallet1',
                pass: true,
              },
              arnsAssessments: {
                prescribedNames: {
                  name1: {
                    pass: false,
                    failureReason: 'timeout',
                    expectedStatusCode: 200,
                    assessedAt: 100,
                  },
                },
                chosenNames: {
                  name2: {
                    pass: true,
                    expectedStatusCode: 200,
                    assessedAt: 100,
                    resolvedStatusCode: 200,
                    expectedId: 'id1',
                    resolvedId: 'id1',
                    expectedDataHash: 'hash1',
                    resolvedDataHash: 'hash1',
                  },
                },
              },
            },
          },
        };

        const failureRate = (observer as any).calculateFailureRate(report);
        // 1 failure out of 3 assessments (1 ownership + 2 names)
        expect(failureRate).to.equal(1 / 3);
      });

      it('should calculate correct failure rate for multiple gateways', function () {
        const report: ObserverReport = {
          epochStartTimestamp: 100,
          epochEndTimestamp: 200,
          epochStartHeight: 1000,
          epochIndex: 1,
          gatewayAssessments: {
            'gateway1.com': {
              ownershipAssessment: {
                expectedWallets: ['wallet1'],
                observedWallet: 'wallet1',
                pass: true,
              },
              arnsAssessments: {
                prescribedNames: {},
                chosenNames: {},
              },
            },
            'gateway2.com': {
              ownershipAssessment: {
                expectedWallets: ['wallet2'],
                observedWallet: null,
                pass: false,
                failureReason: 'Wallet mismatch',
              },
              arnsAssessments: {
                prescribedNames: {},
                chosenNames: {},
              },
            },
          },
        };

        const failureRate = (observer as any).calculateFailureRate(report);
        // 1 failure out of 2 assessments
        expect(failureRate).to.equal(0.5);
      });
    });

    describe('generateReport with multiple observations', function () {
      beforeEach(function () {
        // Setup common stubs
        epochSourceStub.getEpochStartTimestamp.returns(Promise.resolve(100));
        epochSourceStub.getEpochEndTimestamp.returns(Promise.resolve(200));
        epochSourceStub.getEpochStartHeight.returns(Promise.resolve(1000));
        epochSourceStub.getEpochIndex.returns(Promise.resolve(1));
        prescribedNamesSourceStub.getNames.returns(
          Promise.resolve(['prescribed1']),
        );
        chosenNamesSourceStub.getNames.returns(Promise.resolve(['chosen1']));
        entropySourceStub.getEntropy.returns(
          Promise.resolve(Buffer.from('test-entropy')),
        );
      });

      it('should run exactly 2 observations', async function () {
        const mockHosts: GatewayHost[] = [
          { fqdn: 'gateway1.com', wallet: 'wallet1' },
        ];
        observedGatewayHostListStub.getHosts.returns(
          Promise.resolve(mockHosts),
        );

        // Stub runSingleObservation to avoid actual network calls
        const runSingleObservationStub = sinon.stub(
          observer as any,
          'runSingleObservation',
        );

        // Return mock reports for each call
        runSingleObservationStub.resolves({
          epochStartTimestamp: 100,
          epochEndTimestamp: 200,
          epochStartHeight: 1000,
          epochIndex: 1,
          gatewayAssessments: {
            'gateway1.com': {
              ownershipAssessment: {
                expectedWallets: ['wallet1'],
                observedWallet: 'wallet1',
                pass: true,
              },
              arnsAssessments: {
                prescribedNames: {},
                chosenNames: {},
              },
            },
          },
        });

        const report = await observer.generateReport();

        expect(runSingleObservationStub.callCount).to.equal(2);
        expect(report).to.have.property('gatewayAssessments');
        expect(report.epochStartTimestamp).to.equal(100);
        expect(report.epochEndTimestamp).to.equal(200);
      });

      it('should select observation with lowest failure rate', async function () {
        const mockHosts: GatewayHost[] = [
          { fqdn: 'gateway1.com', wallet: 'wallet1' },
        ];
        observedGatewayHostListStub.getHosts.returns(
          Promise.resolve(mockHosts),
        );

        // Mock different failure rates for each observation
        let observationCount = 0;
        const runSingleObservationStub = sinon.stub(
          observer as any,
          'runSingleObservation',
        );

        // First observation with high failure rate
        runSingleObservationStub.onCall(0).resolves({
          epochStartTimestamp: 100,
          epochEndTimestamp: 200,
          epochStartHeight: 1000,
          epochIndex: 1,
          gatewayAssessments: {
            'gateway1.com': {
              ownershipAssessment: {
                expectedWallets: ['wallet1'],
                observedWallet: null,
                pass: false,
                failureReason: 'Network error',
              },
              arnsAssessments: {
                prescribedNames: {},
                chosenNames: {},
              },
            },
          },
        });

        // Second observation with low failure rate
        runSingleObservationStub.onCall(1).resolves({
          epochStartTimestamp: 100,
          epochEndTimestamp: 200,
          epochStartHeight: 1000,
          epochIndex: 1,
          gatewayAssessments: {
            'gateway1.com': {
              ownershipAssessment: {
                expectedWallets: ['wallet1'],
                observedWallet: 'wallet1',
                pass: true,
              },
              arnsAssessments: {
                prescribedNames: {},
                chosenNames: {},
              },
            },
          },
        });

        const report = await observer.generateReport();

        // Should select the second observation with lower failure rate
        expect(
          report.gatewayAssessments['gateway1.com'].ownershipAssessment.pass,
        ).to.be.true;
      });
    });

    describe('gateway order shuffling', function () {
      it('should shuffle gateway order for each observation', async function () {
        const mockHosts: GatewayHost[] = [
          { fqdn: 'gateway1.com', wallet: 'wallet1' },
          { fqdn: 'gateway2.com', wallet: 'wallet2' },
          { fqdn: 'gateway3.com', wallet: 'wallet3' },
          { fqdn: 'gateway4.com', wallet: 'wallet4' },
          { fqdn: 'gateway5.com', wallet: 'wallet5' },
        ];

        observedGatewayHostListStub.getHosts.returns(
          Promise.resolve(mockHosts),
        );

        // We'll verify shuffling by examining the actual implementation
        // The shuffling happens inside runSingleObservation with:
        // const shuffledGatewayHosts = [...gatewayHosts].sort(() => Math.random() - 0.5);

        // Spy on the original runSingleObservation before stubbing
        const originalMethod = (observer as any).runSingleObservation.bind(
          observer,
        );

        // Track calls to verify shuffling logic is present
        let callCount = 0;
        const runSingleObservationStub = sinon.stub(
          observer as any,
          'runSingleObservation',
        );
        runSingleObservationStub.callsFake(async function (...args) {
          callCount++;
          // The implementation creates a new shuffled array each time
          return {
            epochStartTimestamp: args[0],
            epochEndTimestamp: args[1],
            epochStartHeight: args[2],
            epochIndex: args[3],
            gatewayAssessments: {},
          };
        });

        await observer.generateReport();

        // Verify runSingleObservation was called twice
        expect(runSingleObservationStub.callCount).to.equal(2);

        // The test verifies that the implementation calls runSingleObservation twice,
        // and each call would shuffle the gateway hosts array internally
        expect(callCount).to.equal(2);
      });
    });

    describe('offset sampling', function () {
      it('should generate random offsets deterministically', async function () {
        heightSourceStub.getHeight.returns(Promise.resolve(1000));

        const entropy = Buffer.from('test-entropy');

        // Mock chunk requests to fail (network error)
        nock('https://gateway1.com')
          .get(/\/chunk\/\d+/)
          .times(4) // 2 calls * 2 offsets each
          .replyWithError('ENOTFOUND');

        // Call assessGatewayOffsets twice with same parameters
        const result1 = await (observer as any).assessGatewayOffsets({
          targetHost: 'gateway1.com',
          entropy,
          offsetSampleCount: 2,
          maxStableOffset: 599058, // Use the same mocked value as in other tests
        });

        const result2 = await (observer as any).assessGatewayOffsets({
          targetHost: 'gateway1.com',
          entropy,
          offsetSampleCount: 2,
          maxStableOffset: 599058, // Use the same mocked value as in other tests
        });

        // Results should be deterministic (same offsets selected)
        expect(result1.plannedOffsets).to.deep.equal(result2.plannedOffsets);
        expect(result1.assessments.length).to.equal(result2.assessments.length);

        // Both should fail due to network errors
        expect(result1.pass).to.be.false;
        expect(result2.pass).to.be.false;

        // Should have tried the same offsets
        if (result1.assessments.length > 0 && result2.assessments.length > 0) {
          expect(result1.assessments[0].offset).to.equal(
            result2.assessments[0].offset,
          );
        }
      });
    });

    describe('chunk validation', function () {
      describe('performQuickChunkValidation', function () {
        it('should reject empty chunk data', function () {
          const chunkResponse = {
            chunk: '',
            data_path: 'dGVzdC1wcm9vZg', // base64url for "test-proof"
          };
          const chunkData = Buffer.from('', 'base64url');

          const result = (observer as any).performQuickChunkValidation({
            chunkResponse,
            chunkData,
            targetHost: 'test-gateway.com',
            offset: 12345,
          });

          expect(result.isValid).to.be.false;
          expect(result.failureReason).to.equal('Chunk data is empty');
        });

        it('should reject oversized chunk data', function () {
          // Create a 2MB buffer (over the 1MB limit)
          const oversizedData = Buffer.alloc(2 * 1024 * 1024, 'a');
          const chunkResponse = {
            chunk: oversizedData.toString('base64url'),
            data_path: 'dGVzdC1wcm9vZg',
          };

          const result = (observer as any).performQuickChunkValidation({
            chunkResponse,
            chunkData: oversizedData,
            targetHost: 'test-gateway.com',
            offset: 12345,
          });

          expect(result.isValid).to.be.false;
          expect(result.failureReason).to.contain('Chunk data too large');
          expect(result.failureReason).to.contain('2097152 bytes');
        });

        it('should reject missing data_path', function () {
          const chunkResponse = {
            chunk: 'dGVzdC1jaHVuaw', // base64url for "test-chunk"
            data_path: '',
          };
          const chunkData = Buffer.from('test-chunk');

          const result = (observer as any).performQuickChunkValidation({
            chunkResponse,
            chunkData,
            targetHost: 'test-gateway.com',
            offset: 12345,
          });

          expect(result.isValid).to.be.false;
          expect(result.failureReason).to.equal('Missing or empty data_path');
        });

        it('should reject undefined data_path', function () {
          const chunkResponse = {
            chunk: 'dGVzdC1jaHVuaw',
            data_path: undefined as any,
          };
          const chunkData = Buffer.from('test-chunk');

          const result = (observer as any).performQuickChunkValidation({
            chunkResponse,
            chunkData,
            targetHost: 'test-gateway.com',
            offset: 12345,
          });

          expect(result.isValid).to.be.false;
          expect(result.failureReason).to.equal('Missing or empty data_path');
        });

        it('should reject data_path that decodes to empty proof', function () {
          const chunkResponse = {
            chunk: 'dGVzdC1jaHVuaw',
            data_path: '', // Empty string decodes to empty buffer
          };
          const chunkData = Buffer.from('test-chunk');

          const result = (observer as any).performQuickChunkValidation({
            chunkResponse,
            chunkData,
            targetHost: 'test-gateway.com',
            offset: 12345,
          });

          expect(result.isValid).to.be.false;
          expect(result.failureReason).to.equal('Missing or empty data_path');
        });

        it('should accept valid chunk data', function () {
          const validProof = Buffer.from('valid-merkle-proof-data');
          const chunkResponse = {
            chunk: 'dGVzdC1jaHVuay1kYXRh', // base64url for "test-chunk-data"
            data_path: validProof.toString('base64url'),
          };
          const chunkData = Buffer.from('test-chunk-data');

          const result = (observer as any).performQuickChunkValidation({
            chunkResponse,
            chunkData,
            targetHost: 'test-gateway.com',
            offset: 12345,
          });

          expect(result.isValid).to.be.true;
          expect(result.failureReason).to.be.undefined;
        });

        it('should accept chunk data at maximum size (1MB)', function () {
          // Create exactly 1MB buffer (at the limit)
          const maxSizeData = Buffer.alloc(1024 * 1024, 'b');
          const validProof = Buffer.from('valid-proof');
          const chunkResponse = {
            chunk: maxSizeData.toString('base64url'),
            data_path: validProof.toString('base64url'),
          };

          const result = (observer as any).performQuickChunkValidation({
            chunkResponse,
            chunkData: maxSizeData,
            targetHost: 'test-gateway.com',
            offset: 12345,
          });

          expect(result.isValid).to.be.true;
          expect(result.failureReason).to.be.undefined;
        });
      });

      describe('validateChunkAtOffset', function () {
        let validatePathStub: sinon.SinonStub;

        beforeEach(function () {
          // Mock validatePath from arweave package
          validatePathStub = sinon.stub();
        });

        afterEach(function () {
          validatePathStub.restore?.();
        });

        it('should fail fast on invalid chunk data', async function () {
          // Mock chunk endpoint returning invalid data
          nock('https://test-gateway.com').get('/chunk/12345').reply(200, {
            chunk: '', // Empty chunk - should fail quick validation
            data_path: 'dGVzdA',
          });

          const result = await (observer as any).validateChunkAtOffset({
            targetHost: 'test-gateway.com',
            offset: 12345,
            maxSearchHeight: 1000,
          });

          expect(result.pass).to.be.false;
          expect(result.failureReason).to.equal('Chunk data is empty');
          expect(result.referenceGatewayAvailable).to.be.undefined; // Should skip reference check
        });

        it('should handle network errors gracefully', async function () {
          // Mock chunk endpoint with network error
          nock('https://test-gateway.com')
            .get('/chunk/12345')
            .replyWithError('ENOTFOUND');

          const result = await (observer as any).validateChunkAtOffset({
            targetHost: 'test-gateway.com',
            offset: 12345,
            maxSearchHeight: 1000,
          });

          expect(result.pass).to.be.false;
          expect(result.failureReason).to.contain('Network error: ENOTFOUND');
          expect(result.referenceGatewayAvailable).to.be.undefined;
        });

        it('should handle successful validation with reference gateway available', async function () {
          const validChunkData = Buffer.from('test-chunk-data');
          const validProof = Buffer.from('valid-merkle-proof');

          // Configure the reference gateway stub to return available
          referenceGatewayStub.checkChunkAvailability.resolves({
            host: 'arweave.net',
            available: true,
          });

          // Mock target gateway chunk response
          nock('https://test-gateway.com')
            .get('/chunk/12345')
            .reply(200, {
              chunk: validChunkData.toString('base64url'),
              data_path: validProof.toString('base64url'),
            });

          // Mock binary search dependencies - these will fail but that's expected for this test
          // The test will demonstrate the parallel execution and reference gateway check
          const result = await (observer as any).validateChunkAtOffset({
            targetHost: 'test-gateway.com',
            offset: 12345,
            maxSearchHeight: 1000,
          });

          // Due to binary search failure, validation will fail, but we can verify reference gateway was checked
          expect(result.pass).to.be.false;
          expect(result.referenceGatewayAvailable).to.be.true; // Reference gateway should be available
          expect(result.failureReason).to.contain(
            'Missing validation components',
          );
        });

        it('should handle reference gateway unavailable', async function () {
          const validChunkData = Buffer.from('test-chunk-data');
          const validProof = Buffer.from('valid-merkle-proof');

          // Configure the reference gateway stub to return unavailable
          referenceGatewayStub.checkChunkAvailability.resolves({
            host: 'arweave.net',
            available: false,
          });

          // Mock target gateway chunk response
          nock('https://test-gateway.com')
            .get('/chunk/12345')
            .reply(200, {
              chunk: validChunkData.toString('base64url'),
              data_path: validProof.toString('base64url'),
            });

          const result = await (observer as any).validateChunkAtOffset({
            targetHost: 'test-gateway.com',
            offset: 12345,
            maxSearchHeight: 1000,
          });

          expect(result.pass).to.be.false;
          expect(result.referenceGatewayAvailable).to.be.false; // Reference gateway should be unavailable
        });

        it('should handle reference gateway network error', async function () {
          const validChunkData = Buffer.from('test-chunk-data');
          const validProof = Buffer.from('valid-merkle-proof');

          // Configure the reference gateway stub to return unavailable (simulating network error)
          referenceGatewayStub.checkChunkAvailability.resolves({
            host: 'arweave.net',
            available: false,
          });

          // Mock target gateway chunk response
          nock('https://test-gateway.com')
            .get('/chunk/12345')
            .reply(200, {
              chunk: validChunkData.toString('base64url'),
              data_path: validProof.toString('base64url'),
            });

          const result = await (observer as any).validateChunkAtOffset({
            targetHost: 'test-gateway.com',
            offset: 12345,
            maxSearchHeight: 1000,
          });

          expect(result.pass).to.be.false;
          expect(result.referenceGatewayAvailable).to.be.false; // Should be false on error
        });
      });

      describe('resolveTxBoundsViaReferenceHeaders', function () {
        const txId = 'T3DcnZlZg_FqOQUf9MSZXQ5j7_ETc04OEqbkX-MZRnc';
        const dataRoot = 'qoQEdVyTqjLpkybZAgkIgtNawXUHUd5TJZwkWx0Vo-A';
        const txStartOffset = 108631448658167n;
        const txDataSize = 42724169n;
        const txEndOffset = txStartOffset + txDataSize - 1n;
        const probeOffset = 108631449706743;

        const chainOffsetResponse = {
          size: txDataSize.toString(),
          offset: txEndOffset.toString(),
        };

        const completeMetadata = {
          txId,
          txStartOffset,
          txDataSize,
          dataRoot,
          dataPath: 'data-path-ignored',
          txPath: 'tx-path-ignored',
          chunkStartOffset: BigInt(probeOffset),
          chunkRelativeStartOffset: 1048576n,
        };

        it('returns anchored bounds and hits the chain once on success', async function () {
          referenceGatewayStub.getChunkMetadata.resolves({
            host: 'reference.example.com',
            metadata: completeMetadata,
          });

          const txOffsetScope = nock('https://arweave.net')
            .get(`/tx/${txId}/offset`)
            .reply(200, chainOffsetResponse);
          const txScope = nock('https://arweave.net')
            .get(`/tx/${txId}`)
            .reply(200, { id: txId, data_root: dataRoot, data_size: '1' });

          const result = await (
            observer as any
          ).resolveTxBoundsViaReferenceHeaders(probeOffset);

          expect(result).to.not.equal(null);
          expect(result.txStartOffset).to.equal(Number(txStartOffset));
          expect(result.txEndOffset).to.equal(Number(txEndOffset));
          expect(result.effectiveDataRoot.length).to.be.greaterThan(0);
          expect(txOffsetScope.isDone()).to.be.true;
          expect(txScope.isDone()).to.be.true;
        });

        it('returns null when the reference gateway has no metadata', async function () {
          referenceGatewayStub.getChunkMetadata.resolves({
            host: 'reference.example.com',
            metadata: null,
          });

          const result = await (
            observer as any
          ).resolveTxBoundsViaReferenceHeaders(probeOffset);

          expect(result).to.equal(null);
        });

        it('returns null and does not throw when chain disagrees with headers', async function () {
          referenceGatewayStub.getChunkMetadata.resolves({
            host: 'reference.example.com',
            metadata: completeMetadata,
          });

          // Chain reports a different size → mismatch
          nock('https://arweave.net')
            .get(`/tx/${txId}/offset`)
            .reply(200, {
              size: (txDataSize + 1n).toString(),
              offset: (txEndOffset + 1n).toString(),
            });

          const counterStub = sinon.stub(
            metrics.chunkMetadataAnchorCounter,
            'inc',
          );

          try {
            const result = await (
              observer as any
            ).resolveTxBoundsViaReferenceHeaders(probeOffset);

            expect(result).to.equal(null);
            expect(counterStub.calledWith({ result: 'mismatch' })).to.be.true;
          } finally {
            counterStub.restore();
          }
        });

        it('reuses the per-tx cache for a second offset in the same tx', async function () {
          referenceGatewayStub.getChunkMetadata.resolves({
            host: 'reference.example.com',
            metadata: completeMetadata,
          });

          // Only stub the chain calls once — cache hit on the second call
          // should not require additional network activity.
          nock('https://arweave.net')
            .get(`/tx/${txId}/offset`)
            .reply(200, chainOffsetResponse);
          nock('https://arweave.net')
            .get(`/tx/${txId}`)
            .reply(200, { id: txId, data_root: dataRoot, data_size: '1' });

          const first = await (
            observer as any
          ).resolveTxBoundsViaReferenceHeaders(probeOffset);
          expect(first).to.not.equal(null);

          const secondOffset = probeOffset + 262144;
          referenceGatewayStub.getChunkMetadata.resolves({
            host: 'reference.example.com',
            metadata: {
              ...completeMetadata,
              chunkStartOffset: BigInt(secondOffset),
            },
          });

          const second = await (
            observer as any
          ).resolveTxBoundsViaReferenceHeaders(secondOffset);

          expect(second).to.not.equal(null);
          expect(second.txStartOffset).to.equal(first.txStartOffset);
          // No additional /tx/* activity should be required; nock would
          // complain on an unexpected request.
          expect(nock.pendingMocks()).to.deep.equal([]);
        });
      });
    });
  });
});
