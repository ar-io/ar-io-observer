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
import {
  Contract,
  EvaluationManifest,
  EvaluationOptions,
  Tag,
  Warp,
  WriteInteractionOptions,
  WriteInteractionResponse,
} from 'warp-contracts/mjs';
import * as winston from 'winston';

import { arweave } from '../system.js';
import { ObservationInteraction, ObserverContract } from '../types.js';

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

export async function getContractManifest({
  arweave,
  contractTxId,
}: {
  arweave: Arweave;
  contractTxId: string;
}): Promise<EvaluationManifest> {
  const { tags: encodedTags } = await arweave.transactions.get(contractTxId);
  const decodedTags = tagsToObject(encodedTags);
  const contractManifestString = decodedTags['Contract-Manifest'] ?? '{}';
  // TODO throw if manifest is missing
  const contractManifest = JSON.parse(contractManifestString);
  return contractManifest;
}

export class WarpContract implements ObserverContract {
  // Dependencies
  private log: winston.Logger;
  private warp: Warp;
  private contractId: string;

  private contract: Contract;
  private evaluationOptions: Partial<EvaluationOptions> | undefined;

  constructor({
    log,
    wallet,
    warp,
    contractId,
  }: {
    log: winston.Logger;
    wallet: JWKInterface;
    warp: Warp;
    contractId: string;
  }) {
    this.log = log;
    this.warp = warp;
    this.contractId = contractId;

    // Initialize the AR.IO contract
    this.contract = this.warp.pst(contractId);
    this.contract.connect(wallet);
  }

  async writeInteraction(
    interaction: ObservationInteraction,
    options?: WriteInteractionOptions,
  ): Promise<WriteInteractionResponse | null> {
    // get contract manifest
    if (this.evaluationOptions === undefined) {
      const { evaluationOptions = {} } = await getContractManifest({
        arweave,
        contractTxId: this.contractId,
      });
      this.log.debug(
        'Setting contract evaluation options...',
        evaluationOptions,
      );
      this.contract.setEvaluationOptions(evaluationOptions);
      this.evaluationOptions = evaluationOptions;
    }

    this.log.debug('Writing contract interaction...', { interaction });
    return this.contract.writeInteraction(interaction, {
      disableBundling: true,
      ...options,
    });
  }
}
