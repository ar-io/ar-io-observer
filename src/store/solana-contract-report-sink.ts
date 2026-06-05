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

    let interactionTxId: string;
    try {
      const { id } = await this.contract.saveObservations({
        reportTxId,
        failedGateways,
        epochIndex,
      });
      interactionTxId = id;
    } catch (err: any) {
      this.log.error('save_observations transaction failed', {
        epochIndex,
        message: err.message,
      });
      throw err;
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
