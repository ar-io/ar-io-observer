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
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

import * as env from './lib/env.js';

const args = await yargs(hideBin(process.argv))
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
  .parse();

dotenv.config();

export const RUN_OBSERVER = env.varOrDefault('RUN_OBSERVER', 'true') === 'true';

export const ARWEAVE_URL = env.varOrDefault(
  'ARWEAVE_URL',
  'https://arweave.net',
);

export const CONTRACT_CACHE_URL = env.varOrDefault(
  'CONTRACT_CACHE_URL',
  'https://dev.arns.app',
);

export const CONTRACT_ID = env.varOrDefault(
  'CONTRACT_ID',
  'bLAgYxAdX2Ry-nt6aH2ixgvJXbpsEYm28NgJgyqfs-U',
);

export const OBSERVER_WALLET = env.varOrDefault('OBSERVER_WALLET', '<example>');

export const REFERENCE_GATEWAY_HOST = env.varOrDefault(
  'REFERENCE_GATEWAY_HOST',
  args.referenceGateway ?? 'arweave.dev',
);

export const OBSERVED_GATEWAY_HOSTS = env
  .varOrDefault('OBSERVED_GATEWAY_HOSTS', args.observedGatewayHosts ?? '')
  .split(',')
  .filter((h) => h.length > 0);

export const ARNS_NAMES = env
  .varOrDefault('ARNS_NAMES', args.arnsNames ?? '')
  .split(',')
  .filter((h) => h.length > 0);

export const PORT = +env.varOrDefault('PORT', '5000');

export const GATEWAY_ASSESSMENT_CONCURRENCY = +env.varOrDefault(
  'GATEWAY_ASSESSMENT_CONCURRENCY',
  '10',
);

export const NAME_ASSESSMENT_CONCURRENCY = +env.varOrDefault(
  'NAME_ASSESSMENT_CONCURRENCY',
  '5',
);

// Wallet used to upload reports and interact with the contract
export const KEY_FILE = './wallets/' + OBSERVER_WALLET + '.json';

export const SAVE_INTERACTIIONS =
  env.varOrDefault('SAVE_INTERACTIONS', 'false') === 'true';
