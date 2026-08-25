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
function stubContract(
  capture: (opts: Record<string, unknown>) => void,
  result: Record<string, unknown> | undefined = undefined,
) {
  const stepResult = result ?? { action: 'idle', reason: 'stubbed' };
  const base: Record<string, unknown> = {
    crankEpochStep: async (opts: Record<string, unknown>) => {
      capture(opts);
      return stepResult;
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
  stepResult?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  let captured: Record<string, unknown> | null = null;
  const cranker = new EpochCranker({
    contract: stubContract((o) => {
      captured = o;
    }, stepResult) as never,
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

  it('forwards cleanupToReturnedTxsPerCycle as pruneToReturnedTxsPerCycle', async () => {
    // Sets throughput for the only deadline-bound step. `prune_name_to_returned`
    // takes a single record and cannot batch into one tx, so txs-per-scan is
    // the whole lever: at one per scan a 24h-epoch cranker caps at ~48
    // names/day, the same order as leases fall past grace, and the backlog
    // never drains. A silently-dropped option here reintroduces exactly that.
    const opts = await crankOnce({
      enableCleanup: true,
      cleanupToReturnedTxsPerCycle: 7,
    });
    expect(opts.pruneToReturnedTxsPerCycle).to.equal(7);
  });

  it('surfaces partialFailureReason from the SDK result into the log line', async () => {
    // A partial drain must be distinguishable from a budget-bounded one.
    const lines: Array<{ msg: string; meta: Record<string, unknown> }> = [];
    await crankOnce(
      {
        enableCleanup: true,
        log: {
          ...noopLog,
          info: (msg: string, meta?: Record<string, unknown>) => {
            lines.push({ msg, meta: meta ?? {} });
          },
        } as EpochCrankerConfig['log'],
      },
      {
        action: 'prune_name_to_returned',
        txId: 'tx-1',
        progress: { index: 2, total: 9 },
        partialFailureReason: 'blockhash expired',
      },
    );
    const line = lines.find((l) => l.msg.includes('prune_name_to_returned'));
    expect(line, 'no prune log line emitted').to.not.equal(undefined);
    expect(line?.meta.partialFailureReason).to.equal('blockhash expired');
  });

  it('leaves pruneToReturnedTxsPerCycle undefined when unconfigured, so the SDK default applies', async () => {
    const opts = await crankOnce({ enableCleanup: true });
    expect(opts.pruneToReturnedTxsPerCycle).to.equal(undefined);
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
