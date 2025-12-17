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
import got, { Got } from 'got';
import pMap from 'p-map';
import { Logger } from 'winston';

import * as metrics from '../metrics.js';
import { assessOwnership, getArnsResolution } from '../observer.js';
import {
  ArnsNameAssessment,
  ArnsNameAssessments,
  GatewayArnsAssessments,
  OwnershipAssessment,
} from '../types.js';

// 5 minute TTL for reference resolution cache
const REFERENCE_RESOLUTION_CACHE_TTL_MS = 5 * 60 * 1000;

// Threshold for ArNS name pass rate
const NAME_PASS_THRESHOLD = 0.8;

interface ArnsResolution {
  statusCode: number;
  resolvedId: string | null;
  ttlSeconds: string | null;
  contentLength: string | null;
  contentType: string | null;
  dataHashDigest: string | null;
  timings: any;
}

/**
 * GatewayAssessor encapsulates the logic for assessing individual gateways.
 *
 * It handles ownership verification, ArNS name resolution comparison,
 * and maintains a reference resolution cache for the epoch.
 */
export class GatewayAssessor {
  private readonly referenceGatewayHost: string;
  private readonly nodeReleaseVersion: string;
  private readonly nameAssessmentConcurrency: number;
  private readonly log: Logger;
  private readonly gotClient: Got;

  private referenceResolutionCache?: ReadThroughPromiseCache<
    string,
    ArnsResolution
  >;
  private currentEntropy?: Buffer;

  constructor({
    referenceGatewayHost,
    nodeReleaseVersion,
    nameAssessmentConcurrency,
    log,
  }: {
    referenceGatewayHost: string;
    nodeReleaseVersion: string;
    nameAssessmentConcurrency: number;
    log: Logger;
  }) {
    this.referenceGatewayHost = referenceGatewayHost;
    this.nodeReleaseVersion = nodeReleaseVersion;
    this.nameAssessmentConcurrency = nameAssessmentConcurrency;
    this.log = log.child({ class: 'GatewayAssessor' });

    this.gotClient = got.extend({
      headers: { 'X-AR-IO-Node-Release': this.nodeReleaseVersion },
      timeout: {
        lookup: 5000,
        connect: 5000,
        secureConnect: 2000,
        socket: 7000,
      },
    });
  }

  /**
   * Initialize the assessor for a new epoch.
   *
   * Creates a fresh reference resolution cache and stores entropy for
   * deterministic operations within the epoch.
   */
  initializeForEpoch({
    entropy,
    namesCount,
  }: {
    entropy: Buffer;
    namesCount: number;
  }): void {
    this.currentEntropy = entropy;

    // Create reference resolution cache for this epoch
    this.referenceResolutionCache = new ReadThroughPromiseCache<
      string,
      ArnsResolution
    >({
      cacheParams: {
        cacheCapacity: Math.max(namesCount, 100),
        cacheTTL: REFERENCE_RESOLUTION_CACHE_TTL_MS,
      },
      readThroughFunction: async (arnsName: string) => {
        return getArnsResolution({
          url: `https://${arnsName}.${this.referenceGatewayHost}/`,
          got: this.gotClient,
          entropy: this.currentEntropy!,
        });
      },
    });

    this.log.debug('GatewayAssessor initialized for epoch', {
      namesCount,
      entropyLength: entropy.length,
    });
  }

  /**
   * Clear the reference resolution cache and epoch state.
   */
  clearEpochState(): void {
    this.referenceResolutionCache = undefined;
    this.currentEntropy = undefined;
  }

  /**
   * Assess gateway ownership by checking the /ar-io/info endpoint.
   */
  async assessOwnership({
    host,
    expectedWallets,
  }: {
    host: string;
    expectedWallets: string[];
  }): Promise<OwnershipAssessment> {
    return assessOwnership({ host, expectedWallets });
  }

  /**
   * Assess a single ArNS name resolution against the reference gateway.
   */
  async assessArnsName({
    host,
    arnsName,
  }: {
    host: string;
    arnsName: string;
  }): Promise<ArnsNameAssessment> {
    if (this.referenceResolutionCache === undefined) {
      throw new Error('GatewayAssessor not initialized for epoch');
    }
    if (this.currentEntropy === undefined) {
      throw new Error('Entropy not set for epoch');
    }

    const referenceResolution =
      await this.referenceResolutionCache.get(arnsName);

    const arnsResolutionTimer = metrics.arnsResolutionHistogram.startTimer();
    const gatewayResolution = await getArnsResolution({
      url: `https://${arnsName}.${host}/`,
      got: this.gotClient,
      referenceGatewayContentLength: referenceResolution.contentLength,
      entropy: this.currentEntropy,
    });
    arnsResolutionTimer();

    let pass = true;
    let failureReason: string | undefined = undefined;

    const checkedProperties: Array<keyof ArnsResolution> = [
      'resolvedId',
      'ttlSeconds',
      'contentType',
      'dataHashDigest',
    ];
    for (const property of checkedProperties) {
      if (referenceResolution[property] !== gatewayResolution[property]) {
        pass = false;
        failureReason =
          (failureReason !== undefined ? failureReason + ', ' : '') +
          `${property} mismatch`;
      }
    }

    return {
      assessedAt: +(Date.now() / 1000).toFixed(0),
      expectedStatusCode: referenceResolution.statusCode,
      resolvedStatusCode: gatewayResolution.statusCode,
      expectedId: referenceResolution.resolvedId ?? null,
      resolvedId: gatewayResolution.resolvedId ?? null,
      expectedDataHash: referenceResolution.dataHashDigest ?? null,
      resolvedDataHash: gatewayResolution.dataHashDigest ?? null,
      failureReason,
      pass,
      timings: gatewayResolution?.timings?.phases,
    };
  }

  /**
   * Assess multiple ArNS names for a gateway with concurrency control.
   */
  async assessArnsNames({
    host,
    names,
  }: {
    host: string;
    names: string[];
  }): Promise<ArnsNameAssessments> {
    return pMap(
      names,
      async (name) => {
        try {
          return await this.assessArnsName({ host, arnsName: name });
        } catch (err) {
          const errorMessage =
            typeof err === 'object' &&
            err !== null &&
            'message' in err &&
            typeof err.message === 'string'
              ? err.message
              : undefined;
          return {
            assessedAt: +(Date.now() / 1000).toFixed(0),
            expectedId: null,
            resolvedId: null,
            expectedDataHash: null,
            resolvedDataHash: null,
            failureReason: errorMessage?.slice(0, 512),
            pass: false,
          };
        }
      },
      { concurrency: this.nameAssessmentConcurrency },
    ).then((results) => {
      return results.reduce((assessments, assessment, index) => {
        assessments[names[index]] = assessment;
        return assessments;
      }, {} as ArnsNameAssessments);
    });
  }

  /**
   * Assess all ArNS names (prescribed and chosen) for a gateway.
   */
  async assessGatewayArns({
    host,
    prescribedNames,
    chosenNames,
  }: {
    host: string;
    prescribedNames: string[];
    chosenNames: string[];
  }): Promise<GatewayArnsAssessments> {
    const [prescribedAssessments, chosenAssessments] = await Promise.all([
      this.assessArnsNames({ host, names: prescribedNames }),
      this.assessArnsNames({ host, names: chosenNames }),
    ]);

    // Calculate pass rate
    const allAssessments = [
      ...Object.values(prescribedAssessments),
      ...Object.values(chosenAssessments),
    ];
    const totalNames = allAssessments.length;
    const passingNames = allAssessments.filter((a) => a.pass).length;
    const passRate = totalNames > 0 ? passingNames / totalNames : 0;

    return {
      prescribedNames: prescribedAssessments,
      chosenNames: chosenAssessments,
      pass: passRate >= NAME_PASS_THRESHOLD,
    };
  }
}
