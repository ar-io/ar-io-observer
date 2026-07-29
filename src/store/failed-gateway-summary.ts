/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { ObserverReport } from '../types.js';

/**
 * Collapse the per-host assessment view from an ObserverReport into the
 * flat list of gateway wallets that should be reported failed for
 * `save_observations`.
 *
 * A gateway is identified by its registered wallet(s) (`expectedWallets`).
 * For each assessed host:
 *   - The wallet that actually controls the host (the one matching
 *     `observedWallet`) is failed if EITHER its ownership OR its ArNS
 *     assessment failed.
 *   - Any other expected wallet is failed: it claims the host but a
 *     different wallet responded, so it does not control it.
 *   - If no wallet responded at all, every expected wallet is failed.
 *
 * The failure is always attributed to the gateway UNDER ASSESSMENT (its
 * expected wallets) — never to the owner of an unexpected `observedWallet`.
 * A host that serves a wallet it isn't registered under is a failure of
 * that host's own gateway(s); the observed wallet's owner (which may be a
 * healthy, unrelated gateway that merely shares infrastructure) must not be
 * penalized. The assessed host's own expected wallets already capture that
 * failure via the loop below.
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
      const arnsPass = gatewayAssessment.arnsAssessments.pass;

      if (observedWallet !== null) {
        for (const wallet of expectedWallets) {
          if (wallet === observedWallet) {
            // This wallet controls the host; it fails if EITHER ownership
            // or ArNS resolution failed (the report's overall pass folds
            // both in, but they are tracked separately here).
            if (!ownershipPass || !arnsPass) {
              failedGatewaySummary.add(wallet);
            }
          } else {
            // A registered wallet that does not control the observed host.
            failedGatewaySummary.add(wallet);
          }
        }
      } else {
        // No wallet responded — every expected wallet failed.
        for (const wallet of expectedWallets) {
          failedGatewaySummary.add(wallet);
        }
      }
    },
  );
  return [...failedGatewaySummary].sort();
}
