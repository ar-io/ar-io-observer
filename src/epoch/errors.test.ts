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

    it('extracts framework error code 3007 (AccountOwnedByWrongProgram)', () => {
      const err = new Error(
        'AnchorError caused by account: observation. Error Code: AccountOwnedByWrongProgram. Error Number: 3007. Error Message: The given account is owned by a different program than expected.',
      );
      expect(parseAnchorErrorCode(err)).to.equal(3007);
    });

    it('extracts hex `custom program error: 0xbbf` (= 3007) form from simulation failures', () => {
      // What we actually see in `[crank:close_observation]` logs when
      // the cranker hits a non-existent Observation PDA.
      const err = new Error(
        'Transaction simulation failed: custom program error: 0xbbf',
      );
      expect(parseAnchorErrorCode(err)).to.equal(3007);
    });

    it('walks the cause chain on a SolanaError (top-level message is generic)', () => {
      // Reproduces the actual shape thrown by the SDK's
      // `sendAndConfirm`: a `SolanaError` whose `message` is just
      // "Transaction simulation failed", with the specific code packed
      // in `cause.context.logs[]` and `cause.context.err`.
      const inner = Object.assign(new Error('custom program error: #3007'), {
        context: {
          logs: [
            'Program AF8QAEaR4hzsqeUDwEdeTXMYtdyFegTENBdnJro6WVLR invoke [1]',
            'Program log: Instruction: CloseObservation',
            'Program log: AnchorError caused by account: observation. Error Code: AccountOwnedByWrongProgram. Error Number: 3007. Error Message: The given account is owned by a different program than expected.',
            'Program AF8QAEaR4hzsqeUDwEdeTXMYtdyFegTENBdnJro6WVLR failed: custom program error: 0xbbf',
          ],
          err: { InstructionError: [2, { Custom: 3007 }] },
        },
      });
      const outer = Object.assign(new Error('Transaction simulation failed'), {
        cause: inner,
      });
      expect(parseAnchorErrorCode(outer)).to.equal(3007);
    });

    it('extracts the `Custom: NNNN` form from kit-packed `context.err`', () => {
      const err = Object.assign(new Error('Transaction simulation failed'), {
        context: {
          err: { InstructionError: [2, { Custom: 6037 }] },
        },
      });
      expect(parseAnchorErrorCode(err)).to.equal(6037);
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

    it('categorises Anchor `AccountOwnedByWrongProgram` (3007) and `AccountNotInitialized` (3012) as "already_done"', () => {
      // Both codes mean the same thing for the cranker's close-observation
      // cleanup loop: the candidate PDA address doesn't currently hold
      // an Observation account, so there's nothing to close. 3007 is
      // what we observe in practice (PDA never initialized → System
      // Program owns the slot); 3012 is defensive coverage for
      // zero-data accounts.
      expect(
        classifyError(
          new Error(
            'AnchorError ... Error Number: 3007 ... AccountOwnedByWrongProgram',
          ),
        ),
      ).to.equal('already_done');
      expect(
        classifyError(
          new Error(
            'AnchorError ... Error Number: 3012 ... AccountNotInitialized',
          ),
        ),
      ).to.equal('already_done');
      // And the simulation-failure hex form that we actually see in
      // close_observation logs:
      expect(
        classifyError(
          new Error(
            'Transaction simulation failed: custom program error: 0xbbf',
          ),
        ),
      ).to.equal('already_done');
      // And the realistic SolanaError cause chain produced by the SDK
      // when close_observation hits a non-existent PDA:
      const inner = Object.assign(new Error('custom program error: #3007'), {
        context: {
          logs: [
            'Program log: AnchorError ... Error Number: 3007 ... AccountOwnedByWrongProgram',
            'Program ... failed: custom program error: 0xbbf',
          ],
          err: { InstructionError: [2, { Custom: 3007 }] },
        },
      });
      const outer = Object.assign(new Error('Transaction simulation failed'), {
        cause: inner,
      });
      expect(classifyError(outer)).to.equal('already_done');
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

    it('treats HTTP 429 rate-limit responses as "not_ready"', () => {
      // What QuickNode / Helius / Triton return when bursting at epoch
      // boundaries (cleanup + tally + distribute simultaneously).
      expect(
        classifyError(new Error('HTTP error (429): Too Many Requests')),
      ).to.equal('not_ready');
      expect(classifyError(new Error('Too Many Requests'))).to.equal(
        'not_ready',
      );
      expect(classifyError(new Error('rate limit exceeded'))).to.equal(
        'not_ready',
      );
      // Also walks the cause chain — RPC error nested in SolanaError
      const inner = new Error('HTTP error (429): Too Many Requests');
      const outer = Object.assign(new Error('Transaction send failed'), {
        cause: inner,
      });
      expect(classifyError(outer)).to.equal('not_ready');
    });

    it('treats RPC-level "already processed" as "already_done"', () => {
      expect(
        classifyError(new Error('Transaction already been processed')),
      ).to.equal('already_done');
      expect(classifyError(new Error('AlreadyProcessed'))).to.equal(
        'already_done',
      );
    });

    it('falls through to "real" for unrecognised errors', () => {
      expect(
        classifyError(new Error('completely unexpected program error')),
      ).to.equal('real');
    });
  });
});
