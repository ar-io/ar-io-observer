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
import { ReadThroughPromiseCache } from '@ardrive/ardrive-promise-cache';
import express from 'express';
import * as OpenApiValidator from 'express-openapi-validator';
import fs from 'node:fs';
import swaggerUi from 'swagger-ui-express';
import YAML from 'yaml';

import { observer } from './system.js';
import { ObserverReport } from './types.js';

// HTTP server
export const app = express();

// Redirect root to report
app.get('/', (_req, res) => {
  res.redirect('/ar-io/observer/reports/current');
});

// OpenAPI spec
const openapiDocument = YAML.parse(
  fs.readFileSync('docs/openapi.yaml', 'utf8'),
);
app.get(['/openapi.json', '/ar-io/observer/openapi.json'], (_req, res) => {
  res.json(openapiDocument);
});

// Swagger UI
app.use(
  ['/api-docs', '/ar-io/observer/api-docs'],
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

app.get('/ar-io/observer/healthcheck', async (_req, res) => {
  const data = {
    uptime: process.uptime(),
    date: new Date(),
    message: 'Welcome to the Permaweb.',
  };

  res.status(200).send(data);
});

const reportCache = new ReadThroughPromiseCache<string, ObserverReport>({
  cacheParams: {
    cacheCapacity: 1,
    cacheTTL: 1000 * 60 * 60, // 1 hour
  },
  readThroughFunction: async (_: string): Promise<ObserverReport> => {
    return observer.generateReport();
  },
});

app.get('/ar-io/observer/reports/current', async (_req, res) => {
  try {
    res.json(await reportCache.get('current'));
  } catch (error: any) {
    res.status(500).send(error?.message);
  }
});
