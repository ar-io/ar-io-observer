/**
 * AR.IO Observer
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { expect } from 'chai';
import fs from 'node:fs';
import path from 'node:path';
import { BlockOffsetMapping } from './block-offset-mapping.js';

describe('BlockOffsetMapping', function () {
  describe('constructor', function () {
    it('should load mapping from valid file', function () {
      const mapping = new BlockOffsetMapping({
        filePath: path.join(
          process.cwd(),
          'src/data/offset-block-mapping.json',
        ),
      });

      expect(mapping.isLoaded()).to.be.true;
      const data = mapping.getMapping();
      expect(data).to.not.be.undefined;
      expect(data!.version).to.equal('1.0');
      expect(data!.intervals.length).to.be.greaterThan(2);
    });

    it('should handle missing file gracefully', function () {
      const mapping = new BlockOffsetMapping({
        filePath: '/nonexistent/path/mapping.json',
      });

      expect(mapping.isLoaded()).to.be.false;
      expect(mapping.getMapping()).to.be.undefined;
    });

    it('should handle no file path provided', function () {
      const mapping = new BlockOffsetMapping({});

      expect(mapping.isLoaded()).to.be.false;
      expect(mapping.getMapping()).to.be.undefined;
    });
  });

  describe('getSearchBounds', function () {
    let mapping: BlockOffsetMapping;

    before(function () {
      mapping = new BlockOffsetMapping({
        filePath: path.join(
          process.cwd(),
          'src/data/offset-block-mapping.json',
        ),
      });
    });

    it('should return undefined when mapping not loaded', function () {
      const emptyMapping = new BlockOffsetMapping({});
      const bounds = emptyMapping.getSearchBounds(1000000, 2000000);
      expect(bounds).to.be.undefined;
    });

    it('should return bounds for offset at genesis (before first interval)', function () {
      // Target offset before first non-genesis interval
      const bounds = mapping.getSearchBounds(1000, 2000000);

      expect(bounds).to.not.be.undefined;
      expect(bounds!.lowHeight).to.equal(0);
      // highHeight should be first interval's block height
      expect(bounds!.highHeight).to.be.greaterThan(0);
    });

    it('should return bounds for offset in middle of range', function () {
      // Use an offset that falls within the mapped range
      // ~100TB offset (around interval index 18)
      const targetOffset = 100000000000000; // 100 TB

      const bounds = mapping.getSearchBounds(targetOffset, 2000000);

      expect(bounds).to.not.be.undefined;
      expect(bounds!.lowHeight).to.be.greaterThan(0);
      expect(bounds!.highHeight).to.be.greaterThan(bounds!.lowHeight);
      // Range should be much smaller than full range
      const range = bounds!.highHeight - bounds!.lowHeight;
      expect(range).to.be.lessThan(100000);
    });

    it('should return bounds for offset beyond last mapped interval', function () {
      // Use an offset beyond the last mapped interval
      const targetOffset = 400000000000000; // 400 TB (beyond current mapping)
      const currentHeight = 2000000;

      const bounds = mapping.getSearchBounds(targetOffset, currentHeight);

      expect(bounds).to.not.be.undefined;
      // lowHeight should be from last interval
      expect(bounds!.lowHeight).to.be.greaterThan(1700000);
      // highHeight should be currentHeight
      expect(bounds!.highHeight).to.equal(currentHeight);
    });

    it('should narrow search range significantly compared to full range', function () {
      // Test with various offsets to ensure narrowing works
      const currentHeight = 1800000;
      const testOffsets = [
        10000000000000, // ~10 TB
        50000000000000, // ~50 TB
        100000000000000, // ~100 TB
        200000000000000, // ~200 TB
        300000000000000, // ~300 TB
      ];

      for (const offset of testOffsets) {
        const bounds = mapping.getSearchBounds(offset, currentHeight);
        if (bounds) {
          const narrowedRange = bounds.highHeight - bounds.lowHeight;
          const fullRange = currentHeight;
          const reductionPercent =
            ((fullRange - narrowedRange) / fullRange) * 100;

          // Should reduce search range by at least 95%
          expect(reductionPercent).to.be.greaterThan(95);
        }
      }
    });

    it('should handle boundary conditions correctly', function () {
      const data = mapping.getMapping();
      if (!data || data.intervals.length < 3) {
        this.skip();
        return;
      }

      // Test at exact interval boundary
      const secondInterval = data.intervals[1];
      const bounds = mapping.getSearchBounds(secondInterval.offset, 2000000);

      expect(bounds).to.not.be.undefined;
      // At exact boundary, should return bracketing intervals
      expect(bounds!.lowHeight).to.equal(secondInterval.blockHeight);
    });
  });
});
