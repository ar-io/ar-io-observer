/**
 * AR.IO Observer Prometheus Metrics
 *
 * This module defines and exports all Prometheus metrics for tracking
 * observation success/failure rates and system performance.
 */
import { Counter, Gauge, Histogram, Registry } from 'prom-client';

import * as config from './config.js';

export const register = new Registry();

// Set global labels for all metrics
register.setDefaultLabels({
  release: config.AR_IO_NODE_RELEASE,
});

// Counter metrics for tracking assessment totals
export const ownershipAssessmentsCounter = new Counter({
  name: 'observer_ownership_assessments_total',
  help: 'Total ownership assessments performed',
  labelNames: ['status', 'enforced'],
  registers: [register],
});

export const arnsAssessmentsCounter = new Counter({
  name: 'observer_arns_assessments_total',
  help: 'Total ArNS name assessments performed',
  labelNames: ['type', 'status', 'enforced'],
  registers: [register],
});

export const offsetAssessmentsCounter = new Counter({
  name: 'observer_offset_assessments_total',
  help: 'Total offset assessments performed',
  labelNames: ['status', 'enforced'],
  registers: [register],
});

export const gatewayAssessmentsCounter = new Counter({
  name: 'observer_gateway_assessments_total',
  help: 'Total gateway assessments performed',
  labelNames: ['status'],
  registers: [register],
});

export const reportsGeneratedCounter = new Counter({
  name: 'observer_reports_generated_total',
  help: 'Total reports generated',
  labelNames: ['status'],
  registers: [register],
});

// Gauge metrics for current state
export const lastReportFailureRateGauge = new Gauge({
  name: 'observer_last_report_failure_rate',
  help: 'Overall failure rate from the last generated report',
  registers: [register],
});

export const lastReportGatewayCountGauge = new Gauge({
  name: 'observer_last_report_gateway_count',
  help: 'Number of gateways assessed in the last report',
  registers: [register],
});

export const lastReportTimestampGauge = new Gauge({
  name: 'observer_last_report_timestamp',
  help: 'Unix timestamp of the last generated report',
  registers: [register],
});

// Histogram metrics for tracking durations
export const reportGenerationHistogram = new Histogram({
  name: 'observer_report_generation_duration_seconds',
  help: 'Time taken to generate observation reports',
  buckets: [600, 900, 1200, 1800, 2400, 3000, 3600, 5400, 7200],
  registers: [register],
});

export const arnsResolutionHistogram = new Histogram({
  name: 'observer_arns_resolution_duration_seconds',
  help: 'Time taken for individual ArNS resolutions',
  buckets: [1, 2, 5, 10, 20, 30],
  registers: [register],
});

export const offsetValidationHistogram = new Histogram({
  name: 'observer_offset_validation_duration_seconds',
  help: 'Time taken for individual offset validations',
  buckets: [1, 2, 4, 8, 15, 30],
  registers: [register],
});
