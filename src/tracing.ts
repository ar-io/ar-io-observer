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
import { SeverityNumber } from '@opentelemetry/api-logs';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { WinstonInstrumentation } from '@opentelemetry/instrumentation-winston';
import opentelemetry from '@opentelemetry/sdk-node';
import { NodeSDK } from '@opentelemetry/sdk-node';
import dotenv from 'dotenv';
import fs from 'node:fs';
import * as env from './lib/env.js';

dotenv.config();

// NOTE: These are declared here instead of config.ts because tracing needs to
// be setup before logging and we may start logging in config.ts in the future.
const OTEL_BATCH_LOG_PROCESSOR_SCHEDULED_DELAY_MS = +env.varOrDefault(
  'OTEL_BATCH_LOG_PROCESSOR_SCHEDULED_DELAY_MS',
  '2000', // 2 seconds
);
const OTEL_BATCH_LOG_PROCESSOR_MAX_EXPORT_BATCH_SIZE = +env.varOrDefault(
  'OTEL_BATCH_LOG_PROCESSOR_MAX_EXPORT_BATCH_SIZE',
  '10000',
);

const headersFile = process.env.OTEL_EXPORTER_OTLP_HEADERS_FILE;
if (headersFile !== undefined && headersFile !== '') {
  process.env.OTEL_EXPORTER_OTLP_HEADERS = fs
    .readFileSync(headersFile)
    .toString('utf-8');
}

const sdk: NodeSDK = new NodeSDK({
  traceExporter: new OTLPTraceExporter(),
  logRecordProcessor: new opentelemetry.logs.BatchLogRecordProcessor(
    new OTLPLogExporter(),
    {
      scheduledDelayMillis: OTEL_BATCH_LOG_PROCESSOR_SCHEDULED_DELAY_MS,
      maxExportBatchSize: OTEL_BATCH_LOG_PROCESSOR_MAX_EXPORT_BATCH_SIZE,
    },
  ),
  instrumentations: [
    getNodeAutoInstrumentations({
      // Disable fs automatic instrumentation because it can be noisy and
      // expensive during startup (recommended by Honeycomb)
      '@opentelemetry/instrumentation-fs': {
        enabled: false,
      },
    }),
    new WinstonInstrumentation({
      logSeverity: SeverityNumber.INFO,
    }),
  ],
});

if (
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT !== undefined &&
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT !== ''
) {
  sdk.start();
}
