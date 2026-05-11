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
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

import * as env from './lib/env.js';

export const args = await yargs(hideBin(process.argv))
  .option('arns-names', {
    type: 'string',
    description: 'Comma separated list of ArNS names',
  })
  .option('reference-gateway', {
    type: 'string',
    description: 'Reference gateway host',
  })
  .option('observed-gateway-hosts', {
    type: 'string',
    description: 'Comma separated list of gateways hosts to observer',
  })
  .option('save-report', {
    type: 'boolean',
    description: 'Whether or not to save the report',
  })
  .option('cu-url', {
    type: 'string',
    description:
      'AO compute unit URL (overrides AO_CU_URL / NETWORK_AO_CU_URL env for this process)',
  })
  .parse();

dotenv.config();

export const RUN_OBSERVER = env.varOrDefault('RUN_OBSERVER', 'true') === 'true';

export const ENABLE_OPENAPI_VALIDATION =
  env.varOrDefault('ENABLE_OPENAPI_VALIDATION', 'true') === 'true';

export const ARWEAVE_URL = env.varOrDefault(
  'ARWEAVE_URL',
  'https://turbo-gateway.com',
);

export const IO_PROCESS_ID = env.varOrDefault(
  'IO_PROCESS_ID',
  'qNvAoz0TgcH7DMg8BCVn8jF32QH5L6T29VjHxhHqqGE',
);

export const OBSERVER_WALLET = env.varOrDefault('OBSERVER_WALLET', '<example>');

export const WALLETS_PATH = env.varOrDefault('WALLETS_PATH', './wallets');

export const TURBO_UPLOAD_SERVICE_URL = env.varOrUndefined(
  'TURBO_UPLOAD_SERVICE_URL',
);

export const TURBO_PAYMENT_SERVICE_URL = env.varOrUndefined(
  'TURBO_PAYMENT_SERVICE_URL',
);

export const REPORT_DATA_SINK = env.varOrDefault('REPORT_DATA_SINK', 'turbo');

export const REPORT_SAVE_EPOCH_END_OFFSET_MS = Math.abs(
  +env.varOrDefault(
    'REPORT_SAVE_EPOCH_END_OFFSET_MS',
    `${1000 * 60 * 5}`, // 5 minutes
  ),
);

const DEFAULT_REFERENCE_GATEWAYS = ['turbo-gateway.com', 'ar-io.net'];

export const REFERENCE_GATEWAY_HOSTS: string[] = (() => {
  const hostsEnv = env.varOrUndefined('REFERENCE_GATEWAY_HOSTS');
  if (hostsEnv !== undefined && hostsEnv.trim().length > 0) {
    return hostsEnv
      .split(',')
      .map((h) => h.trim())
      .filter((h) => h.length > 0);
  }
  const singleHost =
    env.varOrUndefined('REFERENCE_GATEWAY_HOST') ?? args.referenceGateway;
  if (singleHost !== undefined) {
    return [singleHost];
  }
  return DEFAULT_REFERENCE_GATEWAYS;
})();

export const OBSERVED_GATEWAY_HOSTS = env
  .varOrDefault('OBSERVED_GATEWAY_HOSTS', args.observedGatewayHosts ?? '')
  .split(',')
  .filter((h) => h.length > 0);

export const ARNS_NAMES = env
  .varOrDefault('ARNS_NAMES', args.arnsNames ?? '')
  .split(',')
  .filter((h) => h.length > 0);

export const NUM_ARNS_NAMES_TO_OBSERVE_PER_GROUP = +env.varOrDefault(
  'NUM_ARNS_NAMES_TO_OBSERVE_PER_GROUP',
  '1',
);

export const PORT = +env.varOrDefault('PORT', '5050');

export const GATEWAY_ASSESSMENT_CONCURRENCY = +env.varOrDefault(
  'GATEWAY_ASSESSMENT_CONCURRENCY',
  '10',
);

export const NAME_ASSESSMENT_CONCURRENCY = +env.varOrDefault(
  'NAME_ASSESSMENT_CONCURRENCY',
  '5',
);

// Wallet used to upload reports and interact with the contract
export const KEY_FILE = path.join(WALLETS_PATH, OBSERVER_WALLET + '.json');
export const JWK = env.varOrUndefined('OBSERVER_JWK');

export const SUBMIT_CONTRACT_INTERACTIONS =
  env.varOrDefault('SUBMIT_CONTRACT_INTERACTIONS', 'false') === 'true';

export const REPORT_GENERATION_INTERVAL_MS = +env.varOrDefault(
  'REPORT_GENERATION_INTERVAL_MS',
  `${1000 * 60 * 60}`, // 1 hour
);

export const AR_IO_NODE_RELEASE = env.varOrDefault('AR_IO_NODE_RELEASE', 'dev');

// AO

/**
 * Removes trailing slashes from URLs
 * @param url The URL to sanitize
 * @returns The sanitized URL without trailing slashes or undefined if input was undefined
 */
function sanitizeUrl(url: string | undefined): string | undefined {
  if (url === undefined) {
    return undefined;
  }
  return url.replace(/\/+$/, '');
}

export const AO_MU_URL = sanitizeUrl(env.varOrUndefined('AO_MU_URL'));

const cliCuUrl = sanitizeUrl(args.cuUrl);
export const AO_CU_URL =
  cliCuUrl ?? sanitizeUrl(env.varOrUndefined('AO_CU_URL'));
export const NETWORK_AO_CU_URL =
  cliCuUrl ?? sanitizeUrl(env.varOrUndefined('NETWORK_AO_CU_URL')) ?? AO_CU_URL;
export const AO_GRAPHQL_URL = env.varOrUndefined('AO_GRAPHQL_URL');
export const AO_GATEWAY_URL = env.varOrUndefined('AO_GATEWAY_URL');

// Whether to enable the LogReportSink that logs assessment details at info level
export const ENABLE_LOG_REPORT_SINK =
  env.varOrDefault('ENABLE_LOG_REPORT_SINK', 'false') === 'true';

// Whether to always save reports regardless of other conditions
export const ALWAYS_SAVE_REPORTS =
  env.varOrDefault('ALWAYS_SAVE_REPORTS', 'false') === 'true';

// Offset observation configuration
export const OFFSET_OBSERVATION_ENABLED =
  env.varOrDefault('OFFSET_OBSERVATION_ENABLED', 'true') === 'true';

export const OFFSET_OBSERVATION_SAMPLE_RATE = Math.max(
  0.0,
  Math.min(1.0, +env.varOrDefault('OFFSET_OBSERVATION_SAMPLE_RATE', '0.20')),
);

export const OFFSET_SAMPLE_COUNT = +env.varOrDefault(
  'OFFSET_SAMPLE_COUNT',
  '4',
);

export const OFFSET_OBSERVATION_ENFORCEMENT_ENABLED =
  env.varOrDefault('OFFSET_OBSERVATION_ENFORCEMENT_ENABLED', 'true') === 'true';

// TX path parsing optimization - extracts transaction boundaries from tx_path
// without expensive binary search through transactions
export const TX_PATH_PARSING_ENABLED =
  env.varOrDefault('TX_PATH_PARSING_ENABLED', 'true') === 'true';

// Block offset mapping optimization - narrows binary search bounds using
// pre-computed offset-to-block mapping
export const BLOCK_OFFSET_MAPPING_ENABLED =
  env.varOrDefault('BLOCK_OFFSET_MAPPING_ENABLED', 'true') === 'true';

// Resolve path relative to this module (works in both src/ and dist/)
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_BLOCK_OFFSET_MAPPING_FILE = path.join(
  __dirname,
  'data',
  'offset-block-mapping.json',
);

export const BLOCK_OFFSET_MAPPING_FILE = env.varOrDefault(
  'BLOCK_OFFSET_MAPPING_FILE',
  DEFAULT_BLOCK_OFFSET_MAPPING_FILE,
);

// Continuous observation configuration
export const OBSERVATIONS_PER_GATEWAY = +env.varOrDefault(
  'OBSERVATIONS_PER_GATEWAY',
  '3',
);

export const OBSERVATION_WINDOW_FRACTION = Math.max(
  0.1,
  Math.min(0.9, +env.varOrDefault('OBSERVATION_WINDOW_FRACTION', '0.5')),
);

export const OBSERVATION_CYCLE_INTERVAL_MS = +env.varOrDefault(
  'OBSERVATION_CYCLE_INTERVAL_MS',
  `${30 * 1000}`, // 30 seconds
);

export const OBSERVATION_STABILITY_BUFFER_MS = +env.varOrDefault(
  'OBSERVATION_STABILITY_BUFFER_MS',
  `${36 * 60 * 1000}`, // 36 minutes
);

export const OBSERVATION_SUBMISSION_BUFFER_MS = +env.varOrDefault(
  'OBSERVATION_SUBMISSION_BUFFER_MS',
  `${72 * 60 * 1000}`, // 72 minutes
);

export const MAJORITY_VOTE_THRESHOLD = +env.varOrDefault(
  'MAJORITY_VOTE_THRESHOLD',
  '2', // 2 of 3 observations must pass
);

// Network gateway fallback configuration
export const REFERENCE_GATEWAY_NETWORK_ONLY =
  env.varOrDefault('REFERENCE_GATEWAY_NETWORK_ONLY', 'false') === 'true';

export const REFERENCE_GATEWAY_NETWORK_FALLBACK =
  env.varOrDefault('REFERENCE_GATEWAY_NETWORK_FALLBACK', 'true') === 'true';

export const REFERENCE_GATEWAY_CONSENSUS_SIZE = +env.varOrDefault(
  'REFERENCE_GATEWAY_CONSENSUS_SIZE',
  '3',
);

if (REFERENCE_GATEWAY_CONSENSUS_SIZE < 1) {
  throw new Error(
    `Invalid configuration: REFERENCE_GATEWAY_CONSENSUS_SIZE (${REFERENCE_GATEWAY_CONSENSUS_SIZE}) must be at least 1.`,
  );
}

export const REFERENCE_GATEWAY_CONSENSUS_THRESHOLD = +env.varOrDefault(
  'REFERENCE_GATEWAY_CONSENSUS_THRESHOLD',
  '2',
);

if (REFERENCE_GATEWAY_CONSENSUS_THRESHOLD < 1) {
  throw new Error(
    `Invalid configuration: REFERENCE_GATEWAY_CONSENSUS_THRESHOLD (${REFERENCE_GATEWAY_CONSENSUS_THRESHOLD}) must be at least 1.`,
  );
}

if (REFERENCE_GATEWAY_CONSENSUS_THRESHOLD > REFERENCE_GATEWAY_CONSENSUS_SIZE) {
  throw new Error(
    `Invalid configuration: REFERENCE_GATEWAY_CONSENSUS_THRESHOLD (${REFERENCE_GATEWAY_CONSENSUS_THRESHOLD}) ` +
      `cannot be greater than REFERENCE_GATEWAY_CONSENSUS_SIZE (${REFERENCE_GATEWAY_CONSENSUS_SIZE}).`,
  );
}

export const REFERENCE_GATEWAY_MIN_PASS_RATE = Math.max(
  0,
  Math.min(1, +env.varOrDefault('REFERENCE_GATEWAY_MIN_PASS_RATE', '0.8')),
);

export const REFERENCE_GATEWAY_MIN_CONSECUTIVE_PASSES = +env.varOrDefault(
  'REFERENCE_GATEWAY_MIN_CONSECUTIVE_PASSES',
  '2',
);

export const REFERENCE_GATEWAY_MIN_EPOCH_COUNT = +env.varOrDefault(
  'REFERENCE_GATEWAY_MIN_EPOCH_COUNT',
  '5',
);

export const REFERENCE_GATEWAY_MAX_NETWORK_POOL = +env.varOrDefault(
  'REFERENCE_GATEWAY_MAX_NETWORK_POOL',
  '10',
);

export const REFERENCE_GATEWAY_NETWORK_CACHE_TTL_SECONDS = +env.varOrDefault(
  'REFERENCE_GATEWAY_NETWORK_CACHE_TTL_SECONDS',
  `${4 * 60 * 60}`, // 4 hours
);

export const REFERENCE_GATEWAY_CONSENSUS_MAX_ATTEMPTS = +env.varOrDefault(
  'REFERENCE_GATEWAY_CONSENSUS_MAX_ATTEMPTS',
  '2', // Up to 2 rounds of fetching replacement gateways
);

//
// Solana
//

// Validation helpers for the cranker numeric env vars. Raw `parseInt` /
// `parseFloat` on a misconfigured env (`NaN`, 0, negative) silently
// breaks the pipeline at runtime — e.g. `CRANK_BATCH_SIZE=0` halts
// tally/distribute progress, `CRANK_POLL_INTERVAL_MS=NaN` collapses
// into hot-loop polling. Fail loudly at boot instead.
function parsePositiveIntEnv(name: string, defaultValue: string): number {
  const raw = env.varOrDefault(name, defaultValue);
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(
      `Invalid configuration: ${name}='${raw}' must be a positive integer.`,
    );
  }
  return value;
}
function parseNonNegativeFloatEnv(name: string, defaultValue: string): number {
  const raw = env.varOrDefault(name, defaultValue);
  const value = Number.parseFloat(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(
      `Invalid configuration: ${name}='${raw}' must be a non-negative number.`,
    );
  }
  return value;
}

// Default to 'ao' so existing AO deployments don't break on upgrade —
// operators must explicitly opt in to the Solana path.
const rawNetworkSource = env.varOrDefault('NETWORK_SOURCE', 'ao');
if (rawNetworkSource !== 'ao' && rawNetworkSource !== 'solana') {
  throw new Error(
    `Invalid configuration: NETWORK_SOURCE='${rawNetworkSource}' must be "ao" or "solana".`,
  );
}
export const NETWORK_SOURCE: 'ao' | 'solana' = rawNetworkSource;
export const SOLANA_RPC_URL = env.varOrDefault(
  'SOLANA_RPC_URL',
  'https://api.mainnet-beta.solana.com',
);
// Operator/cranker keypair. Required in solana mode. Signs join_network,
// update_gateway_settings, and every permissionless cranker ix
// (create_epoch, tally_weights, prescribe_epoch, distribute_epoch,
// close_epoch). Also serves as fallback observer/upload signer when no
// separate keys are provided.
export const SOLANA_KEYPAIR_PATH = env.varOrUndefined('SOLANA_KEYPAIR_PATH');

// Observer keypair — signs `save_observations` ix. Optional. When set,
// must match the on-chain `Gateway.observer_address` (set at join_network
// via --observer-address, or later via update_observer_address). Falls
// back to SOLANA_KEYPAIR_PATH when unset.
export const OBSERVER_KEYPAIR_PATH = env.varOrUndefined(
  'OBSERVER_KEYPAIR_PATH',
);

// Report-upload identity. Three modes, resolved in priority order:
//   1. ARWEAVE_UPLOAD_KEY_FILE (path) → load Arweave JWK from disk.
//   2. ARWEAVE_UPLOAD_JWK (inline JSON env) → load Arweave JWK from env.
//   3. SOLANA_UPLOAD_KEYPAIR_PATH (path) → ANS-104 bundle signed by a
//      Solana key (Turbo accepts Solana-signed bundles via arbundles).
//      Falls back to OBSERVER_KEYPAIR_PATH then SOLANA_KEYPAIR_PATH if
//      not explicitly set.
// When all three are unset (and we're not in legacy AO mode), report
// uploads are disabled.
export const ARWEAVE_UPLOAD_KEY_FILE = env.varOrUndefined(
  'ARWEAVE_UPLOAD_KEY_FILE',
);
export const ARWEAVE_UPLOAD_JWK = env.varOrUndefined('ARWEAVE_UPLOAD_JWK');
export const SOLANA_UPLOAD_KEYPAIR_PATH = env.varOrUndefined(
  'SOLANA_UPLOAD_KEYPAIR_PATH',
);

// Ethereum upload identity. Hex-encoded 32-byte private key, either as a
// file path or inline env. Takes precedence over the Solana fallback but
// not over Arweave (see wallet-config.ts resolveUploadIdentity for the
// full precedence + conflict rules).
export const ETHEREUM_UPLOAD_PRIVATE_KEY_FILE = env.varOrUndefined(
  'ETHEREUM_UPLOAD_PRIVATE_KEY_FILE',
);
export const ETHEREUM_UPLOAD_PRIVATE_KEY = env.varOrUndefined(
  'ETHEREUM_UPLOAD_PRIVATE_KEY',
);

// Optional program-id overrides for devnet / localnet. Undefined → SDK
// falls back to bundled mainnet IDs. Devnet values in
// devnet-config.json (ar-io/solana-ar-io monorepo).
export const ARIO_CORE_PROGRAM_ID = env.varOrUndefined('ARIO_CORE_PROGRAM_ID');
export const ARIO_GAR_PROGRAM_ID = env.varOrUndefined('ARIO_GAR_PROGRAM_ID');
export const ARIO_ARNS_PROGRAM_ID = env.varOrUndefined('ARIO_ARNS_PROGRAM_ID');
export const ARIO_ANT_PROGRAM_ID = env.varOrUndefined('ARIO_ANT_PROGRAM_ID');

// Epoch cranking (opt-in — zero overhead when disabled)
export const ENABLE_EPOCH_CRANKING =
  env.varOrDefault('ENABLE_EPOCH_CRANKING', 'false') === 'true';
export const CRANK_POLL_INTERVAL_MS = parsePositiveIntEnv(
  'CRANK_POLL_INTERVAL_MS',
  '15000',
);
export const CRANK_BATCH_SIZE = parsePositiveIntEnv('CRANK_BATCH_SIZE', '15');
export const CRANK_CLOSE_EPOCHS =
  env.varOrDefault('CRANK_CLOSE_EPOCHS', 'true') === 'true';
export const CRANK_EPOCH_RETENTION = parsePositiveIntEnv(
  'CRANK_EPOCH_RETENTION',
  '7',
);
export const CRANK_WARN_BALANCE_SOL = parseNonNegativeFloatEnv(
  'CRANK_WARN_BALANCE_SOL',
  '0.3',
);
export const CRANK_CRITICAL_BALANCE_SOL = parseNonNegativeFloatEnv(
  'CRANK_CRITICAL_BALANCE_SOL',
  '0.1',
);

// Cranker prune / cleanup pass — runs after the 6-step epoch pipeline.
// See `docs/CRANKER_PRUNING_PLAN.md` in the ar-io/solana-ar-io monorepo.
// Enable separately from the main pipeline so operators who only want
// the epoch crank (no prune) can opt out.
export const ENABLE_CLEANUP =
  env.varOrDefault('ENABLE_CLEANUP', 'true') === 'true';
export const CLEANUP_BATCH_SIZE = parsePositiveIntEnv(
  'CLEANUP_BATCH_SIZE',
  '15',
);
export const MAX_CLEANUP_TXS_PER_CYCLE = parsePositiveIntEnv(
  'MAX_CLEANUP_TXS_PER_CYCLE',
  '50',
);
export const CLEANUP_FAILURE_THRESHOLD = parsePositiveIntEnv(
  'CLEANUP_FAILURE_THRESHOLD',
  '30',
);
export const CLEANUP_MIN_INTERVAL_MS = parsePositiveIntEnv(
  'CLEANUP_MIN_INTERVAL_MS',
  '300000',
);
