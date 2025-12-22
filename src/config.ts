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
  .parse();

dotenv.config();

export const RUN_OBSERVER = env.varOrDefault('RUN_OBSERVER', 'true') === 'true';

export const ENABLE_OPENAPI_VALIDATION =
  env.varOrDefault('ENABLE_OPENAPI_VALIDATION', 'true') === 'true';

export const ARWEAVE_URL = env.varOrDefault(
  'ARWEAVE_URL',
  'https://arweave.net',
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

export const REFERENCE_GATEWAY_HOST = env.varOrDefault(
  'REFERENCE_GATEWAY_HOST',
  args.referenceGateway ?? 'ar-io.net',
);

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
export const AO_CU_URL = sanitizeUrl(env.varOrUndefined('AO_CU_URL'));
export const NETWORK_AO_CU_URL =
  sanitizeUrl(env.varOrUndefined('NETWORK_AO_CU_URL')) ?? AO_CU_URL;
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
  Math.min(1.0, +env.varOrDefault('OFFSET_OBSERVATION_SAMPLE_RATE', '0.10')),
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
