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

import type { SolanaARIOReadable, SolanaARIOWriteable } from '@ar.io/sdk/solana';
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

function makeReportInfo(report: ObserverReport, reportTxId?: string): ReportInfo {
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
function makeWriteable(opts: {
  txId?: string;
  throws?: Error;
}): {
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
      const result = await sink.saveReport(makeReportInfo(report, REPORT_TX_ID));

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
      const result = await sink.saveReport(makeReportInfo(report, REPORT_TX_ID));
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
});
