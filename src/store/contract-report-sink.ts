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
import Arweave from 'arweave';
import { Tag } from 'warp-contracts/mjs';
import * as winston from 'winston';

import {
  ObserverContract,
  ObserverReport,
  ReportInfo,
  ReportSink,
} from '../types.js';

const MAX_FAILED_GATEWAY_SUMMARY_BYTES = 1280;

export function getFailedGatewaySummaryFromReport(
  observerReport: ObserverReport,
): string[] {
  const failedGatewaySummary: string[] = [];
  for (const gatewayName in observerReport.gatewayAssessments) {
    const gatewayAssessment = observerReport.gatewayAssessments[gatewayName];
    // Check if the pass property is false
    if (gatewayAssessment.pass === false) {
      failedGatewaySummary.push(gatewayName);
    }
  }
  return failedGatewaySummary;
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
  private arweave: Arweave;
  private contract: ObserverContract;
  private readonly walletAddress: string;

  constructor({
    log,
    arweave,
    contract,
    walletAddress,
  }: {
    log: winston.Logger;
    arweave: Arweave;
    contract: ObserverContract;
    walletAddress: string;
  }) {
    this.log = log;
    this.arweave = arweave;
    this.contract = contract;
    this.walletAddress = walletAddress;
  }

  async saveReport(reportInfo: ReportInfo): Promise<ReportInfo | undefined> {
    const { report, reportTxId } = reportInfo;
    const failedGatewaySummaries: string[] =
      getFailedGatewaySummaryFromReport(report);

    // split up the failed gateway summaries if they are bigger than the max individual summary size
    const splitFailedGatewaySummaries = splitArrayBySize(
      failedGatewaySummaries,
      MAX_FAILED_GATEWAY_SUMMARY_BYTES,
    );

    const interactionCount = await this.interactionCount(report);
    if (interactionCount >= splitFailedGatewaySummaries.length) {
      this.log.info('All interactions have already been saved');
      return reportInfo;
    }

    // TODO add epoch and observation report ID tags
    // Processes each failed gateway summary using the same observation report tx id.
    this.log.info('Saving observation interactions...');
    const saveObservationsTxIds: string[] = [];
    for (const failedGatewaySummary of splitFailedGatewaySummaries) {
      if (reportTxId === undefined) {
        throw new Error('Report TX ID is undefined');
      }
      const saveObservationsTxId = await this.contract.writeInteraction(
        {
          function: 'saveObservations',
          observerReportTxId: reportTxId,
          failedGateways: failedGatewaySummary,
        },
        {
          tags: [
            new Tag('AR-IO-Component', 'observer'),
            new Tag(
              'AR-IO-Epoch-Start-Height',
              report.epochStartHeight.toString(),
            ),
          ],
        },
      );
      if (saveObservationsTxId) {
        saveObservationsTxIds.push(saveObservationsTxId.originalTxId);
      } else {
        saveObservationsTxIds.push('invalid');
      }
    }
    this.log.info('Observation interactions saved');

    return {
      ...reportInfo,
      interactionTxIds: saveObservationsTxIds,
    };
  }

  async interactionCount(report: ObserverReport): Promise<number> {
    const epochStartHeight = report.epochStartHeight;
    // TODO handle more than 100 interactions
    const queryObject = {
      query: `{
  transactions(
    first:100,
    owners: [ "${this.walletAddress}" ],
    tags: [
      {
        name: "AR-IO-Epoch-Start-Height",
        values: [ "${epochStartHeight}" ]
      },
      {
        name: "AR-IO-Component",
        values: [ "observer" ]
      },
      {
        name: "App-Name",
        values: ["SmartWeaveAction"]
      }
    ]
  ) 
  {
    edges {
      node {
        id
      }
    }
  }
}`,
    };
    const response = await this.arweave.api.post('/graphql', queryObject);
    return response?.data?.data?.transactions?.edges?.length ?? 0;
  }

  //async uploadAndSaveObservations(observerReportFileName: string): Promise<{
  //  observerReportTxId: string | null;
  //  saveObservationsTxIds: string[];
  //}> {
  //  const report: ObserverReport = JSON.parse(
  //    fs.readFileSync(observerReportFileName).toString(),
  //  );

  //  const observerReportTxId = await uploadReportWithTurbo(report);
  //  if (observerReportTxId === null) {
  //    console.log('Error submitting report to turbo.');
  //    return { observerReportTxId: null, saveObservationsTxIds: [] };
  //  }

  //  // get contract manifest
  //  const { evaluationOptions = {} } = await getContractManifest({
  //    contractTxId: CONTRACT_ID,
  //  });

  //  // Read the AR.IO Contract
  //  const contract = this.warp.pst(CONTRACT_ID);

  //  // connect to wallet
  //  contract.connect(this.wallet).setEvaluationOptions(evaluationOptions);

  //  const failedGatewaySummaries: string[] =
  //    getFailedGatewaySummaryFromReport(report);

  //  // split up the failed gateway summaries if they are bigger than the max individual summary size
  //  const splitFailedGatewaySummaries = splitArrayBySize(
  //    failedGatewaySummaries,
  //    maxFailedGatewaySummarySizeInBytes,
  //  );

  //  // Processes each failed gateway summary using the same observation report tx id.
  //  const saveObservationsTxIds: string[] = [];
  //  for (const failedGatewaySummary of splitFailedGatewaySummaries) {
  //    const saveObservationsTxId = await contract.writeInteraction(
  //      {
  //        function: 'saveObservations',
  //        observerReportTxId,
  //        failedGateways: failedGatewaySummary,
  //      },
  //      {
  //        disableBundling: true,
  //      },
  //    );
  //    if (saveObservationsTxId) {
  //      saveObservationsTxIds.push(saveObservationsTxId.originalTxId);
  //    } else {
  //      saveObservationsTxIds.push('invalid');
  //    }
  //  }
  //  return { observerReportTxId, saveObservationsTxIds };
  //}
}
