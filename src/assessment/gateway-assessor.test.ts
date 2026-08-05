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
import { createLogger, transports } from 'winston';
import { CID } from 'multiformats/cid';
import { sha256 } from 'multiformats/hashes/sha2';
import * as rawCodec from 'multiformats/codecs/raw';

import { GatewayAssessor } from './gateway-assessor.js';
import { ArnsResolution } from '../types.js';

const testLog = createLogger({
  transports: [new transports.Console({ silent: true })],
});
const RAW_CT = { 'content-type': 'application/vnd.ipld.raw' };

const rawCidFor = async (bytes: Uint8Array) =>
  CID.create(1, rawCodec.code, await sha256.digest(bytes)).toString();

// The live path: ContinuousObserver -> GatewayAssessor.assessGatewayArns.
describe('GatewayAssessor (live path) — IPFS', function () {
  const host = 'gw.example.com';
  const name = 'ipfsname';
  let assessor: GatewayAssessor;
  let currentRef: ArnsResolution;

  const ipfsRef = (cid: string | null): ArnsResolution => ({
    statusCode: 200,
    resolvedId: cid,
    ttlSeconds: '900',
    contentLength: '10',
    contentType: 'application/octet-stream',
    dataHashDigest: null,
    protocol: 'ipfs',
    timings: null,
  });

  beforeEach(function () {
    nock.cleanAll();
    assessor = new GatewayAssessor({
      referenceGateway: {
        getArnsResolution: async () => ({
          host: 'ref',
          resolution: currentRef,
        }),
        checkChunkAvailability: async () => ({ host: 'ref', available: false }),
        getChunkMetadata: async () => ({ host: 'ref', metadata: null }),
      } as any,
      nodeReleaseVersion: 'test',
      nameAssessmentConcurrency: 4,
      log: testLog,
    });
    assessor.initializeForEpoch({ entropy: Buffer.from('e'), namesCount: 10 });
  });

  afterEach(() => nock.cleanAll());

  it('PASS: gateway serves a raw block that verifies against the CID', async function () {
    const bytes = Buffer.from('trustless bytes');
    const cid = await rawCidFor(bytes);
    currentRef = ipfsRef(cid);
    nock(`https://${name}.${host}`)
      .get('/?format=raw')
      .reply(200, bytes, { ...RAW_CT, 'x-arns-resolved-id': cid });

    const r = await assessor.assessArnsName({ host, arnsName: name });
    expect(r.outcome).to.equal('pass');
    expect(r.pass).to.equal(true);
    expect(r.protocol).to.equal('ipfs');
  });

  it('FAIL: gateway agrees on the CID but serves non-matching bytes', async function () {
    const cid = await rawCidFor(Buffer.from('real'));
    currentRef = ipfsRef(cid);
    nock(`https://${name}.${host}`)
      .get('/?format=raw')
      .reply(200, Buffer.from('tampered'), {
        ...RAW_CT,
        'x-arns-resolved-id': cid,
      });

    const r = await assessor.assessArnsName({ host, arnsName: name });
    expect(r.outcome).to.equal('fail');
  });

  it('FAIL: liar serves garbage with a bogus resolvedId cannot dodge to neutral', async function () {
    const cidReal = await rawCidFor(Buffer.from('real content'));
    const cidBogus = await rawCidFor(Buffer.from('unrelated'));
    currentRef = ipfsRef(cidReal);
    // Serves garbage that hashes to NEITHER cidReal NOR the bogus id it claims.
    nock(`https://${name}.${host}`)
      .get('/?format=raw')
      .reply(200, Buffer.from('garbage'), {
        ...RAW_CT,
        'x-arns-resolved-id': cidBogus,
      });

    const r = await assessor.assessArnsName({ host, arnsName: name });
    expect(r.outcome).to.equal('fail');
  });

  it('NEUTRAL: binding disagreement where the gateway serves its claimed CID authentically', async function () {
    const cidOld = await rawCidFor(Buffer.from('old'));
    const newBytes = Buffer.from('new');
    const cidNew = await rawCidFor(newBytes);
    currentRef = ipfsRef(cidOld);
    nock(`https://${name}.${host}`)
      .get('/?format=raw')
      .reply(200, newBytes, { ...RAW_CT, 'x-arns-resolved-id': cidNew });

    const r = await assessor.assessArnsName({ host, arnsName: name });
    expect(r.outcome).to.equal('neutral');
  });

  it('NEUTRAL: gateway does not serve the block (404 — e.g. a non-IPFS gateway)', async function () {
    currentRef = ipfsRef(await rawCidFor(Buffer.from('x')));
    nock(`https://${name}.${host}`).get('/?format=raw').reply(404);

    const r = await assessor.assessArnsName({ host, arnsName: name });
    expect(r.outcome).to.equal('neutral');
  });

  it('NEUTRAL: a 200 that is not application/vnd.ipld.raw (HTML error page) is not a fail', async function () {
    const cid = await rawCidFor(Buffer.from('real'));
    currentRef = ipfsRef(cid);
    nock(`https://${name}.${host}`)
      .get('/?format=raw')
      .reply(200, '<html>error</html>', {
        'content-type': 'text/html',
        'x-arns-resolved-id': cid,
      });

    const r = await assessor.assessArnsName({ host, arnsName: name });
    expect(r.outcome).to.equal('neutral');
  });

  it('assessGatewayArns excludes neutral names from the pass rate', async function () {
    // One PASS (raw block verifies) + one NEUTRAL (404). Pass rate must be 1/1.
    const bytes = Buffer.from('served');
    const cid = await rawCidFor(bytes);
    currentRef = ipfsRef(cid); // both names resolve to the same ipfs CID here
    nock(`https://passname.${host}`)
      .get('/?format=raw')
      .reply(200, bytes, { ...RAW_CT, 'x-arns-resolved-id': cid });
    nock(`https://neutralname.${host}`).get('/?format=raw').reply(404);

    const result = await assessor.assessGatewayArns({
      host,
      prescribedNames: ['passname'],
      chosenNames: ['neutralname'],
    });

    // 1 pass, 1 neutral (excluded) => rate 1/1 => pass true. If neutral were
    // counted as fail, rate would be 1/2 = 0.5 < 0.8 => fail.
    expect(result.pass).to.equal(true);
  });
});
