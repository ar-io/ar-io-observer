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

import { ObserverContract, ObserversSource } from '../types.js';

export class ContractObserversSource implements ObserversSource {
  private log: winston.Logger;
  private contract: ObserverContract;

  private functionName;

  constructor({
    log,
    contract,
    functionName = 'prescribedObservers',
  }: {
    log: winston.Logger;
    contract: ObserverContract;
    functionName?: string;
  }) {
    this.log = log;
    this.contract = contract;
    this.functionName = functionName;
  }

  async getObservers(): Promise<string[]> {
    this.log.info('Reading observers from contract...');
    const result = (await this.contract.readInteraction(this.functionName))
      .result;
    if (result !== undefined) {
      return Object.values(result as object).map(
        (value) => value.observerAddress,
      );
    } else {
      return [];
    }
  }
}
