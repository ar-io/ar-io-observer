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
import express from 'express';
import * as OpenApiValidator from 'express-openapi-validator';
import fs from 'node:fs';
import swaggerUi from 'swagger-ui-express';
import YAML from 'yaml';

import { ChainSource } from './arweave.js';
import * as config from './config.js';
import { CachedEntropySource } from './entropy/cached-entropy-source.js';
import { ChainEntropySource } from './entropy/chain-entropy-source.js';
import { CompositeEntropySource } from './entropy/composite-entropy-source.js';
import { RandomEntropySource } from './entropy/random-entropy-source.js';
import { RemoteCacheHostList } from './hosts/remote-cache-host-list.js';
import { RandomArnsNamesSource } from './names/random-arns-names-source.js';
import { RemoteCacheArnsNameList } from './names/remote-cache-arns-name-list.js';
import { StaticArnsNameList } from './names/static-arns-name-list.js';
import { Observer } from './observer.js';
import { EpochHeightSource } from './protocol.js';

// HTTP server
const app = express();

// OpenAPI spec
const openapiDocument = YAML.parse(
  fs.readFileSync('docs/openapi.yaml', 'utf8'),
);
app.get('/openapi.json', (_req, res) => {
  res.json(openapiDocument);
});

// Swagger UI
app.use(
  '/api-docs',
  swaggerUi.serve,
  swaggerUi.setup(openapiDocument, {
    explorer: true,
  }),
);

app.use(
  OpenApiValidator.middleware({
    apiSpec: './docs/openapi.yaml',
    validateRequests: true, // (default)
    validateResponses: true, // false by default
  }),
);

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
const nameList = new RemoteCacheArnsNameList({
  baseCacheUrl: 'https://dev.arns.app',
  contractId: 'bLAgYxAdX2Ry-nt6aH2ixgvJXbpsEYm28NgJgyqfs-U',
});

const chainEntropySource = new ChainEntropySource({
  arweaveBaseUrl: 'https://arweave.net',
  heightSource: epochHeightSelector,
});

const prescribedNamesSource = new RandomArnsNamesSource({
  nameList,
  entropySource: chainEntropySource,
  numNamesToSource: 1,
  heightSource: epochHeightSelector,
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
  nameList,
  entropySource: compositeEntropySource,
  numNamesToSource: 1,
  heightSource: epochHeightSelector,
});

const observer = new Observer({
  observerAddress: config.OBSERVER_ADDRESS,
  referenceGatewayHost: config.REFERENCE_GATEWAY_HOST,
  observedGatewayHostList,
  prescribedNamesSource,
  chosenNamesSource,
  gatewayAssessmentConcurrency: config.GATEWAY_ASSESSMENT_CONCURRENCY,
  nameAssessmentConcurrency: config.NAME_ASSESSMENT_CONCURRENCY,
});

app.get('/reports/current', async (_req, res) => {
  try {
    res.json(await observer.generateReport());
  } catch (error: any) {
    res.status(500).send(error?.message);
  }
});

app.listen(config.PORT, () => {
  console.log(`Listening on port ${config.PORT}`);
});
