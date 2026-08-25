/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { expect } from 'chai';

import {
  ARIO_GAR_ERROR__DISTRIBUTION_INCOMPLETE,
  ARIO_GAR_ERROR__EPOCH_ALREADY_EXISTS,
  ARIO_GAR_ERROR__EPOCH_IN_PROGRESS,
  ARIO_GAR_ERROR__INVALID_GATEWAY_ACCOUNT,
  ARIO_GAR_ERROR__INVALID_OBSERVATION,
  ARIO_GAR_ERROR__LEAVE_WINDOW_NOT_EXPIRED,
  ARIO_GAR_ERROR__NOT_PRESCRIBED_OBSERVER,
  ARIO_GAR_ERROR__PRESCRIPTIONS_ALREADY_DONE,
  ARIO_GAR_ERROR__REWARDS_ALREADY_DISTRIBUTED,
  ARIO_GAR_ERROR__WEIGHTS_ALREADY_TALLIED,
  ARIO_GAR_ERROR__WEIGHTS_NOT_TALLIED,
} from '@ar.io/solana-contracts/gar';

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
      // Codes come from the generated IDL constants rather than literals:
      // these four were previously written out by hand and every one of
      // them was wrong by +2 (6037/6041/6045/6049 are actually
      // NotPrescribedObserver / InvalidObservation / NoNamesAvailable /
      // InvalidGatewayAccount — all real failures).
      const examples = [
        ARIO_GAR_ERROR__REWARDS_ALREADY_DISTRIBUTED,
        ARIO_GAR_ERROR__EPOCH_ALREADY_EXISTS,
        ARIO_GAR_ERROR__WEIGHTS_ALREADY_TALLIED,
        ARIO_GAR_ERROR__PRESCRIPTIONS_ALREADY_DONE,
      ].map((code) => new Error(`AnchorError ... Error Number: ${code}`));
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
        ...[
          ARIO_GAR_ERROR__EPOCH_IN_PROGRESS,
          ARIO_GAR_ERROR__DISTRIBUTION_INCOMPLETE,
          ARIO_GAR_ERROR__WEIGHTS_NOT_TALLIED,
          // finalize_gone on a gateway whose leave window hasn't elapsed
          ARIO_GAR_ERROR__LEAVE_WINDOW_NOT_EXPIRED,
        ].map((code) => new Error(`AnchorError ... Error Number: ${code}`)),
        // ...same, hex form (0x17bf = 6079) as seen in simulation failures
        new Error(
          'Transaction simulation failed: custom program error: 0x17bf',
        ),
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

  describe('GAR error codes match the deployed program (drift guard)', () => {
    // These codes were hand-maintained and drifted +2 once already, because
    // `EpochsAlreadyEnabled` (6032) and `EpochCounterAlreadyAdvanced` (6033)
    // were inserted into the middle of the GarError enum. The drift made
    // `classifyError` swallow real failures as "already done" — which is
    // exactly how mainnet epoch 523 lost every observation without the
    // cranker treating it as an error. Pin the values so a future insertion
    // fails here rather than silently in production.
    const anchorError = (code: number) =>
      new Error(`AnchorError thrown. Error Number: ${code}.`);

    it('classifies InvalidObservation as a real error, not already_done', () => {
      expect(ARIO_GAR_ERROR__INVALID_OBSERVATION).to.equal(6041);
      expect(classifyError(anchorError(6041))).to.equal('real');
    });

    it('classifies InvalidGatewayAccount as a real error, not already_done', () => {
      expect(ARIO_GAR_ERROR__INVALID_GATEWAY_ACCOUNT).to.equal(6049);
      expect(classifyError(anchorError(6049))).to.equal('real');
    });

    it('classifies NotPrescribedObserver as a real error', () => {
      expect(ARIO_GAR_ERROR__NOT_PRESCRIBED_OBSERVER).to.equal(6037);
      expect(classifyError(anchorError(6037))).to.equal('real');
    });

    it('classifies the genuine already-done races as already_done', () => {
      expect(ARIO_GAR_ERROR__EPOCH_ALREADY_EXISTS).to.equal(6043);
      expect(ARIO_GAR_ERROR__WEIGHTS_ALREADY_TALLIED).to.equal(6047);
      expect(ARIO_GAR_ERROR__PRESCRIPTIONS_ALREADY_DONE).to.equal(6051);
      for (const code of [6043, 6047, 6051]) {
        expect(classifyError(anchorError(code))).to.equal('already_done');
      }
    });
  });
});
