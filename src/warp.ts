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
import { JWKInterface } from 'arweave/node/lib/wallet.js';
import * as fs from 'node:fs';
import {
  EvaluationManifest,
  Tag,
  WarpFactory,
  defaultCacheOptions,
} from 'warp-contracts/mjs';

import { CONTRACT_ID, KEY_FILE } from './config.js';
import { uploadReportWithTurbo } from './turbo.js';
import { ObservationPublisher, ObserverReport } from './types.js';

export const arweave = new Arweave({
  host: 'ar-io.dev',
  port: 443,
  protocol: 'https',
});

const maxFailedGatewaySummarySizeInBytes = 2048 - 256; // 1792 bytes
const defaultArweave = arweave;
export async function getContractManifest({
  arweave = defaultArweave,
  contractTxId,
}: {
  arweave?: Arweave;
  contractTxId: string;
}): Promise<EvaluationManifest> {
  const { tags: encodedTags } = await arweave.transactions.get(contractTxId);
  const decodedTags = tagsToObject(encodedTags);
  const contractManifestString = decodedTags['Contract-Manifest'] ?? '{}';
  const contractManifest = JSON.parse(contractManifestString);
  return contractManifest;
}

export function tagsToObject(tags: Tag[]): {
  [x: string]: string;
} {
  return tags.reduce((decodedTags: { [x: string]: string }, tag) => {
    const key = tag.get('name', { decode: true, string: true });
    const value = tag.get('value', { decode: true, string: true });
    decodedTags[key] = value;
    return decodedTags;
  }, {});
}

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
  let currentArray = [];
  let currentSize = 0;
  const result = [];

  for (const str of array) {
    const encodedString = encoder.encode(str);
    const stringSizeInBytes = encodedString.length;

    if (currentSize + stringSizeInBytes > maxSizeInBytes) {
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

export class PublishFromObservation implements ObservationPublisher {
  // Get the key file used for the interaction
  private wallet: JWKInterface = JSON.parse(
    fs.readFileSync(KEY_FILE).toString(),
  );

  private warp = WarpFactory.forMainnet(
    {
      ...defaultCacheOptions,
    },
    true,
    arweave,
  );

  async saveObservations(
    observerReportTxId: string,
    observerReport: ObserverReport,
  ): Promise<string[]> {
    // get contract manifest
    const { evaluationOptions = {} } = await getContractManifest({
      contractTxId: CONTRACT_ID,
    });

    // Read the AR.IO Contract
    const contract = this.warp.pst(CONTRACT_ID);

    // connect to wallet
    contract.connect(this.wallet).setEvaluationOptions(evaluationOptions);

    const failedGatewaySummaries: string[] =
      getFailedGatewaySummaryFromReport(observerReport);

    // split up the failed gateway summaries if they are bigger than the max individual summary size
    const splitFailedGatewaySummaries = splitArrayBySize(
      failedGatewaySummaries,
      maxFailedGatewaySummarySizeInBytes,
    );

    // Processes each failed gateway summary using the same observation report tx id.
    const saveObservationsTxIds: string[] = [];
    for (const failedGatewaySummary of splitFailedGatewaySummaries) {
      console.log('Failed Gateway Summary:', failedGatewaySummary);
    }
    for (const failedGatewaySummary of splitFailedGatewaySummaries) {
      const saveObservationsTxId = await contract.writeInteraction(
        {
          function: 'saveObservations',
          observerReportTxId,
          failedGatewaySummary,
        },
        {
          disableBundling: true,
        },
      );
      if (saveObservationsTxId) {
        saveObservationsTxIds.push(saveObservationsTxId.originalTxId);
      } else {
        saveObservationsTxIds.push('invalid');
      }
    }
    return saveObservationsTxIds;
  }

  async uploadAndSaveObservations(observerReportFileName: string): Promise<{
    observerReportTxId: string | null;
    saveObservationsTxIds: string[];
  }> {
    const report: ObserverReport = JSON.parse(
      fs.readFileSync(observerReportFileName).toString(),
    );

    const observerReportTxId = await uploadReportWithTurbo(report);
    if (!observerReportTxId) {
      console.log('Error submitting report to turbo.');
      return { observerReportTxId: null, saveObservationsTxIds: [] };
    }

    // get contract manifest
    const { evaluationOptions = {} } = await getContractManifest({
      contractTxId: CONTRACT_ID,
    });

    // Read the AR.IO Contract
    const contract = this.warp.pst(CONTRACT_ID);

    // connect to wallet
    contract.connect(this.wallet).setEvaluationOptions(evaluationOptions);

    const failedGatewaySummaries: string[] =
      getFailedGatewaySummaryFromReport(report);

    // split up the failed gateway summaries if they are bigger than the max individual summary size
    const splitFailedGatewaySummaries = splitArrayBySize(
      failedGatewaySummaries,
      maxFailedGatewaySummarySizeInBytes,
    );
    console.log('Split into %s summaries: ', failedGatewaySummaries.length);
    console.log('Summary reports: ', failedGatewaySummaries);

    // Processes each failed gateway summary using the same observation report tx id.
    const saveObservationsTxIds: string[] = [];
    for (const failedGatewaySummary of splitFailedGatewaySummaries) {
      const saveObservationsTxId = await contract.writeInteraction(
        {
          function: 'saveObservations',
          observerReportTxId,
          failedGatewaySummary,
        },
        {
          disableBundling: true,
        },
      );
      if (saveObservationsTxId) {
        saveObservationsTxIds.push(saveObservationsTxId.originalTxId);
      } else {
        saveObservationsTxIds.push('invalid');
      }
    }
    return { observerReportTxId, saveObservationsTxIds };
  }
}
