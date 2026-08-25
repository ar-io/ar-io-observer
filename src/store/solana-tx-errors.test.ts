/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { expect } from 'chai';

import {
  isAlreadySubmittedError,
  isTransientSubmitError,
} from './solana-tx-errors.js';

/**
 * The exact error shape observed for epoch 512: a @solana/kit
 * SolanaError with `context.__code` 1 (SOLANA_ERROR__BLOCK_HEIGHT_EXCEEDED).
 */
function blockHeightExceededError(): Error {
  const err: any = new Error(
    'The network has progressed past the last block for which this transaction could have been committed.',
  );
  err.name = 'SolanaError';
  err.context = {
    __code: 1,
    currentBlockHeight: 417090557n,
    lastValidBlockHeight: 417090556n,
  };
  return err;
}

describe('solana-tx-errors', () => {
  describe('isTransientSubmitError', () => {
    it('matches the observed blockhash-expiry error', () => {
      expect(isTransientSubmitError(blockHeightExceededError())).to.equal(true);
    });

    it('matches on context.__code alone when the message is reworded', () => {
      const err: any = new Error('confirmation gave up');
      err.context = { __code: 1 };
      expect(isTransientSubmitError(err)).to.equal(true);
    });

    it('matches an error nested under `cause`', () => {
      // The SDK wraps the kit error before it reaches the sink.
      const err: any = new Error('sendAndConfirm failed');
      err.cause = blockHeightExceededError();
      expect(isTransientSubmitError(err)).to.equal(true);
    });

    it('matches RPC transport blips', () => {
      expect(isTransientSubmitError(new Error('socket hang up'))).to.equal(
        true,
      );
      expect(isTransientSubmitError(new Error('fetch failed'))).to.equal(true);
    });

    it('does not match a program revert', () => {
      const err: any = new Error(
        'Transaction simulation failed: Error processing Instruction 0: custom program error: 0x1771',
      );
      err.context = { __code: 4615000 };
      expect(isTransientSubmitError(err)).to.equal(false);
    });

    it('does not match insufficient funds', () => {
      expect(
        isTransientSubmitError(
          new Error(
            'Attempt to debit an account but found no record of a prior credit',
          ),
        ),
      ).to.equal(false);
    });

    it('tolerates null and non-error input', () => {
      expect(isTransientSubmitError(undefined)).to.equal(false);
      expect(isTransientSubmitError(null)).to.equal(false);
      expect(isTransientSubmitError('socket hang up')).to.equal(true);
    });
  });

  describe('isAlreadySubmittedError', () => {
    it('matches the init-constraint allocation failure', () => {
      expect(
        isAlreadySubmittedError(
          new Error(
            'Allocate: account Address { address: 7fxz..., base: None } already in use',
          ),
        ),
      ).to.equal(true);
    });

    it('matches a duplicate signature', () => {
      expect(
        isAlreadySubmittedError(
          new Error('This transaction has already been processed'),
        ),
      ).to.equal(true);
    });

    it('does not match a blockhash expiry', () => {
      expect(isAlreadySubmittedError(blockHeightExceededError())).to.equal(
        false,
      );
    });
  });
});
