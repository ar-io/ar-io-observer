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
import { expect } from 'chai';

import { getEpochEnd, getEpochStart } from './static-epoch-source.js';

describe('getEpochEnd', () => {
  it('should return the correct epoch end when the height at the start of an epoch', () => {
    [10, 20, 30].forEach((height) => {
      const result = getEpochEnd({
        startHeight: 0,
        epochBlockLength: 10,
        height,
      });
      expect(result).to.equal(height + 9);
    });
  });

  it('should return the correct epoch end when the height is in the middle of an epoch', () => {
    [10, 20, 30].forEach((height) => {
      const result = getEpochEnd({
        startHeight: 0,
        epochBlockLength: 10,
        height: height + 5,
      });
      expect(result).to.equal(height + 9);
    });
  });

  it('should return the correct epoch end when the height is at the end of an epoch', () => {
    [10, 20, 30].forEach((height) => {
      const result = getEpochEnd({
        startHeight: 0,
        epochBlockLength: 10,
        height: height + 9,
      });
      expect(result).to.equal(height + 9);
    });
  });
});

describe('getEpochStart', () => {
  it('should return the correct epoch start when the height at the start of an epoch', () => {
    [10, 20, 30].forEach((height) => {
      const result = getEpochStart({
        startHeight: 0,
        epochBlockLength: 10,
        height,
      });
      expect(result).to.equal(height);
    });
  });

  it('should return the correct epoch start when the height is in the middle of an epoch', () => {
    [10, 20, 30].forEach((height) => {
      const result = getEpochStart({
        startHeight: 0,
        epochBlockLength: 10,
        height: height + 5,
      });
      expect(result).to.equal(height);
    });
  });

  it('should return the correct epoch start when the height is at the end of an epoch', () => {
    [10, 20, 30].forEach((height) => {
      const result = getEpochStart({
        startHeight: 0,
        epochBlockLength: 10,
        height: height + 9,
      });
      expect(result).to.equal(height);
    });
  });
});
