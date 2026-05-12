/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { expect } from 'chai';
import * as sinon from 'sinon';
import * as winston from 'winston';

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

/**
 * SolanaEpochSource fetches the on-chain `EpochSettings` PDA via
 * `fetchEncodedAccount` (from `@solana/kit`) and decodes via
 * `deserializeEpochSettingsFull` (from `@ar.io/sdk/solana`). Both are
 * module-level imports — stubbing them at the unit boundary requires
 * deeper module mocking than is worth doing for the timestamp-math
 * surface.
 *
 * Instead, we substitute the private `fetchSettings` method to inject
 * known on-chain state and verify:
 *   - timestamp math (epochIndex N → start = genesis + N*duration)
 *   - off-by-one resolution (currentEpochIndex - 1 is the active epoch)
 *   - cache TTL + epoch-end-aware invalidation
 *
 * The real PDA fetch path is exercised end-to-end by the running
 * observer (logs `Epoch params resolved`).
 */
function makeSource(opts: {
  currentEpochIndex: number;
  genesisTimestamp: number;
  epochDuration: number;
  cacheTtlMs?: number;
}): { src: SolanaEpochSource; fetchStub: sinon.SinonStub } {
  const src = new SolanaEpochSource({
    rpc: {} as any,
    garProgramAddress: 'AF8QAEaR4hzsqeUDwEdeTXMYtdyFegTENBdnJro6WVLR' as any,
    log: makeLog(),
    cacheTtlMs: opts.cacheTtlMs,
  });
  const fetchStub = sinon.stub().resolves({
    currentEpochIndex: opts.currentEpochIndex,
    genesisTimestamp: opts.genesisTimestamp,
    epochDuration: opts.epochDuration,
  });
  // Inject the stub at the private boundary.
  (src as any).fetchSettings = fetchStub;
  return { src, fetchStub };
}

describe('SolanaEpochSource', () => {
  describe('getEpochSettings', () => {
    it('converts on-chain seconds to milliseconds', async () => {
      const { src } = makeSource({
        currentEpochIndex: 18,
        genesisTimestamp: 1_700_000_000,
        epochDuration: 3600,
      });
      const s = await src.getEpochSettings();
      expect(s.epochZeroStartTimestamp).to.equal(1_700_000_000 * 1000);
      expect(s.durationMs).to.equal(3_600_000);
    });
  });

  describe('getEpochParams', () => {
    it('resolves the active epoch as currentEpochIndex - 1', async () => {
      // current = 18 means "next to be created" — active is 17.
      const { src } = makeSource({
        currentEpochIndex: 18,
        genesisTimestamp: 1_700_000_000,
        epochDuration: 3600,
      });
      const p = await src.getEpochParams();
      expect(p.epochIndex).to.equal(17);
      expect(p.epochStartTimestamp).to.equal(
        (1_700_000_000 + 17 * 3600) * 1000,
      );
      expect(p.epochEndTimestamp).to.equal(
        (1_700_000_000 + 18 * 3600) * 1000,
      );
      expect(p.epochStartHeight).to.equal(0);
    });

    it('clamps active epoch to 0 when currentEpochIndex is 0 (genesis edge)', async () => {
      const { src } = makeSource({
        currentEpochIndex: 0,
        genesisTimestamp: 1_700_000_000,
        epochDuration: 3600,
      });
      const p = await src.getEpochParams();
      expect(p.epochIndex).to.equal(0);
    });

    it('caches params within cacheTtlMs (only one RPC for repeat calls)', async () => {
      const futureGenesis = Math.floor(Date.now() / 1000) - 60;
      const { src, fetchStub } = makeSource({
        currentEpochIndex: 2, // active epoch 1 starts ~now, ends ~hour from now
        genesisTimestamp: futureGenesis - 3600, // epoch 0 = past, epoch 1 = active
        epochDuration: 3600,
        cacheTtlMs: 10_000,
      });
      await src.getEpochParams();
      await src.getEpochParams();
      await src.getEpochParams();
      expect(fetchStub.callCount).to.equal(1);
    });

    it('invalidates cache immediately when epochEndTimestamp has passed', async () => {
      const { src, fetchStub } = makeSource({
        currentEpochIndex: 1, // active = 0
        genesisTimestamp: Math.floor(Date.now() / 1000) - 10_000, // far past
        epochDuration: 1, // 1-second epochs → already ended
        cacheTtlMs: 60_000, // long ttl, cache shouldn't apply
      });
      await src.getEpochParams();
      await src.getEpochParams();
      expect(fetchStub.callCount).to.equal(2);
    });

    it('refetches after cacheTtlMs expires', async () => {
      const { src, fetchStub } = makeSource({
        currentEpochIndex: 2,
        genesisTimestamp: Math.floor(Date.now() / 1000) - 60,
        epochDuration: 1_000_000_000, // very far future end
        cacheTtlMs: 1,
      });
      await src.getEpochParams();
      await new Promise((r) => setTimeout(r, 5));
      await src.getEpochParams();
      expect(fetchStub.callCount).to.equal(2);
    });

    it('propagates errors from the underlying fetch', async () => {
      const { src } = makeSource({
        currentEpochIndex: 1,
        genesisTimestamp: 0,
        epochDuration: 3600,
      });
      (src as any).fetchSettings = sinon
        .stub()
        .rejects(new Error('PDA not found'));
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
      const { src } = makeSource({
        currentEpochIndex: 18,
        genesisTimestamp: 1_700_000_000,
        epochDuration: 3600,
      });
      expect(await src.getEpochStartTimestamp()).to.equal(
        (1_700_000_000 + 17 * 3600) * 1000,
      );
      expect(await src.getEpochEndTimestamp()).to.equal(
        (1_700_000_000 + 18 * 3600) * 1000,
      );
      expect(await src.getEpochIndex()).to.equal(17);
    });

    it('getEpochStartHeight always returns 0 (no Arweave dep)', async () => {
      const { src } = makeSource({
        currentEpochIndex: 18,
        genesisTimestamp: 1_700_000_000,
        epochDuration: 3600,
      });
      expect(await src.getEpochStartHeight()).to.equal(0);
    });
  });
});
