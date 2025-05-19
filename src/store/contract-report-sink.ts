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
import { AOProcess, ARIO, AoARIORead, AoARIOWrite } from '@ar.io/sdk/node';
import { connect } from '@permaweb/aoconnect';
import { Tag } from 'arweave/node/lib/transaction.js';
import * as winston from 'winston';

import * as config from '../config.js';
import { ObserverReport, ReportInfo, ReportSink } from '../types.js';

const MAX_FAILED_GATEWAY_SUMMARY_BYTES = 1280;
const GATEWAY_FAILURE_THRESHOLD = 0.8;

export function getFailedGatewaySummaryFromReport(
  observerReport: ObserverReport,
): string[] {
  const failedGatewaySummary: Set<string> = new Set();
  Object.values(observerReport.gatewayAssessments).forEach(
    (gatewayAssessment) => {
      // if the assessment failed, add the expected wallets to the failedGatewaySummary
      if (gatewayAssessment.pass === false) {
        // add the expected wallets as failed
        for (const wallet of gatewayAssessment.ownershipAssessment
          .expectedWallets) {
          failedGatewaySummary.add(wallet);
        }
      }
    },
  );
  return [...failedGatewaySummary].sort();
}

export async function interactionAlreadySaved({
  observerWallet,
  epochIndex,
  failedGatewaySummaries,
  contract = ARIO.init({
    process: new AOProcess({
      processId: config.IO_PROCESS_ID,
      ao: connect({
        CU_URL: config.NETWORK_AO_CU_URL,
        MU_URL: config.AO_MU_URL,
        GATEWAY_URL: config.AO_GATEWAY_URL,
        GRAPHQL_URL: config.AO_GRAPHQL_URL,
      }),
    }),
  }),
}: {
  observerWallet: string;
  epochIndex: number;
  failedGatewaySummaries: string[];
  contract?: AoARIORead;
}): Promise<boolean> {
  const observations = await contract.getObservations({
    epochIndex,
  });

  if (observations === undefined) {
    return false;
  }

  const epochFailureSummaries = observations.failureSummaries;
  if (
    observations === undefined ||
    epochFailureSummaries === undefined ||
    Object.keys(epochFailureSummaries).length === 0
  ) {
    return false;
  }

  for (const failedGateway of failedGatewaySummaries) {
    if (
      epochFailureSummaries[failedGateway] === undefined ||
      !epochFailureSummaries[failedGateway].includes(observerWallet)
    ) {
      return false;
    }
  }

  return true;
}

function splitArrayBySize(array: string[], maxSizeInBytes: number): string[][] {
  const encoder = new TextEncoder();
  let currentArray: string[] = [];
  let currentSize = 0;
  const result = [];

  for (const str of array) {
    const encodedString = encoder.encode(str);
    const stringSizeInBytes = encodedString.length;

    if (currentSize + stringSizeInBytes > maxSizeInBytes) {
      // Make a copy of currentArray and push it to the result
      result.push(currentArray);
      currentArray = [];
      currentSize = 0;
    }
    currentArray.push(str);
    currentSize += stringSizeInBytes;
  }

  if (currentArray.length > 0) {
    result.push(currentArray);
  }

  return result;
}

export class ContractReportSink implements ReportSink {
  // Dependencies
  private log: winston.Logger;
  private contract: AoARIOWrite;
  private readonly walletAddress: string;

  constructor({
    log,
    contract,
    walletAddress,
  }: {
    log: winston.Logger;
    contract: AoARIOWrite;
    walletAddress: string;
  }) {
    this.log = log;
    this.contract = contract;
    this.walletAddress = walletAddress;
  }

  async saveReport(reportInfo: ReportInfo): Promise<{
    report: ObserverReport;
    interactionTxIds?: string[];
  }> {
    const { report, reportTxId } = reportInfo;
    const failedGatewaySummaries: string[] =
      getFailedGatewaySummaryFromReport(report);

    this.log.debug('Gateways that failed observation', {
      failedGatewaySummaries: failedGatewaySummaries,
    });

    // Check if more than 80% of gateways failed
    const totalGateways = Object.keys(report.gatewayAssessments).length;
    const failedGateways = Object.values(report.gatewayAssessments).filter(
      (assessment) => assessment.pass === false,
    ).length;
    const failurePercentage = failedGateways / totalGateways;

    if (failurePercentage > GATEWAY_FAILURE_THRESHOLD) {
      this.log.error(
        `More than ${(GATEWAY_FAILURE_THRESHOLD * 100).toFixed(0)}% of gateways failed - not reporting failures`,
        {
          totalGateways,
          failedGateways,
          failurePercentage: (failurePercentage * 100).toFixed(2) + '%',
          threshold: (GATEWAY_FAILURE_THRESHOLD * 100).toFixed(0) + '%',
        },
      );
      return reportInfo;
    }

    // split up the failed gateway summaries if they are bigger than the max individual summary size
    const splitFailedGatewaySummaries = splitArrayBySize(
      failedGatewaySummaries,
      MAX_FAILED_GATEWAY_SUMMARY_BYTES,
    );

    try {
      this.log.debug('Checking if interactions were already saved');
      const isInteractionAlreadySaved = await interactionAlreadySaved({
        observerWallet: this.walletAddress,
        epochIndex: report.epochIndex,
        failedGatewaySummaries,
        contract: this.contract,
      });
      if (isInteractionAlreadySaved) {
        this.log.verbose('Observation interactions already saved');
        return reportInfo;
      }
    } catch (error: any) {
      this.log.error('Failed to check if interactions already saved', {
        message: error.message,
        stack: error.stack,
      });
      throw new Error('Failed to check if interactions already saved');
    }

    // Processes each failed gateway summary using the same observation report tx id.
    this.log.verbose('Saving observation interactions...');
    const saveObservationsTxIds: string[] = [];
    for (const failedGatewaySummary of splitFailedGatewaySummaries) {
      if (reportTxId === undefined) {
        throw new Error('Report TX ID is undefined');
      }
      const { id: saveObservationsTxId } = await this.contract.saveObservations(
        {
          reportTxId: reportTxId,
          failedGateways: failedGatewaySummary,
        },
        {
          tags: [
            new Tag('App-Name', 'AR-IO Observer'),
            new Tag('AR-IO-Component', 'observer'),
            new Tag(
              'AR-IO-Epoch-Start-Timestamp',
              report.epochStartTimestamp.toString(),
            ),
            new Tag(
              'AR-IO-Epoch-Start-Height',
              report.epochStartHeight.toString(),
            ),
            new Tag('AR-IO-Epoch-Index', report.epochIndex.toString()),
            new Tag('AR-IO-Observation-Report-Tx-Id', reportTxId),
          ],
        },
      );
      saveObservationsTxIds.push(saveObservationsTxId);
    }

    this.log.verbose('Observation interactions saved', {
      interactionIds: saveObservationsTxIds,
    });

    return {
      ...reportInfo,
      interactionTxIds: saveObservationsTxIds,
    };
  }
}
