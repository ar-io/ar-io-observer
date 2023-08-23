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
import fs from 'node:fs';
import swaggerUi from 'swagger-ui-express';
import YAML from 'yaml';

import { Observer, StaticArnsNamesSource } from './report.js';

// HTTP server
const app = express();

// OpenAPI Spec
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

// TODO retrieve names from config (environment variables)
const prescribedNamesSource = new StaticArnsNamesSource(['now']);
const chosenNamesSource = new StaticArnsNamesSource(['ardrive']);

const observer = new Observer({
  observerAddress: '<example>',
  prescribedNamesSource,
  chosenNamesSource,
  gatewayHosts: ['arweave.dev'],
  referenceGatewayHost: 'arweave.dev',
});

app.get('/report/current', async (_req, res) => {
  try {
    res.json(await observer.generateReport());
  } catch (error: any) {
    res.status(500).send(error?.message);
  }
});

// TODO get port from config (environment variables)
app.listen(3000, () => {
  console.log('Listening on port 3000');
});
