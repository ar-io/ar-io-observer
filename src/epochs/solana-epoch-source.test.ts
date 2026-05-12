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
import { SolanaEpochSource } from './solana-epoch-source.js';

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

function makeReadable(opts: {
  epochSettings?: { epochZeroStartTimestamp: number; durationMs: number };
  epoch?: { epochIndex: number; startTimestamp: number; endTimestamp: number };
  throws?: Error;
}): { readable: SolanaARIOReadable; getEpochStub: sinon.SinonStub } {
  const getEpochStub = opts.throws
    ? sinon.stub().rejects(opts.throws)
    : sinon.stub().resolves(opts.epoch);
  return {
    readable: {
      getEpochSettings: sinon.stub().resolves(opts.epochSettings),
      getEpoch: getEpochStub,
    } as any,
    getEpochStub,
  };
}

describe('SolanaEpochSource', () => {
  describe('getEpochSettings', () => {
    it('returns the SDK-shaped epoch settings unchanged (already in ms)', async () => {
      const { readable } = makeReadable({
        epochSettings: {
          epochZeroStartTimestamp: 1_700_000_000_000,
          durationMs: 3_600_000,
        },
      });
      const src = new SolanaEpochSource({ readable, log: makeLog() });
      const s = await src.getEpochSettings();
      expect(s.epochZeroStartTimestamp).to.equal(1_700_000_000_000);
      expect(s.durationMs).to.equal(3_600_000);
    });
  });

  describe('getEpochParams', () => {
    it('maps SDK getEpoch fields directly + sets startHeight=0', async () => {
      const { readable } = makeReadable({
        epoch: {
          epochIndex: 17,
          startTimestamp: 1_700_000_000_000,
          endTimestamp: 1_700_003_600_000,
        },
      });
      const src = new SolanaEpochSource({ readable, log: makeLog() });
      const p = await src.getEpochParams();
      expect(p.epochIndex).to.equal(17);
      expect(p.epochStartTimestamp).to.equal(1_700_000_000_000);
      expect(p.epochEndTimestamp).to.equal(1_700_003_600_000);
      expect(p.epochStartHeight).to.equal(0); // sentinel — Solana doesn't use Arweave height
    });

    it('caches params within cacheTtlMs', async () => {
      const { readable, getEpochStub } = makeReadable({
        epoch: {
          epochIndex: 5,
          startTimestamp: Date.now() - 1000,
          endTimestamp: Date.now() + 60_000_000, // far in future
        },
      });
      const src = new SolanaEpochSource({
        readable,
        log: makeLog(),
        cacheTtlMs: 10_000,
      });
      await src.getEpochParams();
      await src.getEpochParams();
      await src.getEpochParams();
      expect(getEpochStub.callCount).to.equal(1);
    });

    it('invalidates cache immediately when epochEndTimestamp has passed', async () => {
      // First fetch returns an epoch whose endTimestamp is already in the
      // past. The cache check `epochEndTimestamp > now` fails, so the
      // next call must refetch even within cacheTtlMs.
      const { readable, getEpochStub } = makeReadable({
        epoch: {
          epochIndex: 1,
          startTimestamp: Date.now() - 10_000,
          endTimestamp: Date.now() - 1, // already ended
        },
      });
      const src = new SolanaEpochSource({
        readable,
        log: makeLog(),
        cacheTtlMs: 60_000, // long TTL — but cache shouldn't be used
      });
      await src.getEpochParams();
      await src.getEpochParams();
      expect(getEpochStub.callCount).to.equal(2);
    });

    it('refetches after cacheTtlMs expires', async () => {
      const { readable, getEpochStub } = makeReadable({
        epoch: {
          epochIndex: 1,
          startTimestamp: Date.now() - 1000,
          endTimestamp: Date.now() + 1_000_000_000, // far future
        },
      });
      const src = new SolanaEpochSource({
        readable,
        log: makeLog(),
        cacheTtlMs: 1, // 1ms ttl
      });
      await src.getEpochParams();
      // Sleep to clear cache.
      await new Promise((r) => setTimeout(r, 5));
      await src.getEpochParams();
      expect(getEpochStub.callCount).to.equal(2);
    });

    it('propagates errors from the SDK readable', async () => {
      const { readable } = makeReadable({
        throws: new Error('Epoch 99 not found'),
      });
      const src = new SolanaEpochSource({ readable, log: makeLog() });
      let threw = false;
      try {
        await src.getEpochParams();
      } catch (e: any) {
        threw = true;
        expect(e.message).to.match(/not found/);
      }
      expect(threw).to.equal(true);
    });
  });

  describe('convenience methods', () => {
    it('getEpochStartTimestamp / getEpochEndTimestamp / getEpochIndex delegate to getEpochParams', async () => {
      const { readable } = makeReadable({
        epoch: {
          epochIndex: 42,
          startTimestamp: 1_111,
          endTimestamp: 2_222,
        },
      });
      const src = new SolanaEpochSource({ readable, log: makeLog() });
      expect(await src.getEpochStartTimestamp()).to.equal(1_111);
      expect(await src.getEpochEndTimestamp()).to.equal(2_222);
      expect(await src.getEpochIndex()).to.equal(42);
    });

    it('getEpochStartHeight always returns 0 (no Arweave dep)', async () => {
      const { readable } = makeReadable({
        epoch: {
          epochIndex: 1,
          startTimestamp: 0,
          endTimestamp: 1_000_000_000_000_000,
        },
      });
      const src = new SolanaEpochSource({ readable, log: makeLog() });
      expect(await src.getEpochStartHeight()).to.equal(0);
    });
  });
});
