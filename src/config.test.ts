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

import { parseCommaSeparatedList } from './config.js';

describe('parseCommaSeparatedList', () => {
  it('parses a plain comma-separated list', () => {
    expect(parseCommaSeparatedList('a.com,b.com')).to.deep.equal([
      'a.com',
      'b.com',
    ]);
  });

  it('trims spaces after commas', () => {
    // The regression this exists for: an untrimmed split yields ' b.com',
    // which matches no gateway and silently shrinks the observation set.
    expect(parseCommaSeparatedList('a.com, b.com')).to.deep.equal([
      'a.com',
      'b.com',
    ]);
  });

  it('trims surrounding whitespace of every entry', () => {
    expect(parseCommaSeparatedList('  a.com ,\tb.com , c.com  ')).to.deep.equal(
      ['a.com', 'b.com', 'c.com'],
    );
  });

  it('drops empty entries from stray or trailing commas', () => {
    expect(parseCommaSeparatedList('a.com,,b.com,')).to.deep.equal([
      'a.com',
      'b.com',
    ]);
  });

  it('returns an empty list for an empty or whitespace-only value', () => {
    // The unset case: config passes '' when neither env nor CLI arg is set,
    // and an empty list means "no restriction".
    expect(parseCommaSeparatedList('')).to.deep.equal([]);
    expect(parseCommaSeparatedList('   ')).to.deep.equal([]);
    expect(parseCommaSeparatedList(',')).to.deep.equal([]);
  });

  it('preserves a single entry unchanged', () => {
    expect(parseCommaSeparatedList('only.example')).to.deep.equal([
      'only.example',
    ]);
  });
});
