/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { ObserverReport } from '../types.js';

/**
 * Collapse the per-host ownership-assessment view from an ObserverReport
 * into the flat list of gateway wallets that should be reported failed
 * for `save_observations`.
 *
 * For each assessment:
 *   - If the observed wallet matched an expected wallet AND ownership
 *     passed, drop it.
 *   - If multiple wallets were expected, every non-matching one is
 *     marked failed (they don't actually control the gateway).
 *   - If the observed wallet wasn't in the expected set, it's also
 *     marked failed (unauthorized control).
 *   - If no wallet responded, all expected wallets are marked failed.
 */
export function getFailedGatewaySummaryFromReport(
  observerReport: ObserverReport,
): string[] {
  const failedGatewaySummary = new Set<string>();
  Object.values(observerReport.gatewayAssessments).forEach(
    (gatewayAssessment) => {
      const {
        expectedWallets,
        observedWallet,
        pass: ownershipPass,
      } = gatewayAssessment.ownershipAssessment;

      if (observedWallet !== null) {
        for (const wallet of expectedWallets) {
          if (wallet === observedWallet) {
            if (!ownershipPass) {
              failedGatewaySummary.add(wallet);
            }
          } else {
            failedGatewaySummary.add(wallet);
          }
        }
        if (!expectedWallets.includes(observedWallet)) {
          failedGatewaySummary.add(observedWallet);
        }
      } else {
        for (const wallet of expectedWallets) {
          failedGatewaySummary.add(wallet);
        }
      }
    },
  );
  return [...failedGatewaySummary].sort();
}
