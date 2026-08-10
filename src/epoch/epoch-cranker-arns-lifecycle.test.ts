/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { expect } from 'chai';

import { EpochCranker, type EpochCrankerConfig } from './epoch-cranker.js';

/**
 * Tests for the ArNS lease-lifecycle options the cranker forwards to
 * `crankEpochStep`.
 *
 * These exist because `runCycle` casts the contract to `any`
 * (`const ario = contract as any`) before calling `crankEpochStep`. That
 * silences TypeScript at the call site entirely — a misspelled option name
 * compiles clean and then silently does nothing at runtime, which is exactly
 * the failure mode that let expired ArNS leases pile up unnoticed in the first
 * place (`prune_returned_names` ran forever against a queue that
 * `prune_name_to_returned` was never called to fill).
 *
 * So assert the wire format directly: the exact option names, and that the
 * `enableCleanup` kill switch still reaches all three prune steps.
 */

const noopLog: EpochCrankerConfig['log'] = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  verbose: () => undefined,
};

/**
 * Contract stub that captures the options object handed to
 * `crankEpochStep` and tolerates every other SDK call the cleanup phases
 * may make (each returns an empty result).
 */
function stubContract(capture: (opts: Record<string, unknown>) => void) {
  const base: Record<string, unknown> = {
    crankEpochStep: async (opts: Record<string, unknown>) => {
      capture(opts);
      return { action: 'idle', reason: 'stubbed' };
    },
  };
  return new Proxy(base, {
    get(target, prop: string) {
      if (prop in target) return target[prop];
      return async () => [];
    },
  });
}

async function crankOnce(
  overrides: Partial<EpochCrankerConfig>,
): Promise<Record<string, unknown>> {
  let captured: Record<string, unknown> | null = null;
  const cranker = new EpochCranker({
    contract: stubContract((o) => {
      captured = o;
    }) as never,
    rpc: {} as never,
    signer: { address: 'stub' } as never,
    pollIntervalMs: 1000,
    batchSize: 18,
    closeEpochs: false,
    cleanupMinIntervalMs: 0,
    log: noopLog,
    getEpochSettings: async () => ({
      currentEpochIndex: 1,
      genesisTimestamp: 1000,
      epochDuration: 100,
      enabled: true,
    }),
    ...overrides,
  });
  // runCycle holds the crankEpochStep call; calling it directly skips tick()'s
  // random jitter sleep and the periodic balance check.
  await (cranker as never as { runCycle: () => Promise<void> }).runCycle();
  expect(captured, 'crankEpochStep was never called').to.not.equal(null);
  return captured as unknown as Record<string, unknown>;
}

describe('EpochCranker — ArNS lease lifecycle options', () => {
  it('enables all three prune steps by default', async () => {
    const opts = await crankOnce({ enableCleanup: true });
    expect(opts.enablePruneToReturned).to.equal(true);
    expect(opts.enablePruneExpired).to.equal(true);
    // the pre-existing returned-name step must keep working
    expect(opts.enablePrune).to.equal(true);
  });

  it('forwards cleanupBatchSize as the expired-name batch size', async () => {
    const opts = await crankOnce({
      enableCleanup: true,
      cleanupBatchSize: 20,
    });
    expect(opts.pruneExpiredBatchSize).to.equal(20);
  });

  it('enableCleanup:false disables every prune step, not just the old one', async () => {
    const opts = await crankOnce({ enableCleanup: false });
    expect(opts.enablePruneToReturned).to.equal(false);
    expect(opts.enablePruneExpired).to.equal(false);
    expect(opts.enablePrune).to.equal(false);
  });

  it('treats an unset enableCleanup as enabled (matches existing behaviour)', async () => {
    const opts = await crankOnce({});
    expect(opts.enablePruneToReturned).to.equal(true);
    expect(opts.enablePruneExpired).to.equal(true);
  });
});
