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

// 0.95: only block a near-total-failure report (~95%+), the signature of a real
// observer misconfig. Early on a fresh network the long tail of registered
// gateways legitimately fails assessment (5xx/TLS/conn-refused) while the
// operator's own gateways pass, so a lower gate (e.g. 0.8) would suppress honest
// high-but-legitimate reports. Override via OBSERVER_MAX_GATEWAY_FAILURE_THRESHOLD.
const DEFAULT_MAX_GATEWAY_FAILURE_THRESHOLD = 0.95;

export interface ReportSinkEntry {
  name: string;
  sink: ReportSink;
}

export class PipelineReportSink implements ReportSink {
  // Dependencies
  private log: winston.Logger;
  private sinks: ReportSinkEntry[];
  private maxGatewayFailureThreshold: number;

  constructor({
    log,
    sinks,
    maxGatewayFailureThreshold = DEFAULT_MAX_GATEWAY_FAILURE_THRESHOLD,
  }: {
    log: winston.Logger;
    sinks: ReportSinkEntry[];
    /**
     * Fraction in `[0, 1]`. If the share of gateways reported as failed
     * exceeds this value, the pipeline drops the report instead of
     * forwarding to downstream sinks. Defaults to 0.8 (production safe).
     * On environments where a high real failure rate is expected
     * (e.g. devnet with stub gateways), raise to 1.0 to disable the
     * gate — the `>` comparison means a threshold of 1.0 can never
     * trip.
     */
    maxGatewayFailureThreshold?: number;
  }) {
    this.log = log.child({ class: this.constructor.name });
    this.sinks = sinks;
    this.maxGatewayFailureThreshold = maxGatewayFailureThreshold;
  }

  async saveReport(reportInfo: ReportInfo): Promise<ReportInfo> {
    const report = reportInfo.report;
    const log = this.log.child({
      epochStartTimestamp: report.epochStartTimestamp,
      epochIndex: report.epochIndex,
      epochStartHeight: report.epochStartHeight,
    });

    // Safety gate: a misconfigured observer (DNS, firewall, ISP issues)
    // can report 100% failures and falsely penalize honest gateways. If
    // the failure share exceeds the configured threshold, drop the
    // report. Operators on networks where high real failure is expected
    // (e.g. devnet with stubs) can set the threshold to 1.0 to disable.
    const totalGateways = Object.keys(report.gatewayAssessments).length;
    const failedGateways = Object.values(report.gatewayAssessments).filter(
      (assessment) => assessment.pass === false,
    ).length;
    const failurePercentage =
      totalGateways === 0 ? 0 : failedGateways / totalGateways;

    if (failurePercentage > this.maxGatewayFailureThreshold) {
      log.error(
        `More than ${(this.maxGatewayFailureThreshold * 100).toFixed(0)}% of gateways failed - not reporting failures. Please check your observer configuration for potential issues.`,
        {
          totalGateways,
          failedGateways,
          failurePercentage: (failurePercentage * 100).toFixed(2) + '%',
          threshold: (this.maxGatewayFailureThreshold * 100).toFixed(0) + '%',
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
