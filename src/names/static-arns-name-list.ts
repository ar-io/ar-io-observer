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
import { ArnsNameList } from '../types.js';

export class StaticArnsNameList implements ArnsNameList {
  private names: string[];

  constructor({ names }: { names: string[] }) {
    this.names = names;
  }

  async getNamesCount(_: number): Promise<number> {
    return this.names.length;
  }

  async getName(_: number, index: number): Promise<string> {
    return this.names[index];
  }

  async getAllNames(_: number): Promise<string[]> {
    return this.names;
  }
}
