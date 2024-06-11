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
import cors from 'cors';
import express from 'express';
import * as OpenApiValidator from 'express-openapi-validator';
import fs from 'node:fs';
import swaggerUi from 'swagger-ui-express';
import YAML from 'yaml';

import * as config from './config.js';
import { reportCache, walletAddress } from './system.js';

// HTTP server
export const app = express();

// CORS
app.use(
  cors({
    origin: '*',
    methods: ['GET'],
  }),
);

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

if (config.ENABLE_OPENAPI_VALIDATION) {
  app.use(
    OpenApiValidator.middleware({
      apiSpec: './docs/openapi.yaml',
      validateRequests: true, // (default)
      validateResponses: true, // false by default
    }),
  );
}

app.get('/ar-io/observer/healthcheck', async (_req, res) => {
  const data = {
    uptime: process.uptime(),
    date: new Date(),
    message: 'Welcome to the Permaweb.',
  };

  res.status(200).send(data);
});

app.get('/ar-io/observer/info', (_req, res) => {
  res.status(200).send({
    wallet: walletAddress,
    processId: config.IO_PROCESS_ID,
  });
});

app.get('/ar-io/observer/reports/current', async (_req, res) => {
  try {
    const report = await reportCache.get('current');
    if (report === undefined) {
      // respond with 202 when report is still being generated
      res.status(202).json({ message: 'Report pending' });
    } else {
      res.json(report);
    }
  } catch (error: any) {
    res.status(500).send(error?.message);
  }
});
