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
import winston from 'winston';

import { ArnsResolution, ReferenceGatewaySource } from '../types.js';
import { GatewayAssessor } from './gateway-assessor.js';

const HOST = 'gateway.example';
const BODY = 'hello';
const BODY_HASH = crypto.createHash('sha256').update(BODY).digest('base64url');

function referenceResolution(contentType: string): ArnsResolution {
  return {
    statusCode: 200,
    resolvedId: 'resolved-id',
    ttlSeconds: '3600',
    contentType,
    contentLength: String(BODY.length),
    dataHashDigest: BODY_HASH,
    timings: null,
  };
}

// A reference that resolves `names` and fails every other name.
function referenceGateway(
  names: Record<string, ArnsResolution>,
): ReferenceGatewaySource {
  return {
    async getArnsResolution({ arnsName }: { arnsName: string }) {
      const resolution = names[arnsName];
      if (resolution === undefined) {
        throw new Error(`getaddrinfo ENOTFOUND ${arnsName}.reference`);
      }
      return { host: 'reference.example', resolution };
    },
  } as unknown as ReferenceGatewaySource;
}

function serveName(name: string, contentType: string) {
  const headers = {
    'Content-Type': contentType,
    'Content-Length': String(BODY.length),
    'x-arns-resolved-id': 'resolved-id',
    'x-arns-ttl-seconds': '3600',
  };
  nock(`https://${name}.${HOST}`)
    .persist()
    .head('/')
    .reply(200, undefined, headers)
    .get('/')
    .reply(200, BODY, headers);
}

function assessor(names: Record<string, ArnsResolution>): GatewayAssessor {
  const a = new GatewayAssessor({
    referenceGateway: referenceGateway(names),
    nodeReleaseVersion: 'test',
    nameAssessmentConcurrency: 4,
    log: winston.createLogger({ silent: true }),
  });
  a.initializeForEpoch({ entropy: Buffer.from('entropy'), namesCount: 10 });
  return a;
}

describe('GatewayAssessor', () => {
  afterEach(() => {
    nock.cleanAll();
  });

  it('passes a name served with different content type parameters', async () => {
    serveName('json', 'application/json');
    const result = await assessor({
      json: referenceResolution('application/json; charset=utf-8'),
    }).assessArnsName({ host: HOST, arnsName: 'json' });
    expect(result.failureReason).to.be.undefined;
    expect(result.pass).to.be.true;
  });

  it('fails a name served with a different media type', async () => {
    serveName('html', 'application/json');
    const result = await assessor({
      html: referenceResolution('text/html'),
    }).assessArnsName({ host: HOST, arnsName: 'html' });
    expect(result.failureReason).to.equal('contentType mismatch');
    expect(result.pass).to.be.false;
  });

  it('leaves a name the reference cannot resolve out of the pass rate', async () => {
    // Four good names, one the gateway fails, one the reference cannot
    // resolve: 4 of 6 would fail the 80% threshold, 4 of 5 meets it.
    const names: Record<string, ArnsResolution> = {};
    for (const name of ['a', 'b', 'c', 'd', 'bad']) {
      names[name] = referenceResolution('text/plain');
    }
    for (const name of ['a', 'b', 'c', 'd']) {
      serveName(name, 'text/plain');
    }
    nock(`https://bad.${HOST}`).persist().head('/').reply(502);

    const result = await assessor(names).assessGatewayArns({
      host: HOST,
      prescribedNames: ['a', 'b'],
      chosenNames: ['c', 'd', 'bad', 'unresolvable'],
    });

    const skipped = result.chosenNames['unresolvable'];
    expect(skipped.pass).to.be.false;
    expect(skipped.excluded).to.be.true;
    expect(skipped.failureReason).to.match(/^Reference resolution failed: /);
    expect(result.chosenNames['bad'].pass).to.be.false;
    expect(result.chosenNames['bad'].excluded).to.be.undefined;
    expect(result.pass).to.be.true;
  });

  it('counts a gateway failure against the pass rate', async () => {
    const names: Record<string, ArnsResolution> = {};
    for (const name of ['a', 'b', 'c', 'd']) {
      names[name] = referenceResolution('text/plain');
    }
    serveName('a', 'text/plain');
    serveName('b', 'text/plain');
    serveName('c', 'text/plain');
    nock(`https://d.${HOST}`).persist().head('/').reply(502);

    const result = await assessor(names).assessGatewayArns({
      host: HOST,
      prescribedNames: [],
      chosenNames: ['a', 'b', 'c', 'd'],
    });

    expect(result.chosenNames['d'].pass).to.be.false;
    expect(result.chosenNames['d'].excluded).to.be.undefined;
    expect(result.pass).to.be.false;
  });

  it('scores a name that is also an Object.prototype key', async () => {
    // `__proto__` is a valid ArNS name. Assigned into a plain object it
    // would replace the prototype and drop out of the pass rate: 3 of 3
    // instead of 3 of 4.
    const names: Record<string, ArnsResolution> = Object.create(null);
    for (const name of ['a', 'b', 'c', '__proto__']) {
      names[name] = referenceResolution('text/plain');
    }
    for (const name of ['a', 'b', 'c']) {
      serveName(name, 'text/plain');
    }
    nock(`https://__proto__.${HOST}`).persist().head('/').reply(502);

    const result = await assessor(names).assessGatewayArns({
      host: HOST,
      prescribedNames: [],
      chosenNames: ['a', 'b', 'c', '__proto__'],
    });

    expect(Object.keys(result.chosenNames)).to.include('__proto__');
    expect(result.chosenNames['__proto__'].pass).to.be.false;
    expect(result.pass).to.be.false;
  });

  it('fails the gateway when the reference resolves no name', async () => {
    const result = await assessor({}).assessGatewayArns({
      host: HOST,
      prescribedNames: ['a'],
      chosenNames: ['b'],
    });
    expect(result.prescribedNames['a'].excluded).to.be.true;
    expect(result.chosenNames['b'].excluded).to.be.true;
    expect(result.pass).to.be.false;
  });
});
