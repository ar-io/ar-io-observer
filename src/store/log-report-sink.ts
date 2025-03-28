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

import {
  ArnsNameAssessment,
  ArnsNameAssessments,
  ReportInfo,
  ReportSink,
} from '../types.js';

export class LogReportSink implements ReportSink {
  // Dependencies
  private log: winston.Logger;

  constructor({ log }: { log: winston.Logger }) {
    this.log = log.child({ class: this.constructor.name });
  }

  /**
   * Helper method to log a single ArNS assessment
   * @param log The logger to use
   * @param type The type of assessment (prescribed or chosen)
   * @param arnsName The ArNS name being assessed
   * @param assessment The assessment data
   */
  private logArnsAssessment(
    log: winston.Logger,
    type: string,
    arnsName: string,
    assessment: ArnsNameAssessment,
  ): void {
    const { timings } = assessment;

    log.info(`${type} ArNS name assessment: ${arnsName}`, {
      name: 'ArNSNameAssessment',
      arnsName,
      pass: assessment.pass,
      expectedId: assessment.expectedId,
      resolvedId: assessment.resolvedId,
      expectedDataHash: assessment.expectedDataHash,
      resolvedDataHash: assessment.resolvedDataHash,
      resolvedStatusCode: assessment.resolvedStatusCode,
      expectedStatusCode: assessment.expectedStatusCode,
      failureReason: assessment.failureReason,
      assessedAt: assessment.assessedAt,
      // Detailed timing information (in milliseconds)
      waitTime: timings?.wait,
      dnsTime: timings?.dns,
      tcpTime: timings?.tcp,
      tlsTime: timings?.tls,
      firstByteTime: timings?.firstByte,
      downloadTime: timings?.download,
      totalTime: timings?.total,
    });
  }

  /**
   * Process and log all assessments of a specific type
   * @param log The logger to use
   * @param type The type of assessments (Prescribed or Chosen)
   * @param assessments The collection of assessments to log
   * @returns Object containing passed and failed assessments information
   */
  private logAllArnsAssessments(
    log: winston.Logger,
    type: string,
    assessments: ArnsNameAssessments,
  ): {
    passedNames: string[];
    failedNames: Array<{
      arnsName: string;
      failureReason?: string;
      resolvedId: string | null;
      expectedId: string | null;
    }>;
  } {
    // Count passed and failed assessments
    const passedNames: string[] = [];
    const failedNames: Array<{
      arnsName: string;
      failureReason?: string;
      resolvedId: string | null;
      expectedId: string | null;
    }> = [];

    // Process each assessment
    for (const [arnsName, assessment] of Object.entries(assessments)) {
      // Log the assessment
      this.logArnsAssessment(log, type, arnsName, assessment);

      // Track passed/failed status
      if (assessment.pass) {
        passedNames.push(arnsName);
      } else {
        failedNames.push({
          arnsName,
          failureReason: assessment.failureReason,
          resolvedId: assessment.resolvedId,
          expectedId: assessment.expectedId,
        });
      }
    }

    return { passedNames, failedNames };
  }

  async saveReport(reportInfo: ReportInfo): Promise<ReportInfo> {
    const { report } = reportInfo;
    const assessmentLog = this.log.child({
      epochIndex: report.epochIndex,
      epochStartHeight: report.epochStartHeight,
    });

    assessmentLog.info('Assessment report summary', {
      name: 'AssessmentReportSummary',
      observerAddress: report.observerAddress,
      epochStartTimestamp: report.epochStartTimestamp,
      epochEndTimestamp: report.epochEndTimestamp,
      generatedAt: report.generatedAt,
      gatewayCount: Object.keys(report.gatewayAssessments).length,
    });

    // Log details for each gateway
    for (const [gateway, assessment] of Object.entries(
      report.gatewayAssessments,
    )) {
      const gatewayLog = assessmentLog.child({ gateway });

      // Log ownership assessment
      gatewayLog.info('Gateway ownership assessment', {
        name: 'GatewayOwnershipAssessment',
        expectedWallets: assessment.ownershipAssessment.expectedWallets,
        observedWallet: assessment.ownershipAssessment.observedWallet,
        ownershipPass: assessment.ownershipAssessment.pass,
        failureReason: assessment.ownershipAssessment.failureReason,
      });

      // Process and log prescribed and chosen ArNS name assessments
      const prescribedResults = this.logAllArnsAssessments(
        gatewayLog,
        'Prescribed',
        assessment.arnsAssessments.prescribedNames,
      );

      const chosenResults = this.logAllArnsAssessments(
        gatewayLog,
        'Chosen',
        assessment.arnsAssessments.chosenNames,
      );

      // Log ArNS assessments summary
      gatewayLog.info('Gateway ArNS assessments summary', {
        name: 'GatewayArNSAssessmentsSummary',
        // Prescribed names stats
        prescribedNamesCount: Object.keys(
          assessment.arnsAssessments.prescribedNames,
        ).length,
        passedPrescribedNamesCount: prescribedResults.passedNames.length,
        failedPrescribedNamesCount: prescribedResults.failedNames.length,

        // Chosen names stats
        chosenNamesCount: Object.keys(assessment.arnsAssessments.chosenNames)
          .length,
        passedChosenNamesCount: chosenResults.passedNames.length,
        failedChosenNamesCount: chosenResults.failedNames.length,

        // Overall assessment
        overallPass: assessment.pass,
      });
    }

    return reportInfo;
  }
}
