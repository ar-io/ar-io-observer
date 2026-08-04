/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Unit tests for `getFailedGatewaySummaryFromReport` — the collapse of an
 * ObserverReport into the failed-gateway wallet list submitted via
 * `save_observations`. Covers ownership attribution (including the
 * shared-infrastructure case where a host serves a wallet it isn't
 * registered under) and ArNS-only failures.
 */
import { expect } from 'chai';

import { getFailedGatewaySummaryFromReport } from './failed-gateway-summary.js';
import { GatewayAssessments, ObserverReport } from '../types.js';

const WALLET_A = 'wallet-a-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const WALLET_B = 'wallet-b-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const WALLET_C = 'wallet-c-ccccccccccccccccccccccccccccccccccccccc';

function assessment({
  expectedWallets,
  observedWallet,
  ownershipPass,
  arnsPass,
  pass,
}: {
  expectedWallets: string[];
  observedWallet: string | null;
  ownershipPass: boolean;
  arnsPass: boolean;
  // Composite gateway `pass`. Defaults to `ownershipPass && arnsPass`, but can
  // be set independently to model dimensions the report folds in beyond those
  // two (offset enforcement, majority vote) — the summary must track it.
  pass?: boolean;
}): GatewayAssessments[string] {
  return {
    ownershipAssessment: {
      expectedWallets,
      observedWallet,
      pass: ownershipPass,
    },
    arnsAssessments: {
      prescribedNames: {},
      chosenNames: {},
      pass: arnsPass,
    },
    pass: pass ?? (ownershipPass && arnsPass),
  };
}

function reportOf(gatewayAssessments: GatewayAssessments): ObserverReport {
  return {
    formatVersion: 1,
    observerAddress: 'observer',
    epochStartTimestamp: 0,
    epochEndTimestamp: 0,
    epochStartHeight: 0,
    epochIndex: 0,
    generatedAt: 0,
    gatewayAssessments,
  };
}

describe('getFailedGatewaySummaryFromReport', () => {
  it('omits a fully passing gateway', () => {
    const report = reportOf({
      'gw.example': assessment({
        expectedWallets: [WALLET_A],
        observedWallet: WALLET_A,
        ownershipPass: true,
        arnsPass: true,
      }),
    });
    expect(getFailedGatewaySummaryFromReport(report)).to.deep.equal([]);
  });

  it('fails a gateway that passes ownership but fails ArNS', () => {
    const report = reportOf({
      'gw.example': assessment({
        expectedWallets: [WALLET_A],
        observedWallet: WALLET_A,
        ownershipPass: true,
        arnsPass: false,
      }),
    });
    expect(getFailedGatewaySummaryFromReport(report)).to.deep.equal([WALLET_A]);
  });

  it('fails the controlling wallet when composite pass is false despite ownership + ArNS passing', () => {
    // The report's per-gateway `pass` also folds in offset enforcement and a
    // majority vote across observations, so a gateway can pass ownership AND
    // ArNS yet still be `pass: false` overall. The summary must track the
    // composite `pass` (single source of truth), otherwise the on-chain
    // bitmap diverges from the report.
    const report = reportOf({
      'gw.example': assessment({
        expectedWallets: [WALLET_A],
        observedWallet: WALLET_A,
        ownershipPass: true,
        arnsPass: true,
        pass: false, // e.g. offset assessment failed under enforcement
      }),
    });
    expect(getFailedGatewaySummaryFromReport(report)).to.deep.equal([WALLET_A]);
  });

  it('fails all expected wallets when no wallet responded', () => {
    const report = reportOf({
      'gw.example': assessment({
        expectedWallets: [WALLET_A, WALLET_B],
        observedWallet: null,
        ownershipPass: false,
        arnsPass: false,
      }),
    });
    expect(getFailedGatewaySummaryFromReport(report)).to.deep.equal([
      WALLET_A,
      WALLET_B,
    ]);
  });

  it('fails only the non-controlling wallet on a shared fqdn', () => {
    // Two gateways register the same fqdn; only the wallet that actually
    // serves it (WALLET_A) controls it, so WALLET_B is failed.
    const report = reportOf({
      'shared.example': assessment({
        expectedWallets: [WALLET_A, WALLET_B],
        observedWallet: WALLET_A,
        ownershipPass: true,
        arnsPass: true,
      }),
    });
    expect(getFailedGatewaySummaryFromReport(report)).to.deep.equal([WALLET_B]);
  });

  it('attributes an unexpected observed wallet to the assessed gateway, not the wallet owner', () => {
    // Regression for the shared-infrastructure bug: gateway-a is registered
    // under WALLET_A but its node serves WALLET_C (which belongs to a
    // separate, healthy gateway sharing the same infrastructure). The
    // failure must land on gateway-a (WALLET_A), and the healthy WALLET_C
    // gateway must NOT be penalized.
    const report = reportOf({
      'gateway-a.example': assessment({
        expectedWallets: [WALLET_A],
        observedWallet: WALLET_C,
        ownershipPass: false,
        arnsPass: true,
      }),
      'gateway-c.example': assessment({
        expectedWallets: [WALLET_C],
        observedWallet: WALLET_C,
        ownershipPass: true,
        arnsPass: true,
      }),
    });
    const failed = getFailedGatewaySummaryFromReport(report);
    expect(failed).to.deep.equal([WALLET_A]);
    expect(failed).to.not.include(WALLET_C);
  });

  it('deduplicates and sorts wallets across multiple hosts', () => {
    const report = reportOf({
      'b.example': assessment({
        expectedWallets: [WALLET_B],
        observedWallet: null,
        ownershipPass: false,
        arnsPass: false,
      }),
      'a.example': assessment({
        expectedWallets: [WALLET_A],
        observedWallet: WALLET_A,
        ownershipPass: true,
        arnsPass: false,
      }),
      // WALLET_B appears again (claims a.example too but doesn't control it).
      'a2.example': assessment({
        expectedWallets: [WALLET_A, WALLET_B],
        observedWallet: WALLET_A,
        ownershipPass: true,
        arnsPass: true,
      }),
    });
    expect(getFailedGatewaySummaryFromReport(report)).to.deep.equal([
      WALLET_A,
      WALLET_B,
    ]);
  });
});
