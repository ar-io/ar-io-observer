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

// TX path parsing optimization metrics
export const txPathParsingCounter = new Counter({
  name: 'observer_tx_path_parsing_total',
  help: 'TX path parsing attempts and outcomes',
  labelNames: ['status'], // 'success', 'failure', 'skipped'
  registers: [register],
});

// Chunk metadata anchor (reference-gateway header shortcut) metrics
export const chunkMetadataAnchorCounter = new Counter({
  name: 'observer_chunk_metadata_anchor_total',
  help: 'Outcomes of reference-gateway chunk metadata anchoring',
  // 'hit' = anchored against chain & used
  // 'cache_hit' = reused a previously anchored tx
  // 'metadata_missing' = reference gateway returned no headers
  // 'mismatch' = header values disagreed with chain (fell back)
  // 'error' = network/other error fetching metadata or anchoring
  // 'fallback' = overall path fell back to chain search
  labelNames: ['result'],
  registers: [register],
});

// Block search iterations histogram (to compare with/without offset mapping)
export const blockSearchIterationsHistogram = new Histogram({
  name: 'observer_block_search_iterations',
  help: 'Number of iterations in block binary search',
  buckets: [5, 10, 15, 20, 25, 30],
  registers: [register],
});

// Reference gateway fallback metrics
export const referenceGatewayFallbackCounter = new Counter({
  name: 'observer_reference_gateway_fallback_total',
  help: 'Total number of reference gateway fallback events',
  labelNames: ['operation', 'host'],
  registers: [register],
});

// Continuous observation metrics
export const observationDelayHistogram = new Histogram({
  name: 'observer_observation_delay_seconds',
  help: 'Time between scheduled and actual observation',
  buckets: [0, 30, 60, 120, 300, 600, 1200],
  registers: [register],
});

export const gatewayObservationsCounter = new Counter({
  name: 'observer_gateway_observations_total',
  help: 'Total gateway observations in continuous mode',
  labelNames: ['fqdn', 'status'],
  registers: [register],
});

export const epochCoverageGauge = new Gauge({
  name: 'observer_epoch_coverage',
  help: 'Percentage of gateways with at least one observation in current epoch',
  registers: [register],
});

export const continuousObserverStateGauge = new Gauge({
  name: 'observer_continuous_state',
  help: 'Current state of continuous observer (0=waiting, 1=observing, 2=finalizing)',
  registers: [register],
});

export const windowProgressGauge = new Gauge({
  name: 'observer_window_progress',
  help: 'Progress through observation window (0-1)',
  registers: [register],
});

// Network gateway fallback metrics
export const networkFallbackCounter = new Counter({
  name: 'observer_network_fallback_total',
  help: 'Total number of network gateway fallback events',
  labelNames: ['operation', 'status'],
  registers: [register],
});

export const networkConsensusAgreementHistogram = new Histogram({
  name: 'observer_network_consensus_agreement',
  help: 'Number of gateways agreeing in consensus resolution',
  buckets: [1, 2, 3, 4, 5],
  registers: [register],
});

export const networkEligibleGatewaysGauge = new Gauge({
  name: 'observer_network_eligible_gateways',
  help: 'Number of eligible network gateways',
  registers: [register],
});
