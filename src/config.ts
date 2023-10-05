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

import * as env from './lib/env.js';

dotenv.config();

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

export const OBSERVER_ADDRESS = env.varOrDefault(
  'OBSERVER_ADDRESS',
  '<example>',
);

export const REFERENCE_GATEWAY_HOST = env.varOrDefault(
  'REFERENCE_GATEWAY_HOST',
  'arweave.dev',
);

export const OBSERVED_GATEWAY_HOSTS = env
  .varOrDefault('OBSERVED_GATEWAY_HOSTS', 'ar-io.dev')
  .split(',');

export const ARNS_NAMES = env
  .varOrDefault('ARNS_NAMES', 'ardrive,bazar,now,pages')
  .split(',');

export const PORT = +env.varOrDefault('PORT', '3000');

export const GATEWAY_ASSESSMENT_CONCURRENCY = +env.varOrDefault(
  'GATEWAY_ASSESSMENT_CONCURRENCY',
  '10',
);

export const NAME_ASSESSMENT_CONCURRENCY = +env.varOrDefault(
  'NAME_ASSESSMENT_CONCURRENCY',
  '5',
);
