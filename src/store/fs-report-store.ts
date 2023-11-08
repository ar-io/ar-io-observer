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

  async saveReport(reportInfo: ReportInfo): Promise<ReportInfo | undefined> {
    if (!fs.existsSync(this.baseDir)) {
      await fs.promises.mkdir(this.baseDir, { recursive: true });
    }

    let report = reportInfo.report;
    const log = this.log.child({
      epochStartHeight: report.epochStartHeight,
    });

    const savedReport = await this.getReport(report.epochStartHeight);
    if (savedReport !== null) {
      log.info('Using previously saved report');
      report = savedReport;
      return {
        ...reportInfo,
        report,
      };
    }

    const reportFile = `${this.baseDir}/${report.epochStartHeight}.json`;
    log.info('Saving report...', {
      reportFile,
    });
    if (!fs.existsSync(reportFile)) {
      await fs.promises.writeFile(
        `./data/reports/${report.epochStartHeight}.json`,
        JSON.stringify(report),
      );
    }
    log.info('Report saved', {
      reportFile,
    });

    return reportInfo;
  }

  async getReport(epochStartHeight: number): Promise<ObserverReport | null> {
    const reportFile = `./data/reports/${epochStartHeight}.json`;
    if (!fs.existsSync(reportFile)) {
      return null;
    }
    const report = JSON.parse(await fs.promises.readFile(reportFile, 'utf8'));
    return report;
  }

  async latestReport(): Promise<ObserverReport | null> {
    const reportFiles = await fs.promises.readdir('./data/reports');
    if (reportFiles.length === 0) {
      return null;
    }
    const latestReportHeight = Math.max(
      ...reportFiles.map((f) => parseInt(f.replace('.json', ''))),
    );
    return this.getReport(latestReportHeight);
  }
}
