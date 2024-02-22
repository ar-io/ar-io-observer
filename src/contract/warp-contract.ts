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
  InteractionResult,
  Tag,
  Warp,
  WriteInteractionOptions,
  WriteInteractionResponse,
} from 'warp-contracts/mjs';
import * as winston from 'winston';

import { arweave } from '../system.js';
import { ObservationInteraction, ObserverContract } from '../types.js';

const MAX_INTERACTION_RETRIES = 5;
const RETRY_INTERVAL_MS = 1000;

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
  private cacheUrl: string;
  private contractId: string;

  private contract: Contract;
  private evaluationOptions: Partial<EvaluationOptions> | undefined;

  constructor({
    log,
    wallet,
    warp,
    cacheUrl,
    contractId,
  }: {
    log: winston.Logger;
    wallet: JWKInterface;
    warp: Warp;
    cacheUrl: string;
    contractId: string;
  }) {
    this.log = log;
    this.warp = warp;
    this.cacheUrl = cacheUrl;
    this.contractId = contractId;

    // Initialize the AR.IO contract
    this.contract = this.warp.pst(contractId);
    this.contract.connect(wallet);
  }

  async ensureContractInit(): Promise<void> {
    // Get contact manifest and sync state
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
      await this.contract.syncState(
        `${this.cacheUrl}/v1/contract/${this.contractId}`,
        {
          validity: true,
        },
      );
    }
  }

  async readInteraction(
    functionName: string,
    input?: object,
  ): Promise<InteractionResult<unknown, unknown>> {
    const log = this.log.child({ functionName });
    await this.ensureContractInit();

    log.debug('Reading contract interaction...', {
      input,
    });
    let result: InteractionResult<unknown, unknown> | undefined = undefined;
    for (let i = 0; i < MAX_INTERACTION_RETRIES; i++) {
      try {
        result = await this.contract.viewState({
          function: functionName,
          ...input,
        });
        if (result !== undefined) {
          break;
        }
      } catch (error: any) {
        log.error('Error reading interaction:', {
          message: error?.message,
          stack: error?.stack,
        });
        log.info('Retrying read interaction...');
        await new Promise((resolve) => setTimeout(resolve, RETRY_INTERVAL_MS));
      }
    }
    if (result === undefined) {
      throw new Error('Max interaction retries exceeded');
    }
    return result;
  }

  async writeInteraction(
    interaction: ObservationInteraction,
    options?: WriteInteractionOptions,
  ): Promise<WriteInteractionResponse> {
    await this.ensureContractInit();

    this.log.debug('Dry writing contract interaction...', { interaction });
    const dryWriteResult = await this.contract.dryWrite(interaction);
    if (dryWriteResult.type === 'error') {
      throw new Error(`Dry write failed: ${dryWriteResult.errorMessage}`);
    }

    this.log.debug('Writing contract interaction...', { interaction });
    for (let i = 0; i < MAX_INTERACTION_RETRIES; i++) {
      try {
        const response = await this.contract.writeInteraction(interaction, {
          disableBundling: true,
          ...options,
        });

        if (!response) {
          throw new Error();
        }

        return response;
      } catch (error: any) {
        this.log.error('Error writing interaction:', {
          message: error?.message,
          stack: error?.stack,
        });
        this.log.info('Retrying write interaction...');
        await new Promise((resolve) => setTimeout(resolve, RETRY_INTERVAL_MS));
      }
    }
    throw new Error('Max interaction retries exceeded');
  }
}
