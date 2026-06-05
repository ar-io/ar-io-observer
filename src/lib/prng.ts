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

import crypto from 'node:crypto';

/**
 * Creates a deterministic pseudo-random number generator seeded with a buffer.
 * Uses SHA-256 hash chaining to generate random values.
 *
 * @param seed - Buffer to seed the PRNG
 * @returns A function that returns a random float between 0 and 1
 */
export function customHashPRNG(seed: Buffer): () => number {
  if (!Buffer.isBuffer(seed)) {
    throw new Error('Seed must be a Buffer.');
  }

  let currentHash = seed;

  return () => {
    // Create a new hash from the current hash
    const hash = crypto.createHash('sha256');
    hash.update(currentHash);
    currentHash = hash.digest();

    // Convert the hash to a floating-point number and return it
    const int = currentHash.readBigUInt64BE(0);
    return Number(int) / 2 ** 64;
  };
}

/**
 * Fisher-Yates shuffle with a deterministic PRNG.
 *
 * @param array - Array to shuffle
 * @param rng - Random number generator function (returns 0-1)
 * @returns A new shuffled array (does not modify the original)
 */
export function shuffleWithPRNG<T>(array: T[], rng: () => number): T[] {
  const result = [...array];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}
