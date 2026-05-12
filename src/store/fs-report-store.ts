/**
 * AR.IO Observer
 * Copyright (C) 2023 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */
import fs from 'node:fs';
import * as winston from 'winston';

import {
  ObserverReport,
  ReportInfo,
  ReportSink,
  ReportStore,
} from '../types.js';

export class FsReportStore implements ReportSink, ReportStore {
  // Dependencies
  private log: winston.Logger;
  private baseDir: string;

  constructor({ log, baseDir }: { log: winston.Logger; baseDir: string }) {
    this.log = log.child({ class: this.constructor.name });
    this.baseDir = baseDir;
  }

  async saveReport(reportInfo: ReportInfo): Promise<ReportInfo> {
    if (!fs.existsSync(this.baseDir)) {
      await fs.promises.mkdir(this.baseDir, { recursive: true });
    }

    let report = reportInfo.report;
    const log = this.log.child({
      epochStartTimestamp: report.epochStartTimestamp,
      epochIndex: report.epochIndex,
      epochStartHeight: report.epochStartHeight,
    });

    // Key by `epochIndex`, not `epochStartHeight`. Under AO both were
    // unique-per-epoch; under Solana `epochStartHeight` is a 0 sentinel
    // for every epoch (Solana epochs are clock-aligned, not Arweave-
    // block-aligned), so keying by height silently caches a stale
    // report and returns it for every subsequent epoch — downstream
    // sinks then upload + submit the wrong report.
    const savedReport = await this.getReport(report.epochIndex);
    if (savedReport !== null) {
      log.verbose('Using previously saved report');
      report = savedReport;
      return {
        ...reportInfo,
        report,
      };
    }

    const reportFile = this.reportFilePath(report.epochIndex);
    log.verbose('Saving report...', {
      reportFile,
    });
    if (!fs.existsSync(reportFile)) {
      await fs.promises.writeFile(reportFile, JSON.stringify(report));
    }
    log.verbose('Report saved', {
      reportFile,
    });

    return reportInfo;
  }

  /** Path on disk for the given epoch's persisted report. */
  private reportFilePath(epochIndex: number): string {
    // `epoch-` prefix disambiguates from any pre-existing
    // `<epochStartHeight>.json` files written under the old keying
    // scheme — those become orphans and are ignored by `getReport` /
    // `latestReport`.
    return `${this.baseDir}/epoch-${epochIndex}.json`;
  }

  async getReport(epochIndex: number): Promise<ObserverReport | null> {
    const reportFile = this.reportFilePath(epochIndex);
    if (!fs.existsSync(reportFile)) {
      return null;
    }
    const report = JSON.parse(await fs.promises.readFile(reportFile, 'utf8'));
    return report;
  }

  async latestReport(): Promise<ObserverReport | null> {
    const reportFiles = await fs.promises.readdir(this.baseDir);
    const epochFiles = reportFiles
      .map((f) => /^epoch-(\d+)\.json$/.exec(f))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => parseInt(m[1]));
    if (epochFiles.length === 0) {
      return null;
    }
    return this.getReport(Math.max(...epochFiles));
  }
}
