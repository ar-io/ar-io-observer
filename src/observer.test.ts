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

import { getArnsResolution } from './observer.js';

const OneMiB = 1048576;

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

    const result = await getArnsResolution({ host, arnsName });

    expect(result.statusCode).to.equal(200);
    expect(result.resolvedId).to.equal(defaultArnsResolvedId);
    expect(result.ttlSeconds).to.equal(defaultArnsTtlSeconds);
    expect(result.contentType).to.equal(defaultContentType);
    expect(result.contentLength).to.equal(String(data.length));
    expect(result.dataHashDigest).to.equal(expectedHash);
    expect(result.timings).to.be.a.string;
  });

  it('should only process the first 1MiB of data', async function () {
    const oneMiBData = Buffer.alloc(OneMiB, 'a').toString();
    const oneMiBPlusData = oneMiBData + 'extra data';
    nock(baseURL)
      .get('/')
      .reply(200, oneMiBPlusData, {
        'Content-Type': defaultContentType,
        'x-arns-resolved-id': defaultArnsResolvedId,
        'x-arns-ttl-seconds': defaultArnsTtlSeconds,
        'Content-Length': String(oneMiBPlusData.length),
      });
    const expectedHash = crypto
      .createHash('sha256')
      .update(Buffer.alloc(OneMiB, 'a'))
      .digest('base64url');

    const result = await getArnsResolution({
      host,
      arnsName,
    });

    expect(result.statusCode).to.equal(200);
    expect(result.resolvedId).to.equal(defaultArnsResolvedId);
    expect(result.ttlSeconds).to.equal(defaultArnsTtlSeconds);
    expect(result.contentType).to.equal(defaultContentType);
    expect(result.contentLength).to.equal(String(oneMiBPlusData.length));
    expect(result.dataHashDigest).to.equal(expectedHash);
    expect(result.timings).to.be.a.string;
  });

  it('should resolve with correct properties on a 404 response', async function () {
    nock(baseURL).get('/').reply(404);

    const result = await getArnsResolution({ host, arnsName });

    expect(result.statusCode).to.equal(404);
    expect(result.resolvedId).to.be.null;
    expect(result.ttlSeconds).to.be.null;
    expect(result.contentType).to.be.null;
    expect(result.contentLength).to.be.null;
    expect(result.dataHashDigest).to.be.null;
    expect(result.timings).to.be.null;
  });

  it('should handle non-404 errors appropriately', async function () {
    nock(baseURL).get('/').reply(500);

    try {
      await getArnsResolution({ host, arnsName });
    } catch (error: any) {
      expect(error).to.exist;
      expect(error.response).to.exist;
      expect(error.response.statusCode).to.equal(500);
    }
  });
});
