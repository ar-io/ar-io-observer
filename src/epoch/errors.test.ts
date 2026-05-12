/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { expect } from 'chai';

import { classifyError, parseAnchorErrorCode } from './errors.js';

describe('cranker error classification', () => {
  describe('parseAnchorErrorCode', () => {
    it('extracts decimal error number from Anchor error message', () => {
      const err = new Error('AnchorError: Error Number: 6037. Some text.');
      expect(parseAnchorErrorCode(err)).to.equal(6037);
    });

    it('extracts framework error code 3012 (AccountNotInitialized)', () => {
      const err = new Error(
        'AnchorError caused by account: observation. Error Code: AccountNotInitialized. Error Number: 3012. Error Message: The program expected this account to be already initialized.',
      );
      expect(parseAnchorErrorCode(err)).to.equal(3012);
    });

    it('extracts hex `custom program error: 0xNN` form', () => {
      // Lowercase per the regex; 0x1771 = 6001 decimal.
      const err = new Error('failed with custom program error: 0x1771');
      expect(parseAnchorErrorCode(err)).to.equal(6001);
    });

    it('maps "already in use" to AlreadyInitialized (code 0)', () => {
      const err = new Error('Account 0x123 already in use');
      expect(parseAnchorErrorCode(err)).to.equal(0);
    });

    it('returns null for unrecognised error shapes', () => {
      expect(parseAnchorErrorCode(new Error('connection refused'))).to.equal(
        null,
      );
    });
  });

  describe('classifyError', () => {
    it('categorises GAR program errors marked as already-done as "already_done"', () => {
      const examples = [
        // RewardsAlreadyDistributed
        new Error('AnchorError ... Error Number: 6037'),
        // EpochAlreadyExists
        new Error('AnchorError ... Error Number: 6041'),
        // WeightsAlreadyTallied
        new Error('AnchorError ... Error Number: 6045'),
        // PrescriptionsAlreadyDone
        new Error('AnchorError ... Error Number: 6049'),
      ];
      for (const e of examples) {
        expect(classifyError(e)).to.equal('already_done');
      }
    });

    it('categorises Anchor `AccountNotInitialized` (3012) as "already_done"', () => {
      // The cranker walks all registry observers looking for stale
      // Observation PDAs to close. Missing PDAs are expected — anyone
      // who didn't observe doesn't have one. The classifier folds
      // 3012 into already_done so the cleanup loop runs quietly.
      const err = new Error(
        'AnchorError ... Error Number: 3012 ... AccountNotInitialized',
      );
      expect(classifyError(err)).to.equal('already_done');
    });

    it('categorises not-yet-ready GAR errors as "not_ready"', () => {
      const examples = [
        // EpochInProgress
        new Error('AnchorError ... Error Number: 6034'),
        // DistributionIncomplete
        new Error('AnchorError ... Error Number: 6038'),
        // WeightsNotTallied
        new Error('AnchorError ... Error Number: 6046'),
      ];
      for (const e of examples) {
        expect(classifyError(e)).to.equal('not_ready');
      }
    });

    it('treats transient RPC failures as "not_ready" (avoids error spam)', () => {
      const examples = [
        new Error('BlockhashNotFound'),
        new Error('blockhash not found'),
        new Error('fetch failed'),
        new Error('Connection terminated'),
        new Error('ECONNRESET reading from RPC'),
        new Error('ETIMEDOUT'),
      ];
      for (const e of examples) {
        expect(classifyError(e)).to.equal('not_ready');
      }
    });

    it('treats RPC-level "already processed" as "already_done"', () => {
      expect(classifyError(new Error('Transaction already been processed'))).to.equal('already_done');
      expect(classifyError(new Error('AlreadyProcessed'))).to.equal('already_done');
    });

    it('falls through to "real" for unrecognised errors', () => {
      expect(classifyError(new Error('completely unexpected program error'))).to.equal('real');
    });
  });
});
