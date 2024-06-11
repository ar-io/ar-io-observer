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
import { AoIORead } from '@ar.io/sdk';

import { ArnsNameList, ArnsNamesSource } from '../types.js';

export class ContractNamesSource implements ArnsNamesSource, ArnsNameList {
  private contract: AoIORead;
  constructor({ contract }: { contract: AoIORead }) {
    this.contract = contract;
  }

  async getNames({ epochIndex }: { epochIndex: number }): Promise<string[]> {
    const names = await this.contract.getPrescribedNames({
      epochIndex,
    });
    return names;
  }

  // we don't use height here, but it's required by the interface
  async getAllNames(_height: number): Promise<string[]> {
    const names = await this.contract.getArNSRecords();
    const namesArray = Object.keys(names).sort();
    return namesArray;
  }

  async getName(height: number, index: number): Promise<string> {
    const names = await this.getAllNames(height);
    return names[index];
  }

  async getNamesCount(height: number): Promise<number> {
    return (await this.getAllNames(height)).length;
  }
}
