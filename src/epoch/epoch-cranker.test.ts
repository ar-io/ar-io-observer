/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { expect } from 'chai';

import { EpochCranker, type EpochCrankerConfig } from './epoch-cranker.js';

/**
 * Tests for the cleanup continuity floor (Phase 4 close_observation).
 *
 * After the AO→Solana cutover the network jumped `current_epoch_index`
 * straight to the AO-continuity value (~454) with NO epochs 0..453 on
 * Solana. The cleanup loop used to fire `close_observation` at
 * `currentEpochIndex - retention - 1` — which lands in that never-existed
 * range — for every registry observer, producing N guaranteed
 * AccountOwnedByWrongProgram (3007) misses per cycle (the RPC-429 noise floor).
 *
 * These tests prove the floor: cleanup never attempts close_observation at
 * an epoch index below the lowest epoch that actually exists, and it
 * eliminates the wasted RPC calls rather than swallowing the error.
 */

const noopLog: EpochCrankerConfig['log'] = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  verbose: () => undefined,
};

interface MockCounters {
  getEpochRawCalls: number[];
  closeObservationCalls: Array<{ epochIndex: number; observer: string }>;
  getEpochObserversCalls: number[];
  // Phase 4 must NEVER brute-force the whole registry anymore (the firehose).
  registryGatewayCalls: number;
}

/**
 * Build an EpochCranker whose `contract` is a stub that no-ops every
 * cleanup phase except Phase 4, and whose `getEpochRaw` existence is
 * controlled by `existingEpochs`.
 */
function makeCranker(opts: {
  existingEpochs: Set<number>;
  observerAddrs: string[];
  epochRetention?: number;
}): { cranker: EpochCranker; counters: MockCounters } {
  const counters: MockCounters = {
    getEpochRawCalls: [],
    closeObservationCalls: [],
    getEpochObserversCalls: [],
    registryGatewayCalls: 0,
  };

  const contract: any = {
    // Phase 1/2 — gate off via a far-future prune timestamp.
    getArnsConfigRaw: async () => ({
      nextRecordsPruneTimestamp: Number.MAX_SAFE_INTEGER,
      nextReturnedNamesPruneTimestamp: Number.MAX_SAFE_INTEGER,
    }),
    getExpiredArnsRecords: async () => [],
    getExpiredReturnedNames: async () => [],
    // Phase 3
    getDeficientGateways: async () => [],
    getFinalizableGoneGateways: async () => [],
    // Phase 4 — the unit under test.
    getEpochRaw: async (epochIndex: number) => {
      counters.getEpochRawCalls.push(epochIndex);
      return opts.existingEpochs.has(epochIndex)
        ? { rewardsDistributed: 1 }
        : null;
    },
    // The fixed Phase 4 enumerates the epoch's real observers, not the whole
    // registry. getEpochObservers returns only the submitters with a live PDA.
    getEpochObservers: async (epochIndex: number) => {
      counters.getEpochObserversCalls.push(epochIndex);
      return opts.observerAddrs;
    },
    // Kept so we can assert Phase 4 NEVER calls it (the old brute-force path).
    getRegistryGatewayAddresses: async () => {
      counters.registryGatewayCalls++;
      return opts.observerAddrs;
    },
    closeObservation: async (p: { epochIndex: number; observer: string }) => {
      counters.closeObservationCalls.push({
        epochIndex: p.epochIndex,
        observer: p.observer,
      });
      // Simulate the on-chain 3007 when the PDA was never initialized.
      if (!opts.existingEpochs.has(p.epochIndex)) {
        throw new Error(
          'AnchorError ... Error Number: 3007 ... AccountOwnedByWrongProgram',
        );
      }
      return { id: 'sig' };
    },
    // Phase 5/6/7
    getEmptyDelegations: async () => [],
    getDrainedWithdrawals: async () => [],
    getExpiredPrimaryNameRequests: async () => [],
    reclaimLookupTableRent: async () => ({
      deactivated: 0,
      closed: 0,
      candidates: 0,
    }),
  };

  const config: EpochCrankerConfig = {
    contract: contract as any,
    rpc: {} as any,
    signer: {} as any,
    pollIntervalMs: 1000,
    batchSize: 18,
    closeEpochs: true,
    epochRetention: opts.epochRetention ?? 7,
    log: noopLog,
    getEpochSettings: async () => ({
      currentEpochIndex: 0,
      genesisTimestamp: 0,
      epochDuration: 0,
      enabled: true,
    }),
  };

  return { cranker: new EpochCranker(config), counters };
}

// Reach the private runCleanup directly — it's the unit under test and is
// otherwise only reachable through the throttled, settings-gated runCycle.
function runCleanup(cranker: EpochCranker, currentEpochIndex: number) {
  return (cranker as any).runCleanup(currentEpochIndex);
}

describe('EpochCranker cleanup continuity floor', () => {
  it('does NOT call close_observation when the target epoch never existed (continuity gap)', async () => {
    // Continuity cutover: currentEpochIndex 454, NO epochs exist yet.
    // closeTarget = 454 - 7 - 1 = 446, which never existed on-chain.
    const { cranker, counters } = makeCranker({
      existingEpochs: new Set(),
      observerAddrs: ['obsA', 'obsB', 'obsC'],
    });

    await runCleanup(cranker, 454);

    // The whole observer fan-out is skipped — zero wasted tx-simulations.
    expect(counters.closeObservationCalls).to.have.length(0);
    // Exactly ONE cheap existence probe replaces N closeObservation calls.
    expect(counters.getEpochRawCalls).to.deep.equal([446]);
  });

  it('caches the floor so subsequent cycles skip even the existence probe', async () => {
    const { cranker, counters } = makeCranker({
      existingEpochs: new Set(),
      observerAddrs: ['obsA', 'obsB'],
    });

    // First cycle discovers the floor (probes once).
    await runCleanup(cranker, 454);
    expect(counters.getEpochRawCalls).to.deep.equal([446]);

    // Second cycle at the same index: closeTarget (446) < cached floor (447),
    // so we short-circuit with NO RPC at all.
    await runCleanup(cranker, 454);
    expect(counters.getEpochRawCalls).to.deep.equal([446]); // unchanged
    expect(counters.closeObservationCalls).to.have.length(0);
  });

  it('DOES call close_observation for every observer once the target epoch exists', async () => {
    // Healthy steady state: closeTarget = 470 - 7 - 1 = 462 exists on-chain.
    const { cranker, counters } = makeCranker({
      existingEpochs: new Set([462]),
      observerAddrs: ['obsA', 'obsB', 'obsC'],
    });

    await runCleanup(cranker, 470);

    // Retention semantics preserved: one close_observation per observer at
    // the (existing) close target.
    expect(counters.getEpochRawCalls).to.deep.equal([462]);
    expect(counters.closeObservationCalls).to.deep.equal([
      { epochIndex: 462, observer: 'obsA' },
      { epochIndex: 462, observer: 'obsB' },
      { epochIndex: 462, observer: 'obsC' },
    ]);
    // The observers came from getEpochObservers(closeTarget), NOT a brute-force
    // walk of the whole gateway registry.
    expect(counters.getEpochObserversCalls).to.deep.equal([462]);
    expect(counters.registryGatewayCalls).to.equal(0);
  });

  it('closes ONLY the epoch observers and NEVER walks the gateway registry (firehose fix)', async () => {
    // Old Phase 4 fired close_observation at every registry gateway (~643),
    // ~98% of which had no PDA → AccountNotInitialized firehose. The fix
    // enumerates the epoch's real observers instead.
    const { cranker, counters } = makeCranker({
      existingEpochs: new Set([462]),
      observerAddrs: ['obsA', 'obsB'], // the only two that actually observed
    });

    await runCleanup(cranker, 470);

    expect(counters.closeObservationCalls).to.deep.equal([
      { epochIndex: 462, observer: 'obsA' },
      { epochIndex: 462, observer: 'obsB' },
    ]);
    expect(counters.registryGatewayCalls).to.equal(0);
  });

  it('fires ZERO close_observation when an existing epoch has no live observers (the 643→0 case)', async () => {
    // Exactly the production case proven on mainnet: epoch 460 exists and is
    // distributed, but getEpochObservers returns [] (all already closed) — the
    // old code still fired at all 643 registry gateways. The fix does nothing.
    const { cranker, counters } = makeCranker({
      existingEpochs: new Set([462]),
      observerAddrs: [], // no live Observation PDAs for this epoch
    });

    await runCleanup(cranker, 470);

    expect(counters.getEpochObserversCalls).to.deep.equal([462]);
    expect(counters.closeObservationCalls).to.have.length(0);
    expect(counters.registryGatewayCalls).to.equal(0);
  });

  it('skips Phase 4 entirely when currentEpochIndex is within the retention window', async () => {
    // currentEpochIndex (5) < retention + 1 (8): no close target yet.
    const { cranker, counters } = makeCranker({
      existingEpochs: new Set(),
      observerAddrs: ['obsA'],
    });

    await runCleanup(cranker, 5);

    expect(counters.getEpochRawCalls).to.have.length(0);
    expect(counters.closeObservationCalls).to.have.length(0);
  });
});

/**
 * Draining multi-batch crank phases.
 *
 * `crankEpochStep` advances the lifecycle by ONE step. Distribution is one tx
 * per `batchSize` gateways and the post-distribution compound sweep is one tx
 * per 6 delegations, so at one step per cycle those became one tx per CYCLE.
 * On staging (617 gateways, 542 delegations, ~60s cycles) a single rollover
 * spent ~42 minutes distributing, and compound — which is sequenced
 * immediately before "create the next epoch" — would have added ~91 more,
 * leaving the next epoch over two hours late.
 */
function makeDrainCranker(
  step: () => Promise<any>,
  overrides: Partial<EpochCrankerConfig> = {},
): { cranker: EpochCranker; calls: number[] } {
  const calls: number[] = [];
  const contract: any = {
    crankEpochStep: async () => {
      calls.push(Date.now());
      return step();
    },
  };
  const config: EpochCrankerConfig = {
    contract: contract as any,
    rpc: {} as any,
    signer: {} as any,
    pollIntervalMs: 1000,
    batchSize: 15,
    closeEpochs: false,
    enableCleanup: false,
    log: noopLog,
    getEpochSettings: async () => ({
      currentEpochIndex: 5,
      genesisTimestamp: 0,
      epochDuration: 100,
      enabled: true,
    }),
    ...overrides,
  };
  return { cranker: new EpochCranker(config), calls };
}

const runCycle = (c: EpochCranker) => (c as any).runCycle();

describe('EpochCranker — draining multi-batch phases', () => {
  it('keeps stepping until idle instead of one step per cycle', async () => {
    let n = 0;
    const { cranker, calls } = makeDrainCranker(async () => {
      if (n >= 5) return { action: 'idle', reason: 'epoch_complete' };
      n += 1;
      return {
        action: 'distribute',
        epochIndex: 4,
        txId: `tx${n}`,
        progress: { index: n * 15, total: 75 },
      };
    });
    await runCycle(cranker);
    expect(calls.length).to.equal(
      6,
      '5 batches + the idle that ends the drain',
    );
  });

  it('drains a compound sweep, whose progress shrinks `total` rather than advancing `index`', async () => {
    // compound reports {index: batchSize, total: remaining}: `index` is
    // constant at 6 while `total` falls. A progress check watching only
    // `index` would read that as no progress and stop after ONE batch,
    // reintroducing the bug in a subtler form.
    let remaining = 30;
    const { cranker, calls } = makeDrainCranker(async () => {
      if (remaining <= 0) return { action: 'idle', reason: 'epoch_complete' };
      remaining -= 6;
      return {
        action: 'compound',
        txId: 'c',
        progress: { index: 6, total: remaining + 6 },
      };
    });
    await runCycle(cranker);
    expect(calls.length).to.equal(6, '5 batches + idle');
  });

  it('stops when a step repeats with no progress, rather than firing the whole budget', async () => {
    const { cranker, calls } = makeDrainCranker(async () => ({
      action: 'distribute',
      epochIndex: 4,
      txId: 'stuck',
      progress: { index: 15, total: 600 },
    }));
    await runCycle(cranker);
    expect(calls.length).to.equal(
      2,
      'one step, one identical repeat, then stop',
    );
  });

  it('respects the per-cycle step budget', async () => {
    let i = 0;
    const { cranker, calls } = makeDrainCranker(
      async () => {
        i += 1;
        return {
          action: 'distribute',
          epochIndex: 4,
          txId: `t${i}`,
          progress: { index: i, total: 10_000 },
        };
      },
      { maxCrankStepsPerCycle: 7 },
    );
    await runCycle(cranker);
    expect(calls.length).to.equal(7, 'never exceeds maxCrankStepsPerCycle');
  });

  it('ends the drain when a step throws', async () => {
    let i = 0;
    const { cranker, calls } = makeDrainCranker(async () => {
      i += 1;
      if (i === 3) throw new Error('AnchorError. Error Number: 9999.');
      return {
        action: 'distribute',
        epochIndex: 4,
        txId: `t${i}`,
        progress: { index: i, total: 100 },
      };
    });
    await runCycle(cranker);
    expect(calls.length).to.equal(3, 'stops at the throwing step');
  });
});
