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
import { args } from './config.js';
import {
  observer,
  persistenceReportSink,
  submissionGate,
  submissionReportSink,
} from './system.js';

const report = await observer.generateReport();
console.log('Report: ');
console.log(JSON.stringify(report, null, 2));

if (args.saveReport) {
  // Mirror ContinuousObserver: persistence ALWAYS runs; submission
  // gated on prescription so the one-shot CLI doesn't burn Turbo
  // credits + RPC for a report with no on-chain pathway.
  const persisted = await persistenceReportSink.saveReport({ report });

  if (submissionReportSink !== undefined) {
    let proceed = true;
    if (submissionGate !== undefined) {
      try {
        const decision = await submissionGate(report);
        proceed = decision.proceed;
        if (!proceed) {
          console.log(
            `Submission skipped: ${decision.reason ?? 'gate returned proceed=false'}`,
          );
        }
      } catch (err: any) {
        // Conservative: if we can't determine prescription, don't
        // upload. The CLI is one-shot — there's no "retry next cycle."
        console.log(`Submission gate failed: ${err.message}`);
        proceed = false;
      }
    }
    if (proceed) {
      await submissionReportSink.saveReport(persisted);
    }
  }
}
