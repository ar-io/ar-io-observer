/**
 * Anchor error parsing and classification for epoch cranker.
 * Shared error handling logic — mirrors cranker/src/errors.ts.
 *
 * Three categories:
 * - "already_done": Step was completed by another cranker. Safe to skip.
 * - "not_ready": Preconditions not met yet. Wait and retry.
 * - "real": Unexpected failure. Needs investigation.
 *
 * IMPORTANT: Anchor assigns error codes as 6000 + variant-index in the
 * enum declared at `contracts/programs/ario-gar/src/error.rs`. Keep this
 * table in sync when new variants are added or reordered.
 */

export type ErrorCategory = 'already_done' | 'not_ready' | 'real';

// GarError variant indexes (verified against ario-gar/src/error.rs).
// Anchor codes = 6000 + index.
const ALREADY_DONE_ERRORS = new Set<number>([
  // AlreadyInitialized (Anchor built-in) — epoch account already exists
  0,
  // AccountNotInitialized (Anchor framework, code 3012). For
  // `close_observation`, this fires when the Observation PDA doesn't
  // exist because the prescribed observer never submitted. The
  // cranker's cleanup loop walks every registry observer; misses are
  // expected. Treat as `already_done` (semantically: nothing to close
  // means already in the desired state) so the loop keeps moving
  // without polluting logs at error level.
  3012,
  // RewardsAlreadyDistributed (variant 37)
  6037,
  // EpochAlreadyExists (variant 41)
  6041,
  // WeightsAlreadyTallied (variant 45)
  6045,
  // PrescriptionsAlreadyDone (variant 49)
  6049,
]);

const NOT_READY_ERRORS = new Set<number>([
  // EpochsNotEnabled (variant 31)
  6031,
  // EpochNotStarted (variant 32)
  6032,
  // EpochInProgress (variant 34)
  6034,
  // DistributionIncomplete (variant 38)
  6038,
  // WeightsNotTallied (variant 46)
  6046,
  // PrescriptionsNotDone (variant 48)
  6048,
  // EpochNotCloseable (variant 51)
  6051,
]);

export function parseAnchorErrorCode(error: unknown): number | null {
  const msg = error instanceof Error ? error.message : String(error);
  const match = msg.match(/Error Number: (\d+)/);
  if (match) return parseInt(match[1]);
  const hexMatch = msg.match(/custom program error: 0x([0-9a-fA-F]+)/);
  if (hexMatch) return parseInt(hexMatch[1], 16);
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
  const msg = error instanceof Error ? error.message : String(error);
  if (msg.includes('already been processed') || msg.includes('AlreadyProcessed')) {
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
    msg.includes('ETIMEDOUT')
  ) {
    return 'not_ready';
  }

  return 'real';
}
