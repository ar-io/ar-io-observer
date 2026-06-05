/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { expect } from 'chai';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as sinon from 'sinon';
import * as winston from 'winston';

import type { ObserverReport, ReportInfo } from '../types.js';
import { FsReportStore } from './fs-report-store.js';

function makeLog(): winston.Logger {
  const noop = sinon.stub();
  // Recursive child mock — every `.child()` returns another logger
  // with the same shape, so nested `this.log.child(...)` inside
  // saveReport works.
  const mk: any = () => ({
    child: mk,
    verbose: noop,
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
  });
  return mk();
}

function makeReport(epochIndex: number): ObserverReport {
  return {
    observerAddress: 'observer-pubkey',
    epochIndex,
    epochStartTimestamp: 1_700_000_000_000 + epochIndex * 3_600_000,
    epochEndTimestamp: 1_700_000_000_000 + (epochIndex + 1) * 3_600_000,
    epochStartHeight: 0, // Solana sentinel — same for every epoch
    generatedAt: Date.now(),
    gatewayAssessments: {},
    arnsAssessments: { prescribedNames: {}, chosenNames: {} },
  } as ObserverReport;
}

describe('FsReportStore', () => {
  let tmpDir: string;
  let store: FsReportStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-report-store-test-'));
    store = new FsReportStore({ log: makeLog(), baseDir: tmpDir });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('persists per-epoch reports keyed by epochIndex', async () => {
    const r32: ReportInfo = { report: makeReport(32) };
    const r33: ReportInfo = { report: makeReport(33) };

    await store.saveReport(r32);
    await store.saveReport(r33);

    expect(fs.existsSync(path.join(tmpDir, 'epoch-32.json'))).to.equal(true);
    expect(fs.existsSync(path.join(tmpDir, 'epoch-33.json'))).to.equal(true);

    const loaded32 = await store.getReport(32);
    const loaded33 = await store.getReport(33);
    expect(loaded32?.epochIndex).to.equal(32);
    expect(loaded33?.epochIndex).to.equal(33);
  });

  it('does NOT collide between epochs that share the same epochStartHeight (Solana sentinel = 0)', async () => {
    // The old keying scheme used `epochStartHeight` for the filename.
    // On Solana every epoch reports startHeight=0, so consecutive
    // epochs overwrote each other and the second saveReport returned
    // the FIRST epoch's report. This test would have failed under the
    // old keying.
    const r32: ReportInfo = { report: makeReport(32) };
    const r33: ReportInfo = { report: makeReport(33) };
    // Same epochStartHeight on both.
    expect(r32.report.epochStartHeight).to.equal(0);
    expect(r33.report.epochStartHeight).to.equal(0);

    const after32 = await store.saveReport(r32);
    const after33 = await store.saveReport(r33);

    // Critical: after saving E33, the returned report MUST be E33, not E32.
    expect(after32.report.epochIndex).to.equal(32);
    expect(after33.report.epochIndex).to.equal(33);
  });

  it('on second save of the same epoch, returns the cached report (idempotent)', async () => {
    const r32: ReportInfo = { report: makeReport(32) };
    await store.saveReport(r32);

    // Try to save a DIFFERENT report for the same epoch — should
    // return the original (saveReport is idempotent per epoch).
    const r32b = makeReport(32);
    r32b.generatedAt = r32.report.generatedAt + 1000;
    const result = await store.saveReport({ report: r32b });

    // The original report's generatedAt should win.
    expect(result.report.generatedAt).to.equal(r32.report.generatedAt);
  });

  it('latestReport returns the highest-index saved report', async () => {
    await store.saveReport({ report: makeReport(28) });
    await store.saveReport({ report: makeReport(31) });
    await store.saveReport({ report: makeReport(29) });

    const latest = await store.latestReport();
    expect(latest?.epochIndex).to.equal(31);
  });

  it('latestReport returns null when no reports have been saved', async () => {
    const latest = await store.latestReport();
    expect(latest).to.equal(null);
  });

  it('latestReport ignores orphan files from the old epochStartHeight-keyed scheme', async () => {
    // Pre-create an orphan file with the bare-number naming that the
    // old keying used. `latestReport` must NOT pick this up — it
    // could be a stale Solana 0.json from before the migration.
    fs.writeFileSync(
      path.join(tmpDir, '0.json'),
      JSON.stringify({ epochIndex: 999, stale: true }),
    );
    await store.saveReport({ report: makeReport(5) });

    const latest = await store.latestReport();
    expect(latest?.epochIndex).to.equal(5);
  });

  it('getReport returns null for an epoch with no saved report', async () => {
    const result = await store.getReport(99);
    expect(result).to.equal(null);
  });
});
