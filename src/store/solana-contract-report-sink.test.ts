/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Unit tests for SolanaContractReportSink. Both the SolanaARIOReadable
 * (`getEpochObservationStatus`) and SolanaARIOWriteable (`saveObservations`)
 * dependencies are sinon-stubbed; the sink's job is purely orchestration:
 * read epoch state → gate → submit. No rpc/network involvement.
 */
import { expect } from 'chai';
import * as sinon from 'sinon';
import * as winston from 'winston';
import type { Address } from '@solana/kit';

import type { SolanaARIOReadable, SolanaARIOWriteable } from '@ar.io/sdk';
import { SolanaContractReportSink } from './solana-contract-report-sink.js';
import type { ObserverReport, ReportInfo } from '../types.js';

// ---------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------

const OBSERVER_PUBKEY =
  '3MW2cDG42ggKNoNhsmtVt7oYeauNQ8skiYHQZKyD3fUm' as Address;
const REPORT_TX_ID = 'oork_YifB3-JQQZg8EgMPQJytua_QCHKNmMqt5kmnCo';

/** Build a minimal ObserverReport with N failed-ownership gateways. */
function makeReport(opts: {
  epochIndex: number;
  failedWallets?: string[];
}): ObserverReport {
  const gatewayAssessments: ObserverReport['gatewayAssessments'] = {};
  for (const w of opts.failedWallets ?? []) {
    gatewayAssessments[w] = {
      ownershipAssessment: {
        expectedWallets: [w],
        observedWallet: null,
        pass: false,
      },
      arnsAssessments: {
        prescribedNames: {},
        chosenNames: {},
        statistics: {
          prescribedNamesCount: 0,
          chosenNamesCount: 0,
          totalNamesCount: 0,
          totalTimeMs: 0,
          totalPasses: 0,
          totalFailures: 0,
          passRate: 0,
        },
        pass: true,
      },
      pass: false,
    } as any;
  }
  return {
    formatVersion: 1,
    observerAddress: OBSERVER_PUBKEY as string,
    epochIndex: opts.epochIndex,
    epochStartTimestamp: 1_700_000_000,
    epochEndTimestamp: 1_700_003_600,
    epochStartHeight: 1_000_000,
    generatedAt: Date.now(),
    gatewayAssessments,
  } as any;
}

function makeReportInfo(
  report: ObserverReport,
  reportTxId?: string,
): ReportInfo {
  return {
    report,
    reportTxId,
    reportSize: 1234,
  } as any;
}

function makeLog(): winston.Logger {
  const stub = sinon.stub();
  const log = {
    child: () => log,
    info: stub,
    verbose: stub,
    warn: stub,
    error: stub,
    debug: stub,
  } as any as winston.Logger;
  return log;
}

/** Build a stub readable that returns the given pre-flight gate status. */
function makeReadable(
  status: Awaited<ReturnType<SolanaARIOReadable['getEpochObservationStatus']>>,
  opts: { throws?: Error } = {},
): SolanaARIOReadable {
  return {
    getEpochObservationStatus: opts.throws
      ? sinon.stub().rejects(opts.throws)
      : sinon.stub().resolves(status),
  } as any;
}

/** Build a stub writeable that returns a fake tx signature from saveObservations. */
function makeWriteable(opts: { txId?: string; throws?: Error }): {
  contract: SolanaARIOWriteable;
  saveStub: sinon.SinonStub;
} {
  const saveStub = opts.throws
    ? sinon.stub().rejects(opts.throws)
    : sinon.stub().resolves({ id: opts.txId ?? 'SIG_AAA' });
  return {
    contract: { saveObservations: saveStub } as any,
    saveStub,
  };
}

type ObservationStatus = Awaited<
  ReturnType<SolanaARIOReadable['getEpochObservationStatus']>
>;

/** The pre-flight status of a prescribed observer with work to do. */
function openStatus(overrides: Partial<ObservationStatus> = {}) {
  return {
    prescribed: true,
    observerIdx: 40,
    alreadyObserved: false,
    windowOpen: true,
    endTimestampSec: Math.floor(Date.now() / 1000) + 3600,
    ...overrides,
  } as ObservationStatus;
}

/**
 * A readable whose successive calls return successive statuses. The
 * retry loop re-reads epoch state between attempts, so the first entry
 * serves the pre-flight gate and later entries serve the retries.
 */
function makeSequencedReadable(
  statuses: (ObservationStatus | Error)[],
): SolanaARIOReadable {
  const stub = sinon.stub();
  statuses.forEach((status, i) => {
    if (status instanceof Error) {
      stub.onCall(i).rejects(status);
    } else {
      stub.onCall(i).resolves(status);
    }
  });
  stub.resolves(statuses[statuses.length - 1]);
  return { getEpochObservationStatus: stub } as any;
}

/** The @solana/kit error seen when a blockhash expires before commit. */
function blockhashExpiredError(): Error {
  const err: any = new Error(
    'The network has progressed past the last block for which this transaction could have been committed.',
  );
  err.name = 'SolanaError';
  err.context = { __code: 1 };
  return err;
}

/** A writeable whose saveObservations follows a scripted sequence. */
function makeSequencedWriteable(outcomes: (string | Error)[]): {
  contract: SolanaARIOWriteable;
  saveStub: sinon.SinonStub;
} {
  const saveStub = sinon.stub();
  outcomes.forEach((outcome, i) => {
    if (outcome instanceof Error) {
      saveStub.onCall(i).rejects(outcome);
    } else {
      saveStub.onCall(i).resolves({ id: outcome });
    }
  });
  return { contract: { saveObservations: saveStub } as any, saveStub };
}

// ---------------------------------------------------------------
// Tests
// ---------------------------------------------------------------

describe('SolanaContractReportSink', () => {
  describe('happy path', () => {
    it('submits save_observations when prescribed + not-yet-observed + window-open', async () => {
      const readable = makeReadable({
        prescribed: true,
        observerIdx: 2,
        alreadyObserved: false,
        windowOpen: true,
        endTimestampSec: Math.floor(Date.now() / 1000) + 100,
      });
      const { contract, saveStub } = makeWriteable({ txId: 'SIG_HAPPY' });
      const sink = new SolanaContractReportSink({
        log: makeLog(),
        contract,
        readable,
        observerAddress: OBSERVER_PUBKEY,
      });

      const report = makeReport({
        epochIndex: 42,
        failedWallets: ['Failed1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'],
      });
      const result = await sink.saveReport(
        makeReportInfo(report, REPORT_TX_ID),
      );

      expect(saveStub.calledOnce).to.equal(true);
      const args = saveStub.firstCall.args[0];
      expect(args.epochIndex).to.equal(42);
      expect(args.reportTxId).to.equal(REPORT_TX_ID);
      expect(args.failedGateways).to.deep.equal([
        'Failed1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      ]);
      expect(result.interactionTxIds).to.deep.equal(['SIG_HAPPY']);
    });

    it('passes through an empty failed-gateways list when every assessment passed', async () => {
      const readable = makeReadable({
        prescribed: true,
        observerIdx: 0,
        alreadyObserved: false,
        windowOpen: true,
        endTimestampSec: Math.floor(Date.now() / 1000) + 100,
      });
      const { contract, saveStub } = makeWriteable({ txId: 'SIG_EMPTY' });
      const sink = new SolanaContractReportSink({
        log: makeLog(),
        contract,
        readable,
        observerAddress: OBSERVER_PUBKEY,
      });
      const report = makeReport({ epochIndex: 7, failedWallets: [] });
      const result = await sink.saveReport(
        makeReportInfo(report, REPORT_TX_ID),
      );
      expect(saveStub.calledOnce).to.equal(true);
      expect(saveStub.firstCall.args[0].failedGateways).to.deep.equal([]);
      expect(result.interactionTxIds).to.deep.equal(['SIG_EMPTY']);
    });
  });

  describe('pre-flight skip gates', () => {
    it('skips when observer is not prescribed for the epoch', async () => {
      const readable = makeReadable({
        prescribed: false,
        observerIdx: -1,
        alreadyObserved: false,
        windowOpen: true,
        endTimestampSec: Math.floor(Date.now() / 1000) + 100,
      });
      const { contract, saveStub } = makeWriteable({});
      const sink = new SolanaContractReportSink({
        log: makeLog(),
        contract,
        readable,
        observerAddress: OBSERVER_PUBKEY,
      });
      const result = await sink.saveReport(
        makeReportInfo(makeReport({ epochIndex: 3 }), REPORT_TX_ID),
      );
      expect(saveStub.called).to.equal(false);
      expect(result.interactionTxIds).to.equal(undefined);
    });

    it('skips when already-observed bit is set for this observer slot', async () => {
      const readable = makeReadable({
        prescribed: true,
        observerIdx: 1,
        alreadyObserved: true,
        windowOpen: true,
        endTimestampSec: Math.floor(Date.now() / 1000) + 100,
      });
      const { contract, saveStub } = makeWriteable({});
      const sink = new SolanaContractReportSink({
        log: makeLog(),
        contract,
        readable,
        observerAddress: OBSERVER_PUBKEY,
      });
      const result = await sink.saveReport(
        makeReportInfo(makeReport({ epochIndex: 3 }), REPORT_TX_ID),
      );
      expect(saveStub.called).to.equal(false);
      expect(result.interactionTxIds).to.equal(undefined);
    });

    it('skips when the observation window is closed (now >= end_timestamp)', async () => {
      const readable = makeReadable({
        prescribed: true,
        observerIdx: 0,
        alreadyObserved: false,
        windowOpen: false,
        endTimestampSec: Math.floor(Date.now() / 1000) - 100,
      });
      const { contract, saveStub } = makeWriteable({});
      const sink = new SolanaContractReportSink({
        log: makeLog(),
        contract,
        readable,
        observerAddress: OBSERVER_PUBKEY,
      });
      const result = await sink.saveReport(
        makeReportInfo(makeReport({ epochIndex: 3 }), REPORT_TX_ID),
      );
      expect(saveStub.called).to.equal(false);
      expect(result.interactionTxIds).to.equal(undefined);
    });
  });

  describe('input validation', () => {
    it('skips with WARN log when reportTxId is missing', async () => {
      const readable = makeReadable({} as any);
      const { contract, saveStub } = makeWriteable({});
      const sink = new SolanaContractReportSink({
        log: makeLog(),
        contract,
        readable,
        observerAddress: OBSERVER_PUBKEY,
      });
      const result = await sink.saveReport(
        makeReportInfo(makeReport({ epochIndex: 3 }), undefined),
      );
      expect(saveStub.called).to.equal(false);
      // Pre-flight reader is not called either; we short-circuit early.
      expect(
        (readable.getEpochObservationStatus as sinon.SinonStub).called,
      ).to.equal(false);
      expect(result.interactionTxIds).to.equal(undefined);
    });

    it('skips with WARN log when reportTxId is empty string', async () => {
      const readable = makeReadable({} as any);
      const { contract, saveStub } = makeWriteable({});
      const sink = new SolanaContractReportSink({
        log: makeLog(),
        contract,
        readable,
        observerAddress: OBSERVER_PUBKEY,
      });
      const result = await sink.saveReport(
        makeReportInfo(makeReport({ epochIndex: 3 }), ''),
      );
      expect(saveStub.called).to.equal(false);
      expect(result.interactionTxIds).to.equal(undefined);
    });
  });

  describe('error propagation', () => {
    it('rethrows when getEpochObservationStatus fails', async () => {
      const readable = makeReadable({} as any, {
        throws: new Error('RPC timeout reading epoch'),
      });
      const { contract } = makeWriteable({});
      const sink = new SolanaContractReportSink({
        log: makeLog(),
        contract,
        readable,
        observerAddress: OBSERVER_PUBKEY,
      });
      let threw = false;
      try {
        await sink.saveReport(
          makeReportInfo(makeReport({ epochIndex: 3 }), REPORT_TX_ID),
        );
      } catch (e: any) {
        threw = true;
        expect(e.message).to.match(/RPC timeout/);
      }
      expect(threw).to.equal(true);
    });

    it('rethrows when saveObservations submission fails', async () => {
      const readable = makeReadable({
        prescribed: true,
        observerIdx: 0,
        alreadyObserved: false,
        windowOpen: true,
        endTimestampSec: Math.floor(Date.now() / 1000) + 100,
      });
      const { contract } = makeWriteable({
        throws: new Error('Transaction simulation failed'),
      });
      const sink = new SolanaContractReportSink({
        log: makeLog(),
        contract,
        readable,
        observerAddress: OBSERVER_PUBKEY,
      });
      let threw = false;
      try {
        await sink.saveReport(
          makeReportInfo(makeReport({ epochIndex: 3 }), REPORT_TX_ID),
        );
      } catch (e: any) {
        threw = true;
        expect(e.message).to.match(/Transaction simulation failed/);
      }
      expect(threw).to.equal(true);
    });
  });

  describe('transient submission retry', () => {
    /** Build a sink with retries and no backoff, for fast tests. */
    function makeRetrySink(
      readable: SolanaARIOReadable,
      contract: SolanaARIOWriteable,
      maxSubmitAttempts = 3,
    ) {
      return new SolanaContractReportSink({
        log: makeLog(),
        contract,
        readable,
        observerAddress: OBSERVER_PUBKEY,
        maxSubmitAttempts,
        retryBackoffMs: [0, 0],
      });
    }

    it('retries a blockhash expiry and reports the signature that lands', async () => {
      const readable = makeSequencedReadable([openStatus(), openStatus()]);
      const { contract, saveStub } = makeSequencedWriteable([
        blockhashExpiredError(),
        'SIG_SECOND_TRY',
      ]);
      const sink = makeRetrySink(readable, contract);

      const result = await sink.saveReport(
        makeReportInfo(makeReport({ epochIndex: 512 }), REPORT_TX_ID),
      );

      expect(saveStub.callCount).to.equal(2);
      expect(result.interactionTxIds).to.deep.equal(['SIG_SECOND_TRY']);
    });

    it('gives up after the attempt limit and rethrows', async () => {
      const readable = makeSequencedReadable([openStatus()]);
      const { contract, saveStub } = makeSequencedWriteable([
        blockhashExpiredError(),
        blockhashExpiredError(),
        blockhashExpiredError(),
      ]);
      const sink = makeRetrySink(readable, contract, 3);

      let threw = false;
      try {
        await sink.saveReport(
          makeReportInfo(makeReport({ epochIndex: 512 }), REPORT_TX_ID),
        );
      } catch (e: any) {
        threw = true;
        expect(e.message).to.match(/network has progressed past/);
      }
      expect(threw).to.equal(true);
      expect(saveStub.callCount).to.equal(3);
    });

    it('does not retry a program revert', async () => {
      const readable = makeSequencedReadable([openStatus()]);
      const { contract, saveStub } = makeSequencedWriteable([
        new Error(
          'Transaction simulation failed: custom program error: 0x1771',
        ),
        'SIG_NEVER_REACHED',
      ]);
      const sink = makeRetrySink(readable, contract);

      let threw = false;
      try {
        await sink.saveReport(
          makeReportInfo(makeReport({ epochIndex: 512 }), REPORT_TX_ID),
        );
      } catch {
        threw = true;
      }
      expect(threw).to.equal(true);
      expect(saveStub.callCount).to.equal(1);
    });

    it('stops when the re-read shows the observation already landed', async () => {
      const readable = makeSequencedReadable([
        openStatus(),
        openStatus({ alreadyObserved: true }),
      ]);
      const { contract, saveStub } = makeSequencedWriteable([
        blockhashExpiredError(),
        'SIG_DOUBLE_SUBMIT',
      ]);
      const sink = makeRetrySink(readable, contract);

      const result = await sink.saveReport(
        makeReportInfo(makeReport({ epochIndex: 512 }), REPORT_TX_ID),
      );

      // No second submission, and no throw: the work is done on chain.
      expect(saveStub.callCount).to.equal(1);
      expect(result.interactionTxIds).to.equal(undefined);
    });

    it('stops when the window closes while retrying', async () => {
      const readable = makeSequencedReadable([
        openStatus(),
        openStatus({ windowOpen: false }),
      ]);
      const { contract, saveStub } = makeSequencedWriteable([
        blockhashExpiredError(),
        'SIG_TOO_LATE',
      ]);
      const sink = makeRetrySink(readable, contract);

      const result = await sink.saveReport(
        makeReportInfo(makeReport({ epochIndex: 512 }), REPORT_TX_ID),
      );

      expect(saveStub.callCount).to.equal(1);
      expect(result.interactionTxIds).to.equal(undefined);
    });

    it('stops when the window closes DURING the retry backoff', async () => {
      // Regression guard for the re-read ordering. The pre-flight read happens
      // immediately and sees an open window; the window then closes 25ms later,
      // inside the 50ms backoff. Only a re-read placed AFTER the delay observes
      // that. Checking before the pause would carry a stale "open" verdict into
      // attempt 2 and submit past epoch.end_timestamp for a terminal revert.
      const closesAtMs = Date.now() + 25;
      const statusStub = sinon
        .stub()
        .callsFake(async () =>
          Date.now() >= closesAtMs
            ? openStatus({ windowOpen: false })
            : openStatus(),
        );
      const readable = {
        getEpochObservationStatus: statusStub,
      } as any as SolanaARIOReadable;
      const { contract, saveStub } = makeSequencedWriteable([
        blockhashExpiredError(),
        'SIG_TOO_LATE',
      ]);
      const sink = new SolanaContractReportSink({
        log: makeLog(),
        contract,
        readable,
        observerAddress: OBSERVER_PUBKEY,
        maxSubmitAttempts: 3,
        retryBackoffMs: [50],
      });

      const result = await sink.saveReport(
        makeReportInfo(makeReport({ epochIndex: 512 }), REPORT_TX_ID),
      );

      expect(saveStub.callCount).to.equal(1);
      expect(result.interactionTxIds).to.equal(undefined);
    });

    it('retries anyway when the pre-retry re-read fails', async () => {
      const readable = makeSequencedReadable([
        openStatus(),
        new Error('RPC 503'),
      ]);
      const { contract, saveStub } = makeSequencedWriteable([
        blockhashExpiredError(),
        'SIG_AFTER_BLIND_RETRY',
      ]);
      const sink = makeRetrySink(readable, contract);

      const result = await sink.saveReport(
        makeReportInfo(makeReport({ epochIndex: 512 }), REPORT_TX_ID),
      );

      expect(saveStub.callCount).to.equal(2);
      expect(result.interactionTxIds).to.deep.equal(['SIG_AFTER_BLIND_RETRY']);
    });

    it('treats an already-in-use revert as a completed submission', async () => {
      const readable = makeSequencedReadable([openStatus()]);
      const { contract, saveStub } = makeSequencedWriteable([
        new Error('Allocate: account Address { address: 7fxz } already in use'),
      ]);
      const sink = makeRetrySink(readable, contract);

      const result = await sink.saveReport(
        makeReportInfo(makeReport({ epochIndex: 512 }), REPORT_TX_ID),
      );

      expect(saveStub.callCount).to.equal(1);
      expect(result.interactionTxIds).to.equal(undefined);
    });
  });
});
