/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { expect } from 'chai';
import * as sinon from 'sinon';
import * as winston from 'winston';

import type { SolanaARIOReadable } from '@ar.io/sdk/solana';
import { SolanaNamesSource } from './solana-names-source.js';

function makeLog(): winston.Logger {
  const noop = sinon.stub();
  return {
    child: () => ({ verbose: noop, info: noop, warn: noop, error: noop, debug: noop }),
    verbose: noop,
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
  } as any;
}

describe('SolanaNamesSource', () => {
  describe('getNames (prescribed names)', () => {
    it('delegates to readable.getPrescribedNames with the epochIndex', async () => {
      const stub = sinon.stub().resolves(['ardrive', 'turbo', 'permaweb']);
      const readable = { getPrescribedNames: stub } as any;
      const src = new SolanaNamesSource({ readable, log: makeLog() });
      const names = await src.getNames({ epochIndex: 42 });
      expect(stub.firstCall.args[0]).to.deep.equal({ epochIndex: 42 });
      expect(names).to.deep.equal(['ardrive', 'turbo', 'permaweb']);
    });

    it('returns an empty list when no names are prescribed', async () => {
      const readable = { getPrescribedNames: sinon.stub().resolves([]) } as any;
      const src = new SolanaNamesSource({ readable, log: makeLog() });
      expect(await src.getNames({ epochIndex: 1 })).to.deep.equal([]);
    });
  });

  describe('getAllNames (ArnsNameList)', () => {
    it('walks paginated ArnsRecord results and returns sorted unique names', async () => {
      const stub = sinon.stub();
      stub.onCall(0).resolves({
        items: [
          { name: 'turbo' },
          { name: 'ardrive' },
        ],
        nextCursor: 'CURSOR_1',
      });
      stub.onCall(1).resolves({
        items: [
          { name: 'permaweb' },
          { name: 'ardrive' }, // duplicate — should be dedup'd
        ],
        nextCursor: undefined,
      });
      const readable = { getArNSRecords: stub } as any;
      const src = new SolanaNamesSource({ readable, log: makeLog() });
      const names = await src.getAllNames(0);
      expect(names).to.deep.equal(['ardrive', 'permaweb', 'turbo']);
      expect(stub.callCount).to.equal(2);
      expect(stub.firstCall.args[0]).to.deep.equal({ cursor: undefined, limit: 1000 });
      expect(stub.secondCall.args[0]).to.deep.equal({ cursor: 'CURSOR_1', limit: 1000 });
    });

    it('honors a custom page size', async () => {
      const stub = sinon.stub().resolves({ items: [], nextCursor: undefined });
      const readable = { getArNSRecords: stub } as any;
      const src = new SolanaNamesSource({
        readable,
        log: makeLog(),
        pageSize: 250,
      });
      await src.getAllNames(0);
      expect(stub.firstCall.args[0]).to.deep.equal({ cursor: undefined, limit: 250 });
    });

    it('caches results within allNamesCacheTtlMs', async () => {
      const stub = sinon.stub().resolves({
        items: [{ name: 'a' }, { name: 'b' }],
        nextCursor: undefined,
      });
      const readable = { getArNSRecords: stub } as any;
      const src = new SolanaNamesSource({
        readable,
        log: makeLog(),
        allNamesCacheTtlMs: 60_000,
      });
      await src.getAllNames(0);
      await src.getAllNames(0);
      await src.getAllNames(0);
      expect(stub.callCount).to.equal(1);
    });

    it('coalesces concurrent callers onto a single in-flight fetch', async () => {
      let resolveFetch: (v: any) => void = () => {};
      const pending = new Promise((r) => (resolveFetch = r));
      const stub = sinon.stub().returns(pending);
      const readable = { getArNSRecords: stub } as any;
      const src = new SolanaNamesSource({ readable, log: makeLog() });
      const p1 = src.getAllNames(0);
      const p2 = src.getAllNames(0);
      const p3 = src.getAllNames(0);
      // Resolve the (one) underlying fetch.
      resolveFetch({ items: [{ name: 'only' }], nextCursor: undefined });
      const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
      expect(r1).to.deep.equal(['only']);
      expect(r2).to.deep.equal(['only']);
      expect(r3).to.deep.equal(['only']);
      expect(stub.callCount).to.equal(1);
    });

    it('refetches once the cache TTL has expired', async () => {
      const stub = sinon.stub().resolves({
        items: [{ name: 'a' }],
        nextCursor: undefined,
      });
      const readable = { getArNSRecords: stub } as any;
      const src = new SolanaNamesSource({
        readable,
        log: makeLog(),
        allNamesCacheTtlMs: 1, // 1ms ttl
      });
      await src.getAllNames(0);
      await new Promise((r) => setTimeout(r, 5));
      await src.getAllNames(0);
      expect(stub.callCount).to.equal(2);
    });

    it('skips records with empty/missing name (defensive)', async () => {
      const stub = sinon.stub().resolves({
        items: [
          { name: 'real' },
          { name: '' },
          { name: undefined },
          { name: 'also-real' },
        ],
        nextCursor: undefined,
      });
      const readable = { getArNSRecords: stub } as any;
      const src = new SolanaNamesSource({ readable, log: makeLog() });
      const names = await src.getAllNames(0);
      expect(names).to.deep.equal(['also-real', 'real']);
    });
  });

  describe('convenience methods', () => {
    it('getName returns the nth entry of getAllNames', async () => {
      const stub = sinon.stub().resolves({
        items: [{ name: 'c' }, { name: 'a' }, { name: 'b' }],
        nextCursor: undefined,
      });
      const readable = { getArNSRecords: stub } as any;
      const src = new SolanaNamesSource({ readable, log: makeLog() });
      // sorted: ['a', 'b', 'c']
      expect(await src.getName(0, 0)).to.equal('a');
      expect(await src.getName(0, 2)).to.equal('c');
    });

    it('getNamesCount returns the full count', async () => {
      const stub = sinon.stub().resolves({
        items: [{ name: 'a' }, { name: 'b' }, { name: 'c' }, { name: 'd' }],
        nextCursor: undefined,
      });
      const readable = { getArNSRecords: stub } as any;
      const src = new SolanaNamesSource({ readable, log: makeLog() });
      expect(await src.getNamesCount(0)).to.equal(4);
    });
  });
});
