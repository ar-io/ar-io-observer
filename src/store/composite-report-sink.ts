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

import { ObserverReport, ReportSaveResult, ReportSink } from '../types.js';

export class CompositeReportSink implements ReportSink {
  // Dependencies
  private log: winston.Logger;
  private sinks: ReportSink[];

  constructor({ log, sinks }: { log: winston.Logger; sinks: ReportSink[] }) {
    this.log = log.child({ class: this.constructor.name });
    this.sinks = sinks;
  }

  async saveReport(
    report: ObserverReport,
  ): Promise<ReportSaveResult | undefined> {
    const log = this.log.child({
      epochStartHeight: report.epochStartHeight,
    });
    log.debug('Saving report...');
    // TODO decide how to handle errors
    await Promise.allSettled(this.sinks.map((sink) => sink.saveReport(report)));
    log.debug('Report saved');

    // TODO decide if/how to return IDs
    return undefined;
  }
}
