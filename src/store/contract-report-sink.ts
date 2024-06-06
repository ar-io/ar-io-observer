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
import { AoIORead, AoIOWrite, IO } from '@ar.io/sdk/node';
import { Tag } from 'arweave/node/lib/transaction.js';
import * as winston from 'winston';

import { IO_PROCESS_ID } from '../config.js';
import { ObserverReport, ReportInfo, ReportSink } from '../types.js';

const MAX_FAILED_GATEWAY_SUMMARY_BYTES = 1280;

export function getFailedGatewaySummaryFromReport(
  observerReport: ObserverReport,
): string[] {
  const failedGatewaySummary: Set<string> = new Set();
  Object.values(observerReport.gatewayAssessments).forEach(
    (gatewayAssessment) => {
      // Add expected wallets that do not match the observed wallet to the failed set
      gatewayAssessment.ownershipAssessment.expectedWallets.forEach(
        (wallet) => {
          if (gatewayAssessment.ownershipAssessment.observedWallet !== wallet) {
            failedGatewaySummary.add(wallet);
          }
        },
      );
    },
  );
  return [...failedGatewaySummary].sort();
}

export async function interactionAlreadySaved({
  observerWallet,
  epochIndex,
  failedGatewaySummaries,
  contract = IO.init({ processId: IO_PROCESS_ID }),
}: {
  observerWallet: string;
  epochIndex: number;
  failedGatewaySummaries: string[];
  contract?: AoIORead;
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
  private contract: AoIOWrite;
  private readonly walletAddress: string;

  constructor({
    log,
    contract,
    walletAddress,
  }: {
    log: winston.Logger;
    contract: AoIOWrite;
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
        this.log.info('Observation interactions already saved');
        return reportInfo;
      }
    } catch (error) {
      throw new Error('Failed to check if interactions already saved');
    }

    // Processes each failed gateway summary using the same observation report tx id.
    this.log.info('Saving observation interactions...');
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
            new Tag('AR-IO-Epoch-Index', report.epochIndex.toString()),
            new Tag('AR-IO-Observation-Report-Tx-Id', reportTxId),
          ],
        },
      );
      saveObservationsTxIds.push(saveObservationsTxId);
    }

    this.log.info('Observation interactions saved', {
      interactionIds: saveObservationsTxIds,
    });

    return {
      ...reportInfo,
      interactionTxIds: saveObservationsTxIds,
    };
  }
}
