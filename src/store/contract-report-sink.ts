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

export function getFailedGatewaySummaryFromReport(
  observerReport: ObserverReport,
): string[] {
  const failedGatewaySummary: Set<string> = new Set();
  Object.values(observerReport.gatewayAssessments).forEach(
    (gatewayAssessment) => {
      const {
        expectedWallets,
        observedWallet,
        pass: ownershipPass,
      } = gatewayAssessment.ownershipAssessment;

      if (observedWallet !== null) {
        // A wallet was observed - check each expected wallet
        for (const wallet of expectedWallets) {
          if (wallet === observedWallet) {
            // This is the observed wallet - only mark as failed if ownership assessment failed
            if (!ownershipPass) {
              failedGatewaySummary.add(wallet);
            }
          } else {
            // This wallet doesn't match the observed wallet - always mark as failed
            // since it doesn't actually control this gateway
            failedGatewaySummary.add(wallet);
          }
        }

        // If the observed wallet is not in the expected wallets list, mark it as failed too
        // (it's an unauthorized wallet controlling the gateway)
        if (!expectedWallets.includes(observedWallet)) {
          failedGatewaySummary.add(observedWallet);
        }
      } else {
        // No wallet was observed (gateway didn't respond or error occurred)
        // Mark all expected wallets as failed since we couldn't verify ownership
        for (const wallet of expectedWallets) {
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
  private readonly networkSource: 'ao' | 'solana';

  constructor({
    log,
    contract,
    walletAddress,
    networkSource = 'ao',
  }: {
    log: winston.Logger;
    contract: AoARIOWrite;
    walletAddress: string;
    networkSource?: 'ao' | 'solana';
  }) {
    this.log = log;
    this.contract = contract;
    this.walletAddress = walletAddress;
    this.networkSource = networkSource;
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

    if (reportTxId === undefined) {
      throw new Error('Report TX ID is undefined');
    }

    // Solana: observation PDA is per-epoch-per-observer and uses `init`, so
    // only ONE saveObservations call is allowed. The SDK encodes all
    // gateways into a 375-byte bitfield — no batching needed.
    // AO: messages can be sent multiple times, so we split large summaries
    // into batches to stay within message size limits.
    const observationBatches =
      this.networkSource === 'solana'
        ? [failedGatewaySummaries]
        : splitFailedGatewaySummaries;

    this.log.verbose('Saving observation interactions...', {
      networkSource: this.networkSource,
      batchCount: observationBatches.length,
      totalFailedGateways: failedGatewaySummaries.length,
    });
    const saveObservationsTxIds: string[] = [];
    for (const failedGatewaySummary of observationBatches) {
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
