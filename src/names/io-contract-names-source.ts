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

import { ArnsNamesSource } from '../types.js';

export class IOContractNamesSource implements ArnsNamesSource {
  private contract: AoIORead;
  constructor({ contract }: { contract: AoIORead }) {
    this.contract = contract;
  }

  async getPrescribedNames({
    epochIndex,
  }: {
    epochIndex: number;
  }): Promise<string[]> {
    const names = await this.contract.getPrescribedNames({
      epochIndex,
    });
    return names;
  }
}
