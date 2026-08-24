/**
 * Anchor error parsing and classification for epoch cranker.
 * Shared error handling logic — mirrors cranker/src/errors.ts.
 *
 * Three categories:
 * - "already_done": Step was completed by another cranker. Safe to skip.
 * - "not_ready": Preconditions not met yet. Wait and retry.
 * - "real": Unexpected failure. Needs investigation.
 *
 * Codes come from `@ar.io/solana-contracts`, which is generated from the
 * deployed `ario-gar` IDL. They are deliberately NOT written out by hand:
 * Anchor assigns each code as 6000 + the variant's index in
 * `ario-gar/src/error.rs`, so inserting a variant anywhere shifts every
 * code below it. That happened — `EpochsAlreadyEnabled` and
 * `EpochCounterAlreadyAdvanced` were added at indexes 32/33 — and the
 * previous hand-maintained table silently became a +2 shift for everything
 * from 6032 up. Because the table decides whether a failure is ignorable,
 * the drift both swallowed real errors as "already done"
 * (6041 `InvalidObservation`, 6049 `InvalidGatewayAccount`) and reported
 * benign races as real ones (`WeightsAlreadyTallied` was left unclassified).
 * Importing the generated constants makes that class of bug impossible.
 */
import {
  ARIO_GAR_ERROR__DISTRIBUTION_INCOMPLETE,
  ARIO_GAR_ERROR__EPOCHS_NOT_ENABLED,
  ARIO_GAR_ERROR__EPOCH_ALREADY_EXISTS,
  ARIO_GAR_ERROR__EPOCH_IN_PROGRESS,
  ARIO_GAR_ERROR__EPOCH_NOT_CLOSEABLE,
  ARIO_GAR_ERROR__EPOCH_NOT_STARTED,
  ARIO_GAR_ERROR__LEAVE_WINDOW_NOT_EXPIRED,
  ARIO_GAR_ERROR__PRESCRIPTIONS_ALREADY_DONE,
  ARIO_GAR_ERROR__PRESCRIPTIONS_NOT_DONE,
  ARIO_GAR_ERROR__REWARDS_ALREADY_DISTRIBUTED,
  ARIO_GAR_ERROR__WEIGHTS_ALREADY_TALLIED,
  ARIO_GAR_ERROR__WEIGHTS_NOT_TALLIED,
} from '@ar.io/solana-contracts/gar';

export type ErrorCategory = 'already_done' | 'not_ready' | 'real';

const ALREADY_DONE_ERRORS = new Set<number>([
  // AlreadyInitialized (Anchor built-in) — epoch account already exists
  0,
  // Anchor framework account-error codes that all map to the same
  // semantic for the cranker's `close_observation` cleanup loop: the
  // candidate Observation PDA address doesn't currently hold an
  // Observation account, so there's nothing to close. The loop walks
  // every registry observer; misses are expected.
  //
  //   3007 = AccountOwnedByWrongProgram. When the (epoch_index, observer)
  //          PDA address has never been initialized, it's owned by the
  //          System Program (`11111...`), not ario-gar. Anchor's
  //          `Account<Observation>` check raises this. **This is what
  //          devnet produces in practice** (confirmed via
  //          `custom program error: 0xbbf` in failed simulations).
  //   3012 = AccountNotInitialized. Defensive: a slightly different
  //          path where the account exists but has zero data could
  //          surface this. Semantically equivalent to "nothing to
  //          close."
  3007,
  3012,
  ARIO_GAR_ERROR__REWARDS_ALREADY_DISTRIBUTED,
  ARIO_GAR_ERROR__EPOCH_ALREADY_EXISTS,
  ARIO_GAR_ERROR__WEIGHTS_ALREADY_TALLIED,
  ARIO_GAR_ERROR__PRESCRIPTIONS_ALREADY_DONE,
]);

const NOT_READY_ERRORS = new Set<number>([
  ARIO_GAR_ERROR__EPOCHS_NOT_ENABLED,
  ARIO_GAR_ERROR__EPOCH_NOT_STARTED,
  ARIO_GAR_ERROR__EPOCH_IN_PROGRESS,
  ARIO_GAR_ERROR__DISTRIBUTION_INCOMPLETE,
  ARIO_GAR_ERROR__WEIGHTS_NOT_TALLIED,
  ARIO_GAR_ERROR__PRESCRIPTIONS_NOT_DONE,
  ARIO_GAR_ERROR__EPOCH_NOT_CLOSEABLE,
  // LeaveWindowNotExpired — a Leaving gateway whose leave window
  // hasn't elapsed yet can't be finalize_gone'd. `getGoneGateways()` returns
  // every Leaving gateway (not just expired ones), so the cleanup pass attempts
  // them and they revert with this until their window passes — a wait-and-retry
  // condition, NOT a real error (must not spam error logs or trip unhealthy via
  // consecutiveRealErrors).
  ARIO_GAR_ERROR__LEAVE_WINDOW_NOT_EXPIRED,
]);

/**
 * Walk the `cause` chain on a thrown error and concatenate every
 * message + every `context.logs[]` (kit packs the program logs there)
 * so the regex extractors below can find the Anchor code.
 *
 * The SDK's `sendAndConfirm` throws a `SolanaError` whose top-level
 * `message` is just `"Transaction simulation failed"`. The actual
 * `custom program error: 0xNNN` line and the `Error Number: NNNN`
 * AnchorError text live one or two levels down in `cause.context.logs`
 * and `cause.message`. Reading only the top-level message misses
 * everything useful.
 */
function collectErrorText(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (
    let depth = 0;
    current !== undefined && current !== null && depth < 10;
    depth++
  ) {
    if (typeof current === 'string') {
      parts.push(current);
      break;
    }
    if (current instanceof Error || typeof current === 'object') {
      const e = current as {
        message?: string;
        context?: { logs?: string[]; err?: unknown };
        cause?: unknown;
      };
      if (e.message !== undefined && e.message !== '') parts.push(e.message);
      if (Array.isArray(e.context?.logs)) parts.push(e.context.logs.join('\n'));
      if (e.context?.err && typeof e.context.err === 'object') {
        // kit packs `{ InstructionError: [idx, {Custom: N}] }` here
        try {
          parts.push(JSON.stringify(e.context.err));
        } catch {
          /* ignore circular */
        }
      }
      current = e.cause;
    } else {
      break;
    }
  }
  return parts.join('\n');
}

export function parseAnchorErrorCode(error: unknown): number | null {
  const msg = collectErrorText(error);
  const match = msg.match(/Error Number: (\d+)/);
  if (match) return parseInt(match[1]);
  const hexMatch = msg.match(/custom program error: 0x([0-9a-fA-F]+)/);
  if (hexMatch) return parseInt(hexMatch[1], 16);
  // kit's structured `InstructionError: [idx, {Custom: NNNN}]` form
  // (decimal, JSON-stringified from the `context.err` field).
  const customMatch = msg.match(/"Custom":\s*(\d+)/);
  if (customMatch) return parseInt(customMatch[1]);
  if (msg.includes('already in use')) return 0;
  return null;
}

export function classifyError(error: unknown): ErrorCategory {
  const code = parseAnchorErrorCode(error);
  if (code !== null) {
    if (ALREADY_DONE_ERRORS.has(code)) return 'already_done';
    if (NOT_READY_ERRORS.has(code)) return 'not_ready';
  }

  // RPC-level dedup: Solana returns this when another signer has already
  // submitted an identical tx (multiple crankers racing). Safe to ignore.
  // Walk the cause chain so we catch it whether it's at the top-level
  // message or nested inside a `SolanaError`.
  const msg = collectErrorText(error);
  if (
    msg.includes('already been processed') ||
    msg.includes('AlreadyProcessed')
  ) {
    return 'already_done';
  }

  // Transient RPC errors — treat as not_ready so we don't spam error logs
  if (
    msg.includes('BlockhashNotFound') ||
    msg.includes('blockhash not found') ||
    msg.includes('block height exceeded') ||
    msg.includes('fetch failed') ||
    msg.includes('Connection terminated') ||
    msg.includes('ECONNRESET') ||
    msg.includes('ETIMEDOUT') ||
    // RPC provider rate-limit responses. QuickNode / Helius / Triton
    // return HTTP 429 with a `Too Many Requests` body when the
    // per-second or per-month quota is hit. Cranker + observer cycles
    // burst at epoch boundaries (cleanup + tally + distribute fire
    // together) and routinely trip free-tier limits. Categorising as
    // transient avoids `error:` spam; the cleanup loop will retry on
    // the next cycle.
    msg.includes('HTTP error (429)') ||
    msg.includes('Too Many Requests') ||
    msg.includes('rate limit') ||
    msg.includes('rate-limited')
  ) {
    return 'not_ready';
  }

  return 'real';
}
