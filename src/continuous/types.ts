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

import {
  GatewayArnsAssessments,
  GatewayOffsetAssessments,
  OwnershipAssessment,
} from '../types.js';

/**
 * Individual gateway observation result (single assessment)
 */
export interface GatewayObservationResult {
  fqdn: string;
  observedAt: number; // timestamp ms
  scheduledAt: number; // original scheduled time
  ownershipAssessment: OwnershipAssessment;
  arnsAssessments: GatewayArnsAssessments;
  offsetAssessments?: GatewayOffsetAssessments;
  pass: boolean;
}

/**
 * Aggregated observations for a gateway within an epoch
 */
export interface GatewayObservationAggregate {
  fqdn: string;
  wallet: string;
  observations: GatewayObservationResult[];
}

/**
 * Scheduled observation event persisted for catch-up and restart recovery.
 */
export interface ScheduledObservation {
  id: string;
  fqdn: string;
  scheduledAt: number;
}

/**
 * Complete observation state for an epoch (persisted)
 */
export interface ObservationState {
  epochIndex: number;
  epochStartTimestamp: number;
  epochEndTimestamp: number;
  epochStartHeight: number;
  windowStart: number;
  windowEnd: number;
  // Scheduled observation events pending completion
  pendingObservations: ScheduledObservation[];
  // Completed observations per gateway (key = fqdn)
  gatewayObservations: Map<string, GatewayObservationAggregate>;
  // Gateway to wallet mapping
  gatewayWallets: Map<string, string[]>;
  // Gateways selected for offset assessment
  offsetAssessmentGateways: Set<string>;
  // For restart recovery: last cycle timestamp
  lastCycleTimestamp: number;
  // Whether report has been submitted for this epoch
  reportSubmitted: boolean;
}

/**
 * Serializable version of ObservationState for JSON persistence
 */
export interface SerializedObservationState {
  epochIndex: number;
  epochStartTimestamp: number;
  epochEndTimestamp: number;
  epochStartHeight: number;
  windowStart: number;
  windowEnd: number;
  pendingObservations: ScheduledObservation[] | [string, number[]][];
  gatewayObservations: [string, GatewayObservationAggregate][];
  gatewayWallets: [string, string[]][];
  offsetAssessmentGateways: string[];
  lastCycleTimestamp: number;
  reportSubmitted: boolean;
}

/**
 * Scheduler configuration
 */
export interface SchedulerConfig {
  observationsPerGateway: number; // default: 3
  windowFraction: number; // default: 0.5 (50% of epoch)
  stabilityBufferMs: number; // default: 36 * 60 * 1000
  submissionBufferMs: number; // default: 72 * 60 * 1000
}

/**
 * Continuous observer configuration
 */
export interface ContinuousObserverConfig {
  cycleIntervalMs: number; // default: 30000 (30 seconds)
  gatewayAssessmentConcurrency: number; // default: 3 (down from 10)
  observationsPerGateway: number; // default: 3
  majorityThreshold: number; // default: 2 (2 of 3 must pass)
}
