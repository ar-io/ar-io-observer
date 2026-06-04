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
 * AccountNotInitialized (3007) misses per cycle (the RPC-429 noise floor).
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
    getGoneGateways: async () => [],
    // Phase 4 — the unit under test.
    getEpochRaw: async (epochIndex: number) => {
      counters.getEpochRawCalls.push(epochIndex);
      return opts.existingEpochs.has(epochIndex)
        ? { rewardsDistributed: 1 }
        : null;
    },
    getRegistryGatewayAddresses: async () => opts.observerAddrs,
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
