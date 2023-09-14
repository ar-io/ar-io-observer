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

import { ChainSource } from './arweave.js';
import * as config from './config.js';
import { CachedEntropySource } from './entropy/cached-entropy-source.js';
import { ChainEntropySource } from './entropy/chain-entropy-source.js';
import { CompositeEntropySource } from './entropy/composite-entropy-source.js';
import { RandomEntropySource } from './entropy/random-entropy-source.js';
import { RemoteCacheHostList } from './hosts/remote-cache-host-list.js';
import { RandomArnsNamesSource } from './names/random-arns-names-source.js';
import { RemoteCacheArnsNameList } from './names/remote-cache-arns-name-list.js';
//import { StaticArnsNameList } from './names/static-arns-name-list.js';
import { Observer } from './observer.js';
import { EpochHeightSource } from './protocol.js';

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

const arnsNames =
  typeof args.arnsNames === 'string'
    ? args.arnsNames.split(',')
    : config.ARNS_NAMES;

const observedGatewayHosts =
  typeof args.observedGatewayHosts === 'string'
    ? args.observedGatewayHosts.split(',')
    : config.OBSERVED_GATEWAY_HOSTS;

// TODO remove hard coded values
const observedGatewayHostList = new RemoteCacheHostList({
  baseCacheUrl: 'https://dev.arns.app',
  contractId: 'bLAgYxAdX2Ry-nt6aH2ixgvJXbpsEYm28NgJgyqfs-U',
});

const chainSource = new ChainSource({
  arweaveBaseUrl: 'https://arweave.net',
});

const epochHeightSelector = new EpochHeightSource({
  heightSource: chainSource,
});

// TODO remove hard coded values
const remoteCacheArnsNameList = new RemoteCacheArnsNameList({
  baseCacheUrl: 'https://dev.arns.app',
  contractId: 'bLAgYxAdX2Ry-nt6aH2ixgvJXbpsEYm28NgJgyqfs-U',
});

const chainEntropySource = new ChainEntropySource({
  arweaveBaseUrl: 'https://arweave.net',
  heightSource: epochHeightSelector,
});

const prescribedNamesSource = new RandomArnsNamesSource({
  nameList: remoteCacheArnsNameList,
  entropySource: chainEntropySource,
  numNamesToSource: 1,
});

const randomEntropySource = new RandomEntropySource();

const cachedEntropySource = new CachedEntropySource({
  entropySource: randomEntropySource,
  cachePath: './tmp/entropy',
});

const compositeEntropySource = new CompositeEntropySource({
  sources: [cachedEntropySource, chainEntropySource],
});

const chosenNamesSource = new RandomArnsNamesSource({
  nameList: remoteCacheArnsNameList,
  entropySource: compositeEntropySource,
  numNamesToSource: 1,
});

const observer = new Observer({
  observerAddress: config.OBSERVER_ADDRESS,
  referenceGatewayHost: args.referenceGateway ?? config.REFERENCE_GATEWAY_HOST,
  observedGatewayHostList,
  prescribedNamesSource,
  chosenNamesSource,
});

observer.generateReport().then((report) => {
  console.log(JSON.stringify(report, null, 2));
});
