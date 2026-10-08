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

import {
  ArnsConsensusResolver,
  ArnsResolution,
  ChunkHeaderMetadata,
  NetworkGatewaySource,
  ReferenceGatewaySource,
} from '../types.js';
import { CompositeReferenceGateway } from './composite-reference-gateway.js';
import { ReferenceResolutionCache } from './reference-resolution-cache.js';

const entropy = Buffer.from('test-entropy');

const resolutionFrom = (host: string): ArnsResolution => ({
  statusCode: 200,
  resolvedId: `id-from-${host}`,
  ttlSeconds: '300',
  contentLength: '10',
  contentType: 'text/plain',
  dataHashDigest: `hash-from-${host}`,
  timings: null,
});

/**
 * In-memory reference source with ordered hosts, like
 * FallbackReferenceGateway: answers from the first host not excluded and
 * throws when none is left. Each lookup waits a tick so concurrent
 * lookups overlap.
 */
class InMemoryReferenceGateway implements ReferenceGatewaySource {
  readonly calls: Array<{ arnsName: string; excludeFqdns?: string[] }> = [];

  constructor(private readonly hosts: string[]) {}

  async getArnsResolution({
    arnsName,
    excludeFqdns,
  }: {
    arnsName: string;
    entropy: Buffer;
    excludeFqdns?: string[];
  }): Promise<{ host: string; resolution: ArnsResolution }> {
    this.calls.push({ arnsName, excludeFqdns });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const excluded = new Set(excludeFqdns ?? []);
    const host = this.hosts.find((candidate) => !excluded.has(candidate));
    if (host === undefined) {
      throw new Error('No reference gateway hosts left after excluding');
    }
    return { host, resolution: resolutionFrom(host) };
  }

  async checkChunkAvailability(): Promise<{
    host: string;
    available: boolean;
  }> {
    throw new Error('not used');
  }

  async getChunkMetadata(): Promise<{
    host: string;
    metadata: ChunkHeaderMetadata | null;
  }> {
    throw new Error('not used');
  }
}

describe('ReferenceResolutionCache', function () {
  const createCache = (referenceGateway: ReferenceGatewaySource) =>
    new ReferenceResolutionCache({
      referenceGateway,
      entropy,
      capacity: 100,
      ttlMs: 60_000,
    });

  it('shares one reference lookup across ordinary gateways', async function () {
    const reference = new InMemoryReferenceGateway(['ref1.com', 'ref2.com']);
    const cache = createCache(reference);

    const results = await Promise.all(
      ['a.com', 'b.com', 'c.com'].map((fqdn) => cache.get('name', fqdn)),
    );

    for (const resolution of results) {
      expect(resolution.resolvedId).to.equal('id-from-ref1.com');
    }
    expect(reference.calls).to.have.length(1);
    expect(reference.calls[0].excludeFqdns).to.be.undefined;
  });

  it('never answers a reference gateway with its own resolution', async function () {
    const reference = new InMemoryReferenceGateway(['ref1.com', 'ref2.com']);
    const cache = createCache(reference);

    const resolution = await cache.get('name', 'REF1.com');

    expect(resolution.resolvedId).to.equal('id-from-ref2.com');
    expect(reference.calls.map((call) => call.excludeFqdns)).to.deep.equal([
      undefined,
      ['ref1.com'],
    ]);
  });

  it('keeps exclusions separate across concurrent assessments', async function () {
    const reference = new InMemoryReferenceGateway([
      'ref1.com',
      'ref2.com',
      'ref3.com',
    ]);
    const cache = createCache(reference);

    // All four lookups are in flight together.
    const [forRef1, forRef2, forOther, forRef1Again] = await Promise.all([
      cache.get('name', 'ref1.com'),
      cache.get('name', 'ref2.com'),
      cache.get('name', 'other.com'),
      cache.get('name', 'ref1.com'),
    ]);

    expect(forRef1.resolvedId).to.equal('id-from-ref2.com');
    expect(forRef1Again.resolvedId).to.equal('id-from-ref2.com');
    // ref2 is not the shared reference, so it shares ref1's answer.
    expect(forRef2.resolvedId).to.equal('id-from-ref1.com');
    // ref1's exclusion did not leak into another gateway's lookup.
    expect(forOther.resolvedId).to.equal('id-from-ref1.com');
    // One shared lookup plus one exclusion lookup for ref1, deduplicated.
    expect(reference.calls).to.have.length(2);
  });

  it('compares a gateway with itself when no other reference exists', async function () {
    const reference = new InMemoryReferenceGateway(['ref1.com']);
    const warn = sinon.stub();
    const cache = new ReferenceResolutionCache({
      referenceGateway: reference,
      entropy,
      capacity: 100,
      ttlMs: 60_000,
      log: { warn } as unknown as winston.Logger,
    });

    const resolution = await cache.get('name', 'ref1.com');

    expect(resolution.resolvedId).to.equal('id-from-ref1.com');
    expect(warn.calledOnce).to.be.true;
  });

  it('falls back to the network when exclusion removes the only explicit host', async function () {
    const log = {
      child: sinon.stub().returnsThis(),
      debug: sinon.stub(),
      verbose: sinon.stub(),
      warn: sinon.stub(),
      error: sinon.stub(),
    } as unknown as winston.Logger;
    const consensusCalls: string[][] = [];
    const consensusResolver: ArnsConsensusResolver = {
      async resolveWithConsensus({ excludeFqdns }) {
        consensusCalls.push(excludeFqdns ?? []);
        return {
          host: 'network1.com',
          resolution: resolutionFrom('network1.com'),
        };
      },
    };
    const networkGatewaySource: NetworkGatewaySource = {
      async getEligibleGateways() {
        return [];
      },
      markUnresponsive() {},
    };
    const composite = new CompositeReferenceGateway({
      explicitGateway: new InMemoryReferenceGateway(['ref1.com']),
      networkGatewaySource,
      consensusResolver,
      networkOnly: false,
      networkFallback: true,
      nodeReleaseVersion: 'test',
      log,
    });
    const cache = createCache(composite);

    const forOther = await cache.get('name', 'other.com');
    const forRef1 = await cache.get('name', 'ref1.com');

    expect(forOther.resolvedId).to.equal('id-from-ref1.com');
    expect(forRef1.resolvedId).to.equal('id-from-network1.com');
    expect(consensusCalls).to.deep.equal([['ref1.com']]);
  });
});
