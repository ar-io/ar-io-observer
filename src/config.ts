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

export const OBSERVER_ADDRESS = env.varOrDefault(
  'OBSERVER_ADDRESS',
  '<example>',
);
export const OBSERVED_GATEWAY_HOSTS = env
  .varOrDefault('OBSERVED_GATEWAY_HOSTS', 'ar-io.dev')
  .split(',');
export const REFERENCE_GATEWAY_HOST = env.varOrDefault(
  'REFERENCE_GATEWAY_HOST',
  'arweave.dev',
);

export const PRESCRIBED_NAMES = env
  .varOrDefault('PRESCRIBED_NAMES', 'now,ardrive')
  .split(',');
export const CHOSEN_NAMES = env
  .varOrDefault('CHOSEN_NAMES', 'pages,bazar')
  .split(',');

export const PORT = +env.varOrDefault('PORT', '3000');
