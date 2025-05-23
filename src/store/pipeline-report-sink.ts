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
import * as winston from 'winston';

import { ReportInfo, ReportSink } from '../types.js';

const MAX_GATEWAY_FAILURE_THRESHOLD = 0.8;

export interface ReportSinkEntry {
  name: string;
  sink: ReportSink;
}

export class PipelineReportSink implements ReportSink {
  // Dependencies
  private log: winston.Logger;
  private sinks: ReportSinkEntry[];

  constructor({
    log,
    sinks,
  }: {
    log: winston.Logger;
    sinks: ReportSinkEntry[];
  }) {
    this.log = log.child({ class: this.constructor.name });
    this.sinks = sinks;
  }

  async saveReport(reportInfo: ReportInfo): Promise<ReportInfo> {
    const report = reportInfo.report;
    const log = this.log.child({
      epochStartTimestamp: report.epochStartTimestamp,
      epochIndex: report.epochIndex,
      epochStartHeight: report.epochStartHeight,
    });

    // Check if more than 80% of gateways failed
    const totalGateways = Object.keys(report.gatewayAssessments).length;
    const failedGateways = Object.values(report.gatewayAssessments).filter(
      (assessment) => assessment.pass === false,
    ).length;
    const failurePercentage = failedGateways / totalGateways;

    if (failurePercentage > MAX_GATEWAY_FAILURE_THRESHOLD) {
      log.error(
        `More than ${(MAX_GATEWAY_FAILURE_THRESHOLD * 100).toFixed(0)}% of gateways failed - not reporting failures. Please check your observer configuration for potential issues.`,
        {
          totalGateways,
          failedGateways,
          failurePercentage: (failurePercentage * 100).toFixed(2) + '%',
          threshold: (MAX_GATEWAY_FAILURE_THRESHOLD * 100).toFixed(0) + '%',
        },
      );
      return reportInfo;
    }

    log.verbose('Saving report...');
    let lastReportInfo = reportInfo;
    for (const { name, sink } of this.sinks) {
      try {
        log.verbose(`Saving report using ${name}...`);
        lastReportInfo = await sink.saveReport(lastReportInfo);

        // Setting report to undefined to avoid verbose logging
        log.verbose(`Report saved using ${name}`, {
          ...lastReportInfo,
          report: undefined,
        });
      } catch (error: any) {
        log.error(`Error saving report using ${name}`, {
          message: error.message,
          stack: error.stack,
        });
      }
    }

    return lastReportInfo;
  }
}
