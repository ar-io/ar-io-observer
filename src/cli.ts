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
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

import { Observer, StaticArnsNamesSource } from './report.js';

const args = await yargs(hideBin(process.argv))
  .option('prescribed-names', {
    type: 'string',
    description: 'Comma separated list of prescribed names',
  })
  .option('chosen-names', {
    type: 'string',
    description: 'Comma separated list of chosen names',
  })
  .option('gateway-hosts', {
    type: 'string',
    description: 'Comma separated list of gateway hosts',
  })
  .option('reference-gateway', {
    type: 'string',
    description: 'Reference gateway host',
  })
  .parse();

const prescribedNames = (
  typeof args.prescribedNames === 'string' ? args.prescribedNames : 'now'
).split(',');

const chosenNames = (
  typeof args.chosenNames === 'string' ? args.chosenNames : 'ardrive'
).split(',');

const gatewayHosts = (
  typeof args.gatewayHosts === 'string' ? args.gatewayHosts : 'arweave.dev'
).split(',');

const prescribedNamesSource = new StaticArnsNamesSource(prescribedNames);
const chosenNamesSource = new StaticArnsNamesSource(chosenNames);

const observer = new Observer({
  observerAddress: '<example>',
  prescribedNamesSource,
  chosenNamesSource,
  gatewayHosts,
  referenceGatewayHost: args.referenceGateway ?? 'arweave.dev',
});

observer.generateReport().then((report) => {
  console.log(JSON.stringify(report, null, 2));
});
