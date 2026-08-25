/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Submit observation reports on-chain via `ario_gar::save_observations`.
 * Consumes the upstream `reportTxId` from a TurboReportSink and returns
 * `interactionTxIds`. Protocol details:
 *
 *   - The Observation PDA is `init`-constrained, so only ONE saveObservations
 *     call per (epochIndex, observer) is allowed. The SDK encodes every
 *     gateway's pass/fail into a 375-byte bitmap so no batching is needed.
 *   - On-chain pre-flight gates: the contract rejects submissions when
 *     the signer isn't prescribed, the epoch is closed, or the observer
 *     already submitted. We replicate those checks here BEFORE the
 *     transaction simulation so the sink can skip cheap-to-skip cases
 *     and produce clean logs (no "tx simulation failed" noise for
 *     not-our-turn epochs).
 *
 * The Observation PDA can be reclaimed by the cranker's `close_observation`
 * loop after the parent epoch is fully distributed — no manual cleanup
 * needed from the observer side.
 */
import type { Address } from '@solana/kit';
import type { SolanaARIOReadable, SolanaARIOWriteable } from '@ar.io/sdk';
import type winston from 'winston';

import type { ObserverReport, ReportInfo, ReportSink } from '../types.js';
import { getFailedGatewaySummaryFromReport } from './failed-gateway-summary.js';
import {
  isAlreadySubmittedError,
  isTransientSubmitError,
} from './solana-tx-errors.js';

/** Total attempts for one `save_observations` submission. */
const DEFAULT_MAX_SUBMIT_ATTEMPTS = 3;

/** Pause before attempt 2, then before attempt 3. */
const DEFAULT_RETRY_BACKOFF_MS = [1_000, 3_000];

export interface SolanaContractReportSinkConfig {
  log: winston.Logger;
  /** A SolanaARIOWriteable instance signed by the observer keypair
   *  (NOT the operator/cranker). The signer's pubkey must match the
   *  on-chain `Gateway.observer_address` for `save_observations` to
   *  land — pre-flight checks below confirm this before submitting. */
  contract: SolanaARIOWriteable;
  /** Read-only SDK handle used for the pre-flight gates. Typically the
   *  same instance can serve both, since SolanaARIOWriteable extends
   *  SolanaARIOReadable. */
  readable: SolanaARIOReadable;
  /** The observer signer's pubkey. Passed in explicitly rather than
   *  read from `contract` so this sink can be constructed without
   *  reaching into the SDK's `signer` internals. */
  observerAddress: Address;
  /** Total submission attempts, including the first. Defaults to 3. */
  maxSubmitAttempts?: number;
  /** Pause before each retry, in milliseconds. The last entry repeats
   *  if attempts outnumber entries. Tests pass `[0, 0]`. */
  retryBackoffMs?: number[];
}

export class SolanaContractReportSink implements ReportSink {
  private readonly log: winston.Logger;
  private readonly contract: SolanaARIOWriteable;
  private readonly readable: SolanaARIOReadable;
  private readonly observerAddress: Address;
  private readonly maxSubmitAttempts: number;
  private readonly retryBackoffMs: number[];

  constructor(cfg: SolanaContractReportSinkConfig) {
    this.log = cfg.log.child({ class: this.constructor.name });
    this.contract = cfg.contract;
    this.readable = cfg.readable;
    this.observerAddress = cfg.observerAddress;
    this.maxSubmitAttempts = Math.max(
      1,
      cfg.maxSubmitAttempts ?? DEFAULT_MAX_SUBMIT_ATTEMPTS,
    );
    this.retryBackoffMs =
      cfg.retryBackoffMs !== undefined && cfg.retryBackoffMs.length > 0
        ? cfg.retryBackoffMs
        : DEFAULT_RETRY_BACKOFF_MS;
  }

  async saveReport(reportInfo: ReportInfo): Promise<{
    report: ObserverReport;
    reportTxId?: string;
    interactionTxIds?: string[];
  }> {
    const { report, reportTxId } = reportInfo;
    const { epochIndex } = report;

    if (reportTxId === undefined || reportTxId.trim() === '') {
      // Without a permaweb-archive txid the on-chain record loses its
      // audit pointer. Refuse to submit — the operator should investigate
      // why the upstream TurboReportSink didn't produce a txid.
      // Treat whitespace-only as missing: such a value can't decode to a
      // valid 32-byte hash, and a downstream encoder would either throw
      // or silently store a meaningless txid.
      this.log.warn(
        'Skipping save_observations: reportTxId from upstream sink is missing. ' +
          'Verify TurboReportSink ran and produced an upload.',
        { epochIndex },
      );
      return reportInfo;
    }

    // -------- Defensive pre-flight gates (one RPC read of the Epoch
    // account) --------
    //
    // The primary gate now lives in `PipelineReportSink` via
    // `shouldSubmitExternally`, which short-circuits BEFORE Turbo
    // uploads anything when we're not prescribed. This block is kept
    // as a belt-and-suspenders check so direct callers / test harnesses
    // that wire `SolanaContractReportSink` outside the pipeline still
    // can't submit a bogus on-chain tx. The cost is one extra RPC read
    // per submission cycle — negligible compared to the Turbo upload
    // that already preceded us.
    let status: Awaited<
      ReturnType<SolanaARIOReadable['getEpochObservationStatus']>
    >;
    try {
      status = await this.readable.getEpochObservationStatus(
        epochIndex,
        this.observerAddress,
      );
    } catch (err: any) {
      this.log.error('Failed to read epoch state for pre-flight gate', {
        epochIndex,
        message: err.message,
      });
      throw err;
    }

    if (!status.prescribed) {
      this.log.info(
        'Not prescribed for this epoch — skipping save_observations',
        {
          epochIndex,
          observer: this.observerAddress,
        },
      );
      return reportInfo;
    }
    if (status.alreadyObserved) {
      this.log.warn('Observation already submitted for this epoch — skipping', {
        epochIndex,
        observer: this.observerAddress,
        observerIdx: status.observerIdx,
      });
      return reportInfo;
    }
    if (!status.windowOpen) {
      this.log.warn(
        'Observation window closed (now >= epoch.end_timestamp) — skipping',
        {
          epochIndex,
          observer: this.observerAddress,
          endTimestampSec: status.endTimestampSec,
        },
      );
      return reportInfo;
    }

    // -------- Build + submit save_observations --------
    const failedGateways = getFailedGatewaySummaryFromReport(report);

    this.log.verbose('Submitting save_observations', {
      epochIndex,
      observer: this.observerAddress,
      observerIdx: status.observerIdx,
      failedGatewayCount: failedGateways.length,
      reportTxId,
    });

    // A blockhash lives ~150 slots (~60s). If the transaction does not
    // land inside that window, `sendAndConfirm` rejects even though the
    // instruction is valid — the observed epoch 512 failure. Re-signing
    // over a fresh blockhash recovers it, so retry a bounded number of
    // times before giving the error back to the pipeline.
    let interactionTxId: string | undefined;

    for (let attempt = 1; attempt <= this.maxSubmitAttempts; attempt++) {
      try {
        const { id } = await this.contract.saveObservations({
          reportTxId,
          failedGateways,
          epochIndex,
        });
        interactionTxId = id;
        break;
      } catch (err: any) {
        // A confirmation timeout does not prove the transaction died.
        // If it landed, the retry hits the `init` constraint on the
        // Observation PDA and reverts. That revert means the work is
        // done — report success rather than failing the epoch.
        if (isAlreadySubmittedError(err)) {
          this.log.warn(
            'save_observations reverted as already submitted — treating as done',
            { epochIndex, attempt, message: err.message },
          );
          return reportInfo;
        }

        const transient = isTransientSubmitError(err);
        if (!transient || attempt >= this.maxSubmitAttempts) {
          this.log.error('save_observations transaction failed', {
            epochIndex,
            attempt,
            maxAttempts: this.maxSubmitAttempts,
            transient,
            message: err.message,
          });
          throw err;
        }

        this.log.warn(
          'save_observations failed transiently — retrying with a fresh blockhash',
          {
            epochIndex,
            attempt,
            maxAttempts: this.maxSubmitAttempts,
            message: err.message,
          },
        );

        await delay(
          this.retryBackoffMs[
            Math.min(attempt - 1, this.retryBackoffMs.length - 1)
          ],
        );

        // Re-read AFTER the backoff, not before: the observation window can
        // close during the 1s/3s pause, and submitting past
        // `epoch.end_timestamp` is a terminal revert. Checking first would
        // clear a stale "open" verdict and spend the next attempt anyway.
        if ((await this.shouldRetry(epochIndex, attempt)) === false) {
          return reportInfo;
        }
      }
    }

    if (interactionTxId === undefined) {
      // Unreachable: the loop either breaks with a signature, returns,
      // or throws. Kept so a future edit can't produce a silent success.
      throw new Error(
        `save_observations produced no signature for epoch ${epochIndex}`,
      );
    }

    this.log.info('save_observations submitted', {
      epochIndex,
      observer: this.observerAddress,
      observerIdx: status.observerIdx,
      failedGatewayCount: failedGateways.length,
      reportTxId,
      interactionTxId,
    });

    return {
      ...reportInfo,
      interactionTxIds: [interactionTxId],
    };
  }

  /**
   * Re-read epoch state between submission attempts. This is the
   * idempotency guard for the retry loop: the gates at the top of
   * `saveReport` ran before the first attempt and can be stale by now.
   *
   * Returns `false` when the caller must stop — either the observation
   * landed after all, or the window closed while we retried. Returns
   * `true` when another attempt is worthwhile. An RPC failure here is
   * indeterminate, so it returns `true`: the `init` constraint on the
   * Observation PDA still blocks a double write.
   */
  private async shouldRetry(
    epochIndex: number,
    attempt: number,
  ): Promise<boolean> {
    let status: Awaited<
      ReturnType<SolanaARIOReadable['getEpochObservationStatus']>
    >;
    try {
      status = await this.readable.getEpochObservationStatus(
        epochIndex,
        this.observerAddress,
      );
    } catch (err: any) {
      this.log.warn(
        'Epoch re-read before retry failed — retrying submission anyway',
        { epochIndex, attempt, message: err.message },
      );
      return true;
    }

    if (status.alreadyObserved) {
      this.log.info(
        'Observation landed despite the confirmation error — no retry needed',
        { epochIndex, attempt, observer: this.observerAddress },
      );
      return false;
    }
    if (!status.windowOpen) {
      this.log.warn('Observation window closed while retrying — giving up', {
        epochIndex,
        attempt,
        endTimestampSec: status.endTimestampSec,
      });
      return false;
    }
    return true;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
