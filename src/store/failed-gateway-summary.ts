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
 *     `observedWallet`) is failed iff the gateway's overall assessment
 *     failed — the report's composite `pass` (ownership AND ArNS AND
 *     offset, majority-voted), so the summary can never diverge from the
 *     per-gateway `pass` the report carries.
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
      const { expectedWallets, observedWallet } =
        gatewayAssessment.ownershipAssessment;

      if (observedWallet !== null) {
        for (const wallet of expectedWallets) {
          if (wallet === observedWallet) {
            // This wallet controls the host; it fails iff the gateway's
            // overall assessment failed. Use the report's composite `pass`
            // (ownership AND ArNS AND offset, majority-voted across
            // observations) as the single source of truth so the on-chain
            // bitmap always matches the report — rather than re-deriving it
            // from a subset of the assessment dimensions.
            if (!gatewayAssessment.pass) {
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
