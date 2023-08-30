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
import fs from 'node:fs';

import { EntropySource } from '../types.js';

export class CachedEntropySource implements EntropySource {
  private entropySource: EntropySource;
  private cachePath: string;

  constructor({
    entropySource,
    cachePath,
  }: {
    entropySource: EntropySource;
    cachePath: string;
  }) {
    this.entropySource = entropySource;
    this.cachePath = cachePath;

    this.ensureEntropyFileExists();
  }

  async ensureEntropyFileExists(): Promise<void> {
    try {
      // Throws if the file doesn't exist
      await fs.promises.access(this.cachePath);
    } catch {
      const entropy = await this.entropySource.getEntropy();
      await fs.promises.writeFile(this.cachePath, entropy);
    }
  }

  async getEntropy(): Promise<Buffer> {
    return fs.promises.readFile(this.cachePath);
  }
}
