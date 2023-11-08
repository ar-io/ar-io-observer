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

export class PipelineReportSink implements ReportSink {
  // Dependencies
  private log: winston.Logger;
  private sinks: ReportSink[];

  constructor({ log, sinks }: { log: winston.Logger; sinks: ReportSink[] }) {
    this.log = log.child({ class: this.constructor.name });
    this.sinks = sinks;
  }

  async saveReport(reportInfo: ReportInfo): Promise<ReportInfo | undefined> {
    const report = reportInfo.report;
    const log = this.log.child({
      epochStartHeight: report.epochStartHeight,
    });

    log.debug('Saving report...');
    let lastReportInfo = reportInfo;
    for (const sink of this.sinks) {
      try {
        const ret = await sink.saveReport(lastReportInfo);
        if (ret !== undefined) {
          lastReportInfo = ret;
        }
      } catch (error) {
        log.error('Error saving report', { error });
      }
    }
    log.debug('Report saved');

    return lastReportInfo;
  }
}
