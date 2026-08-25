/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Classify errors thrown while a Solana transaction is sent and
 * confirmed. Two questions matter to a submission retry loop:
 *
 *   1. Is the failure transient? A blockhash that expires before the
 *      transaction lands says nothing about the instruction. The same
 *      instruction, re-signed over a fresh blockhash, usually lands.
 *   2. Did the transaction already land? A confirmation timeout does
 *      not prove the transaction is dead. It can be committed while
 *      the client stops watching. A retry then hits the `init`
 *      constraint on the Observation PDA and reverts. That revert is a
 *      success signal, not a failure.
 *
 * Errors from @solana/kit carry a numeric `context.__code` and nest a
 * root cause under `cause`. Both are inspected. String matching is the
 * fallback because the RPC layer, the SDK, and the program each wrap
 * errors differently.
 */

/** Substrings that mark a retryable send/confirm failure. */
const TRANSIENT_PATTERNS = [
  // Blockhash expiry — the confirmed cause of the epoch 512 miss.
  'network has progressed past the last block',
  'block height exceeded',
  'blockheightexceeded',
  'blockhash not found',
  'blockhash expired',
  // Confirmation gave up before the cluster answered.
  'transactionexpiredtimeout',
  'was not confirmed',
  'timed out awaiting confirmation',
  'confirmation timeout',
  // RPC transport blips. The transaction may or may not have been
  // forwarded; the pre-retry state re-read settles that.
  'socket hang up',
  'fetch failed',
  'econnreset',
  'etimedout',
  'econnrefused',
  'service unavailable',
  'gateway timeout',
  'too many requests',
];

/** Substrings that mark "this observation is already on-chain". */
const ALREADY_SUBMITTED_PATTERNS = [
  // The Observation PDA is `init`-constrained. A second submission for
  // the same (epochIndex, observer) fails to allocate.
  'already in use',
  // The identical signed transaction was already committed.
  'already been processed',
];

/**
 * `SOLANA_ERROR__BLOCK_HEIGHT_EXCEEDED` from @solana/errors. Matched
 * numerically as well as by message so a reworded error still counts.
 */
const SOLANA_ERROR_BLOCK_HEIGHT_EXCEEDED = 1;

/** Flatten an error and its `cause` chain into lowercased text. */
function errorText(err: unknown): string {
  const parts: string[] = [];
  let current: any = err;
  for (
    let depth = 0;
    current !== null && current !== undefined && depth < 5;
    depth++
  ) {
    if (typeof current === 'string') {
      parts.push(current);
      break;
    }
    if (typeof current.message === 'string') {
      parts.push(current.message);
    }
    if (typeof current.name === 'string') {
      parts.push(current.name);
    }
    current = current.cause;
  }
  return parts.join(' ').toLowerCase();
}

/** Collect `context.__code` from an error and its `cause` chain. */
function errorCodes(err: unknown): number[] {
  const codes: number[] = [];
  let current: any = err;
  for (
    let depth = 0;
    current !== null && current !== undefined && depth < 5;
    depth++
  ) {
    const code = current.context?.__code;
    if (typeof code === 'number') {
      codes.push(code);
    }
    current = current.cause;
  }
  return codes;
}

/**
 * True when the failure is a send/confirm timing problem rather than a
 * rejected instruction. Callers should re-read on-chain state before
 * acting on this — see {@link isAlreadySubmittedError}.
 */
export function isTransientSubmitError(err: unknown): boolean {
  if (errorCodes(err).includes(SOLANA_ERROR_BLOCK_HEIGHT_EXCEEDED)) {
    return true;
  }
  const text = errorText(err);
  return TRANSIENT_PATTERNS.some((pattern) => text.includes(pattern));
}

/**
 * True when the error says the observation is already recorded on
 * chain. The caller should treat this as a completed submission.
 */
export function isAlreadySubmittedError(err: unknown): boolean {
  const text = errorText(err);
  return ALREADY_SUBMITTED_PATTERNS.some((pattern) => text.includes(pattern));
}
