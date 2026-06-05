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

import { completeHeaders } from '../lib/chunk-header.fixtures.js';
import * as metrics from '../metrics.js';
import { FallbackReferenceGateway } from './fallback-reference-gateway.js';

describe('FallbackReferenceGateway', function () {
  let logStub: winston.Logger;
  let fallbackCounterStub: sinon.SinonStub;

  const defaultArnsResolvedId = 'test-resolved-id-12345';
  const defaultArnsTtlSeconds = '300';
  const entropy = Buffer.from('test-entropy');

  beforeEach(function () {
    nock.cleanAll();

    logStub = {
      child: sinon.stub().returnsThis(),
      debug: sinon.stub(),
      verbose: sinon.stub(),
      error: sinon.stub(),
    } as any;

    fallbackCounterStub = sinon.stub(
      metrics.referenceGatewayFallbackCounter,
      'inc',
    );
  });

  afterEach(function () {
    sinon.restore();
    nock.cleanAll();
  });

  describe('constructor', function () {
    it('should throw an error if hosts array is empty', function () {
      expect(
        () =>
          new FallbackReferenceGateway({
            hosts: [],
            nodeReleaseVersion: 'test-version',
            log: logStub,
          }),
      ).to.throw('At least one reference gateway host is required');
    });

    it('should create instance with valid hosts', function () {
      const gateway = new FallbackReferenceGateway({
        hosts: ['gateway1.com'],
        nodeReleaseVersion: 'test-version',
        log: logStub,
      });

      expect(gateway).to.be.instanceOf(FallbackReferenceGateway);
      expect(
        (logStub.child as sinon.SinonStub).calledWith({
          class: 'FallbackReferenceGateway',
        }),
      ).to.be.true;
    });
  });

  describe('getArnsResolution', function () {
    it('should return resolution from first host without incrementing fallback counter', async function () {
      const gateway = new FallbackReferenceGateway({
        hosts: ['gateway1.com', 'gateway2.com'],
        nodeReleaseVersion: 'test-version',
        log: logStub,
      });

      const data = Buffer.alloc(100, 'a').toString();

      // First host succeeds
      nock('https://testname.gateway1.com')
        .head('/')
        .reply(200, undefined, {
          'Content-Type': 'application/octet-stream',
          'x-arns-resolved-id': defaultArnsResolvedId,
          'x-arns-ttl-seconds': defaultArnsTtlSeconds,
          'Content-Length': String(data.length),
        });
      nock('https://testname.gateway1.com')
        .get('/')
        .reply(200, data, {
          'Content-Type': 'application/octet-stream',
          'x-arns-resolved-id': defaultArnsResolvedId,
          'x-arns-ttl-seconds': defaultArnsTtlSeconds,
          'Content-Length': String(data.length),
        });

      const result = await gateway.getArnsResolution({
        arnsName: 'testname',
        entropy,
      });

      expect(result.host).to.equal('gateway1.com');
      expect(result.resolution.resolvedId).to.equal(defaultArnsResolvedId);
      expect(result.resolution.ttlSeconds).to.equal(defaultArnsTtlSeconds);
      expect(fallbackCounterStub.called).to.be.false;
    });

    it('should fallback to second host when first fails and increment counter for second host', async function () {
      const gateway = new FallbackReferenceGateway({
        hosts: ['gateway1.com', 'gateway2.com'],
        nodeReleaseVersion: 'test-version',
        log: logStub,
      });

      const data = Buffer.alloc(100, 'a').toString();

      // First host fails
      nock('https://testname.gateway1.com')
        .head('/')
        .replyWithError('ENOTFOUND');

      // Second host succeeds
      nock('https://testname.gateway2.com')
        .head('/')
        .reply(200, undefined, {
          'Content-Type': 'application/octet-stream',
          'x-arns-resolved-id': defaultArnsResolvedId,
          'x-arns-ttl-seconds': defaultArnsTtlSeconds,
          'Content-Length': String(data.length),
        });
      nock('https://testname.gateway2.com')
        .get('/')
        .reply(200, data, {
          'Content-Type': 'application/octet-stream',
          'x-arns-resolved-id': defaultArnsResolvedId,
          'x-arns-ttl-seconds': defaultArnsTtlSeconds,
          'Content-Length': String(data.length),
        });

      const result = await gateway.getArnsResolution({
        arnsName: 'testname',
        entropy,
      });

      expect(result.host).to.equal('gateway2.com');
      expect(result.resolution.resolvedId).to.equal(defaultArnsResolvedId);

      // Counter should be incremented once for gateway2.com
      expect(fallbackCounterStub.calledOnce).to.be.true;
      expect(
        fallbackCounterStub.calledWith({
          operation: 'getArnsResolution',
          host: 'gateway2.com',
        }),
      ).to.be.true;
    });

    it('should fallback through multiple hosts and increment counter for each fallback', async function () {
      const gateway = new FallbackReferenceGateway({
        hosts: ['gateway1.com', 'gateway2.com', 'gateway3.com'],
        nodeReleaseVersion: 'test-version',
        log: logStub,
      });

      const data = Buffer.alloc(100, 'a').toString();

      // First host fails
      nock('https://testname.gateway1.com')
        .head('/')
        .replyWithError('ENOTFOUND');

      // Second host fails
      nock('https://testname.gateway2.com')
        .head('/')
        .replyWithError('ECONNREFUSED');

      // Third host succeeds
      nock('https://testname.gateway3.com')
        .head('/')
        .reply(200, undefined, {
          'Content-Type': 'application/octet-stream',
          'x-arns-resolved-id': defaultArnsResolvedId,
          'x-arns-ttl-seconds': defaultArnsTtlSeconds,
          'Content-Length': String(data.length),
        });
      nock('https://testname.gateway3.com')
        .get('/')
        .reply(200, data, {
          'Content-Type': 'application/octet-stream',
          'x-arns-resolved-id': defaultArnsResolvedId,
          'x-arns-ttl-seconds': defaultArnsTtlSeconds,
          'Content-Length': String(data.length),
        });

      const result = await gateway.getArnsResolution({
        arnsName: 'testname',
        entropy,
      });

      expect(result.host).to.equal('gateway3.com');

      // Counter should be incremented twice: once for gateway2.com, once for gateway3.com
      expect(fallbackCounterStub.calledTwice).to.be.true;
      expect(
        fallbackCounterStub.firstCall.calledWith({
          operation: 'getArnsResolution',
          host: 'gateway2.com',
        }),
      ).to.be.true;
      expect(
        fallbackCounterStub.secondCall.calledWith({
          operation: 'getArnsResolution',
          host: 'gateway3.com',
        }),
      ).to.be.true;
    });

    it('should throw error when all hosts fail', async function () {
      const gateway = new FallbackReferenceGateway({
        hosts: ['gateway1.com', 'gateway2.com'],
        nodeReleaseVersion: 'test-version',
        log: logStub,
      });

      // First host fails
      nock('https://testname.gateway1.com')
        .head('/')
        .replyWithError('ENOTFOUND');

      // Second host fails
      nock('https://testname.gateway2.com')
        .head('/')
        .replyWithError('ECONNREFUSED');

      try {
        await gateway.getArnsResolution({
          arnsName: 'testname',
          entropy,
        });
        expect.fail('Should have thrown an error');
      } catch (error: any) {
        expect(error.message).to.include(
          'getArnsResolution failed on all hosts',
        );
      }
    });

    it('should throw when missing x-arns-resolved-id header for non-404 response', async function () {
      const gateway = new FallbackReferenceGateway({
        hosts: ['gateway1.com', 'gateway2.com'],
        nodeReleaseVersion: 'test-version',
        log: logStub,
      });

      const data = Buffer.alloc(100, 'a').toString();

      // First host returns response without x-arns-resolved-id
      nock('https://testname.gateway1.com')
        .head('/')
        .reply(200, undefined, {
          'Content-Type': 'application/octet-stream',
          'x-arns-ttl-seconds': defaultArnsTtlSeconds,
          'Content-Length': String(data.length),
        });
      nock('https://testname.gateway1.com')
        .get('/')
        .reply(200, data, {
          'Content-Type': 'application/octet-stream',
          'x-arns-ttl-seconds': defaultArnsTtlSeconds,
          'Content-Length': String(data.length),
        });

      // Second host also missing header
      nock('https://testname.gateway2.com')
        .head('/')
        .reply(200, undefined, {
          'Content-Type': 'application/octet-stream',
          'x-arns-ttl-seconds': defaultArnsTtlSeconds,
          'Content-Length': String(data.length),
        });
      nock('https://testname.gateway2.com')
        .get('/')
        .reply(200, data, {
          'Content-Type': 'application/octet-stream',
          'x-arns-ttl-seconds': defaultArnsTtlSeconds,
          'Content-Length': String(data.length),
        });

      try {
        await gateway.getArnsResolution({
          arnsName: 'testname',
          entropy,
        });
        expect.fail('Should have thrown an error');
      } catch (error: any) {
        expect(error.message).to.include(
          'getArnsResolution failed on all hosts',
        );
        expect(error.message).to.include('Missing x-arns-resolved-id');
      }
    });

    it('should throw when missing x-arns-ttl-seconds header for non-404 response', async function () {
      const gateway = new FallbackReferenceGateway({
        hosts: ['gateway1.com', 'gateway2.com'],
        nodeReleaseVersion: 'test-version',
        log: logStub,
      });

      const data = Buffer.alloc(100, 'a').toString();

      // First host returns response without x-arns-ttl-seconds
      nock('https://testname.gateway1.com')
        .head('/')
        .reply(200, undefined, {
          'Content-Type': 'application/octet-stream',
          'x-arns-resolved-id': defaultArnsResolvedId,
          'Content-Length': String(data.length),
        });
      nock('https://testname.gateway1.com')
        .get('/')
        .reply(200, data, {
          'Content-Type': 'application/octet-stream',
          'x-arns-resolved-id': defaultArnsResolvedId,
          'Content-Length': String(data.length),
        });

      // Second host also missing header
      nock('https://testname.gateway2.com')
        .head('/')
        .reply(200, undefined, {
          'Content-Type': 'application/octet-stream',
          'x-arns-resolved-id': defaultArnsResolvedId,
          'Content-Length': String(data.length),
        });
      nock('https://testname.gateway2.com')
        .get('/')
        .reply(200, data, {
          'Content-Type': 'application/octet-stream',
          'x-arns-resolved-id': defaultArnsResolvedId,
          'Content-Length': String(data.length),
        });

      try {
        await gateway.getArnsResolution({
          arnsName: 'testname',
          entropy,
        });
        expect.fail('Should have thrown an error');
      } catch (error: any) {
        expect(error.message).to.include(
          'getArnsResolution failed on all hosts',
        );
        expect(error.message).to.include('Missing x-arns-ttl-seconds');
      }
    });

    it('should skip header validation for 404 response', async function () {
      const gateway = new FallbackReferenceGateway({
        hosts: ['gateway1.com'],
        nodeReleaseVersion: 'test-version',
        log: logStub,
      });

      // Return 404 without ArNS headers
      nock('https://testname.gateway1.com').head('/').reply(404);

      const result = await gateway.getArnsResolution({
        arnsName: 'testname',
        entropy,
      });

      expect(result.host).to.equal('gateway1.com');
      expect(result.resolution.statusCode).to.equal(404);
      expect(result.resolution.resolvedId).to.be.null;
      expect(result.resolution.ttlSeconds).to.be.null;
      expect(fallbackCounterStub.called).to.be.false;
    });
  });

  describe('checkChunkAvailability', function () {
    it('should return available true when chunk is valid', async function () {
      const gateway = new FallbackReferenceGateway({
        hosts: ['gateway1.com'],
        nodeReleaseVersion: 'test-version',
        log: logStub,
      });

      nock('https://gateway1.com')
        .get('/chunk/12345')
        .reply(200, { chunk: 'test-chunk-data', data_path: 'test-path' });

      const result = await gateway.checkChunkAvailability({ offset: 12345 });

      expect(result.host).to.equal('gateway1.com');
      expect(result.available).to.be.true;
      expect(fallbackCounterStub.called).to.be.false;
    });

    it('should throw when all hosts fail with network errors', async function () {
      const gateway = new FallbackReferenceGateway({
        hosts: ['gateway1.com', 'gateway2.com'],
        nodeReleaseVersion: 'test-version',
        log: logStub,
      });

      // Both hosts fail with network errors
      nock('https://gateway1.com')
        .get('/chunk/12345')
        .replyWithError('ENOTFOUND');

      nock('https://gateway2.com')
        .get('/chunk/12345')
        .replyWithError('ECONNREFUSED');

      try {
        await gateway.checkChunkAvailability({ offset: 12345 });
        expect.fail('Should have thrown an error');
      } catch (error: any) {
        expect(error.message).to.include(
          'checkChunkAvailability failed on all hosts',
        );
      }
    });

    it('should return available false when first host returns 404', async function () {
      const gateway = new FallbackReferenceGateway({
        hosts: ['gateway1.com', 'gateway2.com'],
        nodeReleaseVersion: 'test-version',
        log: logStub,
      });

      // First host returns 404 - authoritative "chunk not found"
      nock('https://gateway1.com')
        .get('/chunk/12345')
        .reply(404, { error: 'Chunk not found' });

      const result = await gateway.checkChunkAvailability({ offset: 12345 });

      expect(result.host).to.equal('gateway1.com');
      expect(result.available).to.be.false;
      // Should NOT try second host or increment fallback counter
      expect(fallbackCounterStub.called).to.be.false;
    });

    it('should return available false when first host returns 410', async function () {
      const gateway = new FallbackReferenceGateway({
        hosts: ['gateway1.com', 'gateway2.com'],
        nodeReleaseVersion: 'test-version',
        log: logStub,
      });

      // First host returns 410 - authoritative "chunk gone"
      nock('https://gateway1.com')
        .get('/chunk/12345')
        .reply(410, { error: 'Chunk gone' });

      const result = await gateway.checkChunkAvailability({ offset: 12345 });

      expect(result.host).to.equal('gateway1.com');
      expect(result.available).to.be.false;
      // Should NOT try second host or increment fallback counter
      expect(fallbackCounterStub.called).to.be.false;
    });

    it('should throw when all hosts return non-200/404/410 status', async function () {
      const gateway = new FallbackReferenceGateway({
        hosts: ['gateway1.com', 'gateway2.com'],
        nodeReleaseVersion: 'test-version',
        log: logStub,
      });

      // Both hosts return 500 (server error, not chunk not found)
      nock('https://gateway1.com').get('/chunk/12345').reply(500, {});
      nock('https://gateway2.com').get('/chunk/12345').reply(500, {});

      try {
        await gateway.checkChunkAvailability({ offset: 12345 });
        expect.fail('Should have thrown an error');
      } catch (error: any) {
        expect(error.message).to.include(
          'checkChunkAvailability failed on all hosts',
        );
      }
    });

    it('should throw when all hosts return response without chunk field', async function () {
      const gateway = new FallbackReferenceGateway({
        hosts: ['gateway1.com', 'gateway2.com'],
        nodeReleaseVersion: 'test-version',
        log: logStub,
      });

      // First host returns response without chunk field
      nock('https://gateway1.com')
        .get('/chunk/12345')
        .reply(200, { data_path: 'test-path' });

      // Second host also returns response without chunk field
      nock('https://gateway2.com')
        .get('/chunk/12345')
        .reply(200, { data_path: 'test-path' });

      try {
        await gateway.checkChunkAvailability({ offset: 12345 });
        expect.fail('Should have thrown an error');
      } catch (error: any) {
        expect(error.message).to.include(
          'checkChunkAvailability failed on all hosts',
        );
        expect(error.message).to.include('Missing chunk field');
      }
    });

    it('should fallback to second host when first fails and increment counter', async function () {
      const gateway = new FallbackReferenceGateway({
        hosts: ['gateway1.com', 'gateway2.com'],
        nodeReleaseVersion: 'test-version',
        log: logStub,
      });

      // First host fails
      nock('https://gateway1.com')
        .get('/chunk/12345')
        .replyWithError('ENOTFOUND');

      // Second host succeeds
      nock('https://gateway2.com')
        .get('/chunk/12345')
        .reply(200, { chunk: 'test-chunk-data', data_path: 'test-path' });

      const result = await gateway.checkChunkAvailability({ offset: 12345 });

      expect(result.host).to.equal('gateway2.com');
      expect(result.available).to.be.true;

      // Counter should be incremented for gateway2.com
      expect(fallbackCounterStub.calledOnce).to.be.true;
      expect(
        fallbackCounterStub.calledWith({
          operation: 'checkChunkAvailability',
          host: 'gateway2.com',
        }),
      ).to.be.true;
    });
  });

  describe('getChunkMetadata', function () {
    it('returns parsed metadata when all required headers are present', async function () {
      const gateway = new FallbackReferenceGateway({
        hosts: ['gateway1.com'],
        nodeReleaseVersion: 'test-version',
        log: logStub,
      });

      nock('https://gateway1.com')
        .head('/chunk/12345/data')
        .reply(200, '', completeHeaders);

      const result = await gateway.getChunkMetadata({ offset: 12345 });

      expect(result.host).to.equal('gateway1.com');
      expect(result.metadata).to.not.equal(null);
      expect(result.metadata!.txId).to.equal(
        completeHeaders['x-arweave-chunk-tx-id'],
      );
      expect(result.metadata!.txStartOffset).to.equal(108631448658167n);
      expect(fallbackCounterStub.called).to.be.false;
    });

    it('falls through to next host when first returns 200 but omits headers', async function () {
      const gateway = new FallbackReferenceGateway({
        hosts: ['gateway1.com', 'gateway2.com'],
        nodeReleaseVersion: 'test-version',
        log: logStub,
      });

      // Older gateway: 200 OK but no x-arweave-chunk-* headers
      nock('https://gateway1.com').head('/chunk/12345/data').reply(200, '', {});
      // Newer gateway further down the list supports the headers
      nock('https://gateway2.com')
        .head('/chunk/12345/data')
        .reply(200, '', completeHeaders);

      const result = await gateway.getChunkMetadata({ offset: 12345 });

      expect(result.host).to.equal('gateway2.com');
      expect(result.metadata).to.not.equal(null);
      expect(
        fallbackCounterStub.calledWith({
          operation: 'getChunkMetadata',
          host: 'gateway2.com',
        }),
      ).to.be.true;
    });

    it('returns metadata:null against last reachable host when no host exposes headers', async function () {
      const gateway = new FallbackReferenceGateway({
        hosts: ['gateway1.com', 'gateway2.com'],
        nodeReleaseVersion: 'test-version',
        log: logStub,
      });

      nock('https://gateway1.com').head('/chunk/12345/data').reply(200, '', {});
      nock('https://gateway2.com').head('/chunk/12345/data').reply(200, '', {});

      const result = await gateway.getChunkMetadata({ offset: 12345 });

      // Last reachable host reported — caller distinguishes "feature
      // unavailable" (metadata null) from "all hosts down" (throws).
      expect(result.host).to.equal('gateway2.com');
      expect(result.metadata).to.equal(null);
    });

    it('falls through to next host on 404 (endpoint may not be supported)', async function () {
      const gateway = new FallbackReferenceGateway({
        hosts: ['gateway1.com', 'gateway2.com'],
        nodeReleaseVersion: 'test-version',
        log: logStub,
      });

      nock('https://gateway1.com').head('/chunk/12345/data').reply(404);
      nock('https://gateway2.com')
        .head('/chunk/12345/data')
        .reply(200, '', completeHeaders);

      const result = await gateway.getChunkMetadata({ offset: 12345 });

      expect(result.host).to.equal('gateway2.com');
      expect(result.metadata).to.not.equal(null);
      expect(
        fallbackCounterStub.calledWith({
          operation: 'getChunkMetadata',
          host: 'gateway2.com',
        }),
      ).to.be.true;
    });

    it('returns metadata:null against last reachable host when only host returns 404', async function () {
      const gateway = new FallbackReferenceGateway({
        hosts: ['gateway1.com'],
        nodeReleaseVersion: 'test-version',
        log: logStub,
      });

      nock('https://gateway1.com').head('/chunk/12345/data').reply(404);

      const result = await gateway.getChunkMetadata({ offset: 12345 });

      expect(result.host).to.equal('gateway1.com');
      expect(result.metadata).to.equal(null);
    });

    it('returns metadata:null against last reachable host when only host returns 410', async function () {
      const gateway = new FallbackReferenceGateway({
        hosts: ['gateway1.com'],
        nodeReleaseVersion: 'test-version',
        log: logStub,
      });

      nock('https://gateway1.com').head('/chunk/12345/data').reply(410);

      const result = await gateway.getChunkMetadata({ offset: 12345 });

      expect(result.host).to.equal('gateway1.com');
      expect(result.metadata).to.equal(null);
    });

    it('falls back to second host on network error and increments counter', async function () {
      const gateway = new FallbackReferenceGateway({
        hosts: ['gateway1.com', 'gateway2.com'],
        nodeReleaseVersion: 'test-version',
        log: logStub,
      });

      nock('https://gateway1.com')
        .head('/chunk/12345/data')
        .replyWithError('ENOTFOUND');

      nock('https://gateway2.com')
        .head('/chunk/12345/data')
        .reply(200, '', completeHeaders);

      const result = await gateway.getChunkMetadata({ offset: 12345 });

      expect(result.host).to.equal('gateway2.com');
      expect(result.metadata).to.not.equal(null);
      expect(
        fallbackCounterStub.calledWith({
          operation: 'getChunkMetadata',
          host: 'gateway2.com',
        }),
      ).to.be.true;
    });

    it('throws when all hosts fail with non-404/410 errors', async function () {
      const gateway = new FallbackReferenceGateway({
        hosts: ['gateway1.com', 'gateway2.com'],
        nodeReleaseVersion: 'test-version',
        log: logStub,
      });

      nock('https://gateway1.com')
        .head('/chunk/12345/data')
        .replyWithError('ENOTFOUND');
      nock('https://gateway2.com').head('/chunk/12345/data').reply(500);

      try {
        await gateway.getChunkMetadata({ offset: 12345 });
        expect.fail('Should have thrown');
      } catch (error: any) {
        expect(error.message).to.include(
          'getChunkMetadata failed on all hosts',
        );
      }
    });

    it('returns metadata:null when headers are malformed', async function () {
      const gateway = new FallbackReferenceGateway({
        hosts: ['gateway1.com'],
        nodeReleaseVersion: 'test-version',
        log: logStub,
      });

      nock('https://gateway1.com')
        .head('/chunk/12345/data')
        .reply(200, '', {
          ...completeHeaders,
          'x-arweave-chunk-tx-start-offset': 'not-a-number',
        });

      const result = await gateway.getChunkMetadata({ offset: 12345 });
      expect(result.metadata).to.equal(null);
    });
  });
});
