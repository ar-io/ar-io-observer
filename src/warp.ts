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
import { ObservationPublisher, ObserverReport } from './types.js';

export const arweave = new Arweave({
  host: 'ar-io.dev',
  port: 443,
  protocol: 'https',
});

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

export function getFailedGatewaySummary(
  observationReport: ObserverReport,
): string[] {
  const failedGatewaySummary: string[] = [];
  for (const gatewayName in observationReport.gatewayAssessments) {
    const gatewayAssessment = observationReport.gatewayAssessments[gatewayName];
    // Check if the pass property is false
    if (gatewayAssessment.pass === false) {
      failedGatewaySummary.push(gatewayName);
    }
  }
  return failedGatewaySummary;
}

export class PublishFromNewObservation implements ObservationPublisher {
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
    observationReportTxId: string,
    observerReport: ObserverReport,
  ): Promise<string> {
    // get contract manifest
    const { evaluationOptions = {} } = await getContractManifest({
      contractTxId: CONTRACT_ID,
    });

    // Read the AR.IO Contract
    const contract = this.warp.pst(CONTRACT_ID);

    // connect to wallet
    contract.connect(this.wallet).setEvaluationOptions(evaluationOptions);

    const failedGateways: string[] = getFailedGatewaySummary(observerReport);

    const saveObservationsTxId = await contract.writeInteraction(
      {
        function: 'saveObservations',
        observationReportTxId,
        failedGateways,
      },
      {
        disableBundling: true,
      },
    );
    return saveObservationsTxId?.originalTxId ?? 'invalid';
  }
}
