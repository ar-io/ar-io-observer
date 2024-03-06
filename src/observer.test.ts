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
import crypto from 'node:crypto';

import {
  bufferToSeed,
  customPRNG,
  generateRandomRanges,
  getArnsResolution,
} from './observer.js';

const OneMiB = 1048576;

const entropy = Buffer.from('entropy');

describe('Observer', function () {
  describe('getArnsResolution', function () {
    const host = 'example.com';
    const arnsName = 'test';
    const baseURL = `https://${arnsName}.${host}`;

    const defaultContentType = 'application/octet-stream';
    const defaultArnsResolvedId = '12345';
    const defaultArnsTtlSeconds = '300';

    beforeEach(function () {
      nock.cleanAll();
    });

    it('should correctly hash data for responses under 1MiB', async function () {
      const data = Buffer.alloc(100, 'a').toString();
      nock(baseURL)
        .head('/')
        .reply(200, undefined, {
          'Content-Type': defaultContentType,
          'x-arns-resolved-id': defaultArnsResolvedId,
          'x-arns-ttl-seconds': defaultArnsTtlSeconds,
          'Content-Length': String(data.length),
        });
      nock(baseURL)
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

      const result = await getArnsResolution({ host, arnsName, entropy });

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
      const rng = customPRNG(bufferToSeed(entropy));
      const ranges = generateRandomRanges({
        contentSize: largeContent.length,
        rangeSize: 200,
        rangeQuantity: 5,
        rng,
      });

      nock(baseURL)
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
        nock(baseURL)
          .get('/')
          .matchHeader('Range', `bytes=${range}`)
          .reply(206, partialContent, {
            'Content-Type': defaultContentType,
            'Content-Range': `bytes ${range}/${largeContent.length}`,
          });
      });

      const result = await getArnsResolution({
        host,
        arnsName,
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
      nock(baseURL).head('/').reply(404);

      const result = await getArnsResolution({ host, arnsName, entropy });

      expect(result.statusCode).to.equal(404);
      expect(result.resolvedId).to.be.null;
      expect(result.ttlSeconds).to.be.null;
      expect(result.contentType).to.be.null;
      expect(result.contentLength).to.be.null;
      expect(result.dataHashDigest).to.be.null;
      expect(result.timings).to.be.null;
    });

    it('should resolve with correct properties on a 404 response for GET requests', async function () {
      nock(baseURL)
        .head('/')
        .reply(200, undefined, { 'Content-Length': '100' });
      nock(baseURL).get('/').reply(404);

      const result = await getArnsResolution({ host, arnsName, entropy });

      expect(result.statusCode).to.equal(404);
      expect(result.resolvedId).to.be.null;
      expect(result.ttlSeconds).to.be.null;
      expect(result.contentType).to.be.null;
      expect(result.contentLength).to.be.null;
      expect(result.dataHashDigest).to.be.null;
      expect(result.timings).to.be.null;
    });

    it('should handle non-404 errors appropriately for HEAD requests', async function () {
      nock(baseURL).head('/').reply(500);

      try {
        await getArnsResolution({ host, arnsName, entropy });
      } catch (error: any) {
        expect(error).to.exist;
      }
    });

    it('should handle non-404 errors appropriately for GET requests', async function () {
      nock(baseURL)
        .head('/')
        .reply(200, undefined, { 'Content-Length': '100' });
      nock(baseURL).get('/').reply(500);

      try {
        await getArnsResolution({ host, arnsName, entropy });
      } catch (error: any) {
        expect(error).to.exist;
        expect(error.response).to.exist;
        expect(error.response.statusCode).to.equal(500);
      }
    });

    it('should add "X-AR-IO-Node-Release" header when making a request to a reference gateway', async function () {
      const data = Buffer.alloc(100, 'a').toString();
      const headScope = nock(baseURL, {
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
      const getScope = nock(baseURL, {
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

      await getArnsResolution({
        host,
        arnsName,
        nodeReleaseVersion: 'test',
        entropy,
      });

      expect(headScope.isDone()).to.be.true;
      expect(getScope.isDone()).to.be.true;
    });

    it('should not add "X-AR-IO-Node-Release" header when assessing a gateway', async function () {
      const data = Buffer.alloc(100, 'a').toString();
      const headScope = nock(baseURL, {
        badheaders: ['X-AR-IO-Node-Release'],
      })
        .head('/')
        .reply(200, undefined, {
          'Content-Type': defaultContentType,
          'x-arns-resolved-id': defaultArnsResolvedId,
          'x-arns-ttl-seconds': defaultArnsTtlSeconds,
          'Content-Length': String(data.length),
        });
      const getScope = nock(baseURL, {
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
        host,
        arnsName,
        entropy,
      });

      expect(headScope.isDone()).to.be.true;
      expect(getScope.isDone()).to.be.true;
    });
  });

  describe('bufferToSeed', function () {
    it('should convert a buffer to an array of numbers between 0 and 1', function () {
      const buffer = Buffer.from([0, 127, 255]);
      const expected = [0, 127 / 255, 1];
      const result = bufferToSeed(buffer);
      expect(result).to.deep.equal(expected);
    });

    it('should throw an error if the buffer is empty', function () {
      const buffer = Buffer.from([]);
      expect(() => bufferToSeed(buffer)).to.throw(
        'Buffer is empty. Non-empty buffer required.',
      );
    });

    it('should handle a buffer with a single element', function () {
      const buffer = Buffer.from([128]);
      const expected = [128 / 255];
      const result = bufferToSeed(buffer);
      expect(result).to.deep.equal(expected);
    });

    it('should produce values strictly less than 1 for non-255 bytes', function () {
      const buffer = Buffer.from([0, 1, 254]);
      const result = bufferToSeed(buffer);
      result.forEach((value, index) => {
        if (index < 2) {
          // Only check the first two elements, as the third is intentionally 254/255
          expect(value).to.be.lessThan(1);
        }
      });
    });

    it('should produce a value of 1 for byte value 255', function () {
      const buffer = Buffer.from([255]);
      const result = bufferToSeed(buffer);
      expect(result[0]).to.equal(1);
    });
  });

  describe('customPRNG', function () {
    it('should generate numbers based on the seed array', function () {
      const seed = [0.1, 0.2, 0.3];
      const prng = customPRNG(seed);
      expect(prng()).to.equal(0.1);
      expect(prng()).to.equal(0.2);
      expect(prng()).to.equal(0.3);
    });

    it('should cycle back to the start of the seed array after reaching the end', function () {
      const seed = [0.4, 0.5];
      const prng = customPRNG(seed);
      prng(); // Call once
      prng(); // Call twice
      expect(prng()).to.equal(0.4); // Should cycle back to the first element
    });

    it('should handle a single-element seed array correctly', function () {
      const seed = [0.6];
      const prng = customPRNG(seed);
      expect(prng()).to.equal(0.6);
      expect(prng()).to.equal(0.6); // Should keep returning the same element
    });

    it('should throw an error if the seed array is empty', function () {
      expect(() => customPRNG([])).to.throw('Seed array must not be empty.');
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
});
