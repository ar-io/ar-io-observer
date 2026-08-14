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
import {
  SOLANA_ERROR__BLOCK_HEIGHT_EXCEEDED,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_NODE_UNHEALTHY,
  SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR,
  SOLANA_ERROR__TRANSACTION_ERROR__BLOCKHASH_NOT_FOUND,
  isSolanaError,
} from '@solana/errors';
import type { SolanaARIOReadable, SolanaARIOWriteable } from '@ar.io/sdk';
import type winston from 'winston';

import type { ObserverReport, ReportInfo, ReportSink } from '../types.js';
import { getFailedGatewaySummaryFromReport } from './failed-gateway-summary.js';

/** Total `save_observations` attempts before giving up on an epoch. */
const MAX_SUBMIT_ATTEMPTS = 3;
/** Linear backoff base between attempts. */
const RETRY_BACKOFF_MS = 1_000;

/**
 * Send failures that say "this transaction did not commit under that
 * blockhash" — re-sending with a fresh one is the correct response. A
 * deterministic program error (not prescribed, window closed, already
 * observed) is NOT in this set: retrying those only burns fees.
 *
 * Retrying is safe even if a prior attempt did land after all, because the
 * Observation PDA is `init`-constrained: a duplicate lands as an on-chain
 * rejection rather than a second observation. The `alreadyObserved` re-check
 * between attempts catches that case first and exits cleanly.
 */
const RETRYABLE_SOLANA_ERROR_CODES = [
  SOLANA_ERROR__BLOCK_HEIGHT_EXCEEDED,
  SOLANA_ERROR__TRANSACTION_ERROR__BLOCKHASH_NOT_FOUND,
  SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_NODE_UNHEALTHY,
] as const;

/**
 * True when `err` (or anything in its `cause` chain — kit nests the original
 * failure under the confirmation error) is one of the transient send failures.
 */
export function isRetryableSendError(err: unknown, depth = 0): boolean {
  if (err === null || err === undefined || depth > 10) return false;
  for (const code of RETRYABLE_SOLANA_ERROR_CODES) {
    if (isSolanaError(err, code)) return true;
  }
  return isRetryableSendError((err as { cause?: unknown }).cause, depth + 1);
}

const delay = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

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
}

export class SolanaContractReportSink implements ReportSink {
  private readonly log: winston.Logger;
  private readonly contract: SolanaARIOWriteable;
  private readonly readable: SolanaARIOReadable;
  private readonly observerAddress: Address;

  constructor(cfg: SolanaContractReportSinkConfig) {
    this.log = cfg.log.child({ class: this.constructor.name });
    this.contract = cfg.contract;
    this.readable = cfg.readable;
    this.observerAddress = cfg.observerAddress;
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

    // A blockhash is only valid ~60s from issue, so a slow RPC can expire the
    // transaction before it lands — losing the epoch's observation AND its
    // reward even though the report uploaded and the window was open. Retry the
    // transient cases with a fresh blockhash (the SDK takes a new one per call).
    let interactionTxId: string | undefined;
    for (let attempt = 1; attempt <= MAX_SUBMIT_ATTEMPTS; attempt++) {
      try {
        const { id } = await this.contract.saveObservations({
          reportTxId,
          failedGateways,
          epochIndex,
        });
        interactionTxId = id;
        break;
      } catch (err: any) {
        const retryable = isRetryableSendError(err);
        if (!retryable || attempt === MAX_SUBMIT_ATTEMPTS) {
          this.log.error('save_observations transaction failed', {
            epochIndex,
            attempt,
            retryable,
            message: err.message,
          });
          throw err;
        }

        this.log.warn(
          'save_observations hit a transient send error — retrying with a fresh blockhash',
          {
            epochIndex,
            observer: this.observerAddress,
            attempt,
            maxAttempts: MAX_SUBMIT_ATTEMPTS,
            message: err.message,
          },
        );

        await delay(RETRY_BACKOFF_MS * attempt);

        // Re-read epoch state before spending another transaction. Two cases
        // matter: the previous attempt may have landed after we gave up on it
        // (then we're done — the PDA exists and a retry would just be rejected),
        // or the observation window may have closed while we backed off (then no
        // retry can succeed). A failure to READ state is not itself a reason to
        // abandon the retry, so that case falls through to the next attempt.
        try {
          const recheck = await this.readable.getEpochObservationStatus(
            epochIndex,
            this.observerAddress,
          );
          if (recheck.alreadyObserved) {
            this.log.info(
              'save_observations actually landed despite the send error — nothing to retry',
              { epochIndex, observer: this.observerAddress, attempt },
            );
            return reportInfo;
          }
          if (!recheck.windowOpen) {
            this.log.warn(
              'Observation window closed while retrying — abandoning epoch',
              { epochIndex, observer: this.observerAddress, attempt },
            );
            throw err;
          }
        } catch (recheckErr: any) {
          if (recheckErr === err) throw err;
          this.log.warn(
            'Could not re-read epoch state between retries — retrying anyway',
            { epochIndex, attempt, message: recheckErr.message },
          );
        }
      }
    }

    /* c8 ignore next 3 -- the loop either sets an id, returns, or throws */
    if (interactionTxId === undefined) {
      throw new Error('save_observations produced no transaction id');
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
}
