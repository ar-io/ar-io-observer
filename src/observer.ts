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
import got, { Got, RequestError, Response } from 'got';
import crypto from 'node:crypto';
import pMap from 'p-map';

import { MAX_FORK_DEPTH } from './arweave.js';
import {
  OffsetAssessor,
  offsetAssessmentPasses,
  recordOffsetAssessmentMetrics,
  selectGatewaysForOffsetAssessment,
} from './assessment/offset-assessor.js';
import * as config from './config.js';
import { customHashPRNG } from './lib/prng.js';
import log from './log.js';
import * as metrics from './metrics.js';
import { ReferenceResolutionCache } from './reference/reference-resolution-cache.js';

import {
  ArnsNameAssessment,
  ArnsNameAssessments,
  ArnsNamesSource,
  ArnsResolution,
  EntropySource,
  EpochTimestampSource,
  GatewayAssessments,
  GatewayHost,
  GatewayHostsSource,
  HeightSource,
  ObserverReport,
  OwnershipAssessment,
  ReferenceGatewaySource,
} from './types.js';

export const REPORT_FORMAT_VERSION = 2;

const NAME_PASS_THRESHOLD = 0.8;

const client = got.extend({
  timeout: {
    lookup: 5000,
    connect: 5000,
    secureConnect: 2000,
    socket: 7000,
  },
});

export function generateRandomRanges({
  contentSize,
  rangeSize,
  rangeQuantity,
  rng,
}: {
  contentSize: number;
  rangeSize: number;
  rangeQuantity: number;
  rng: () => number;
}): string[] {
  const ranges: string[] = [];

  for (let i = 0; i < rangeQuantity; i++) {
    const maxStart = contentSize - rangeSize;
    const start = Math.floor(rng() * maxStart);
    const end = start + rangeSize - 1;
    ranges.push(`${start}-${end}`);
  }

  return ranges;
}

// TODO consider moving this into a resolver class
export async function getArnsResolution({
  url,
  got,
  referenceGatewayContentLength = null,
  entropy,
}: {
  url: string;
  got: Got;
  referenceGatewayContentLength?: string | null;
  entropy: Buffer;
}): Promise<ArnsResolution> {
  const MAX_BYTES_TO_PROCESS = 1048576; // 1MiB

  const arnsResolution = (response: Response, dataHashDigest?: string) => ({
    statusCode: response.statusCode,
    resolvedId:
      (response.headers['x-arns-resolved-id'] as string | undefined) ?? null,
    ttlSeconds:
      (response.headers['x-arns-ttl-seconds'] as string | undefined) ?? null,
    contentType:
      response.statusCode === 404
        ? null
        : ((response.headers['content-type'] as string | undefined) ?? null),
    contentLength:
      response.statusCode === 404
        ? null
        : (response.headers['content-length'] ?? null),
    dataHashDigest: dataHashDigest ?? null,
    timings: response.timings,
  });

  const dataHash = crypto.createHash('sha256');

  const getHashWithinFirstMiB = () => {
    return new Promise<ArnsResolution>((resolve, reject) => {
      const stream = got.stream.get(url, {
        headers: { 'Accept-Encoding': 'identity' },
      });
      let response: any;
      let streamBytesProcessed = 0;

      stream.on('error', (error: RequestError) => {
        if (error.response !== undefined && error.response.statusCode === 404) {
          resolve(arnsResolution(error.response));
        } else {
          reject(error);
        }
      });

      stream.on('response', (resp) => {
        response = resp;
      });

      stream.on('data', (data) => {
        const bytesToProcess = Math.min(
          data.length,
          MAX_BYTES_TO_PROCESS - streamBytesProcessed,
        );

        if (bytesToProcess > 0) {
          dataHash.update(data.slice(0, bytesToProcess));
          streamBytesProcessed += bytesToProcess;
        }

        if (streamBytesProcessed >= MAX_BYTES_TO_PROCESS) {
          stream.on('close', () => {
            resolve(arnsResolution(response, dataHash.digest('base64url')));
          });

          stream.destroy();
        }
      });

      stream.on('end', () => {
        resolve(arnsResolution(response, dataHash.digest('base64url')));
      });
    });
  };

  const getHashWithRangeRequests = () => {
    return new Promise<ArnsResolution>((resolve, reject) => {
      const rng = customHashPRNG(entropy);
      const ranges = generateRandomRanges({
        contentSize: +contentLength,
        rangeSize: 200,
        rangeQuantity: 5,
        rng,
      });

      Promise.all(
        ranges.map((range) =>
          got.get(url, {
            responseType: 'buffer',
            headers: {
              Range: `bytes=${range}`,
              'Accept-Encoding': 'identity',
            },
          }),
        ),
      )
        .then((rangeResponses) => {
          rangeResponses.forEach((response: Response<Buffer>) => {
            dataHash.update(response.body);
          });

          resolve(arnsResolution(headResponse, dataHash.digest('base64url')));
        })
        .catch((error) => {
          if ((error as any)?.response?.statusCode === 404) {
            resolve(arnsResolution(headResponse));
          } else {
            reject(error);
          }
        });
    });
  };

  let headResponse: Response;
  try {
    headResponse = await got.head(url);
  } catch (error: any) {
    if ((error as any)?.response?.statusCode === 404) {
      return arnsResolution(error.response);
    }

    throw error;
  }

  let contentLength: string;
  if (referenceGatewayContentLength !== null) {
    contentLength = referenceGatewayContentLength;
  } else {
    if (headResponse.headers['content-length'] !== undefined) {
      contentLength = headResponse.headers['content-length'];
    } else {
      return getHashWithinFirstMiB();
    }
  }

  if (+contentLength > MAX_BYTES_TO_PROCESS) {
    return getHashWithRangeRequests();
  }

  return getHashWithinFirstMiB();
}

export async function assessOwnership({
  host,
  expectedWallets,
}: {
  host: string;
  expectedWallets: string[];
}): Promise<OwnershipAssessment> {
  try {
    const url = `https://${host}/ar-io/info`;
    const resp = await client.get(url).json<any>();
    const observedRelease =
      resp?.release === undefined || resp?.release === null
        ? undefined
        : String(resp.release);
    if (resp?.wallet) {
      if (!expectedWallets.includes(resp.wallet)) {
        const result = {
          expectedWallets,
          observedWallet: resp.wallet,
          observedRelease,
          failureReason: `Wallet mismatch: expected one of ${expectedWallets.join(
            ', ',
          )} but found ${resp.wallet}`,
          pass: false,
        };
        metrics.ownershipAssessmentsCounter.inc({
          status: 'fail',
          enforced: 'true',
        });
        return result;
      } else {
        const result = {
          expectedWallets,
          observedWallet: resp.wallet,
          observedRelease,
          pass: true,
        };
        metrics.ownershipAssessmentsCounter.inc({
          status: 'pass',
          enforced: 'true',
        });
        return result;
      }
    }
    const result = {
      expectedWallets,
      observedWallet: null,
      observedRelease,
      failureReason: `No wallet found`,
      pass: false,
    };
    metrics.ownershipAssessmentsCounter.inc({
      status: 'fail',
      enforced: 'true',
    });
    return result;
  } catch (error: any) {
    const result = {
      expectedWallets,
      observedWallet: null,
      failureReason: error?.message as string,
      pass: false,
    };
    metrics.ownershipAssessmentsCounter.inc({
      status: 'fail',
      enforced: 'true',
    });
    return result;
  }
}

export class Observer {
  private observerAddress: string;
  private referenceGateway: ReferenceGatewaySource;
  private arweaveBaseUrl: string;
  private epochSource: EpochTimestampSource;
  private observedGatewayHostList: GatewayHostsSource;
  private prescribedNamesSource: ArnsNamesSource;
  private chosenNamesSource: ArnsNamesSource;
  private gatewayAssessmentConcurrency: number;
  private nameAssessmentConcurrency: number;
  private nodeReleaseVersion: string;
  private entropySource: EntropySource;
  private heightSource: HeightSource;
  private gotClient: Got;
  private referenceGatewayResolutionCache?: ReferenceResolutionCache;
  private offsetAssessor: OffsetAssessor;

  constructor({
    observerAddress,
    prescribedNamesSource,
    epochSource,
    chosenNamesSource,
    referenceGateway,
    arweaveUrl,
    observedGatewayHostList,
    gatewayAssessmentConcurrency,
    nameAssessmentConcurrency,
    nodeReleaseVersion,
    entropySource,
    heightSource,
  }: {
    observerAddress: string;
    referenceGateway: ReferenceGatewaySource;
    arweaveUrl: string;
    epochSource: EpochTimestampSource;
    observedGatewayHostList: GatewayHostsSource;
    prescribedNamesSource: ArnsNamesSource;
    chosenNamesSource: ArnsNamesSource;
    gatewayAssessmentConcurrency: number;
    nameAssessmentConcurrency: number;
    nodeReleaseVersion: string;
    entropySource: EntropySource;
    heightSource: HeightSource;
  }) {
    this.observerAddress = observerAddress;
    this.referenceGateway = referenceGateway;
    this.arweaveBaseUrl = new URL(arweaveUrl).origin;
    this.epochSource = epochSource;
    this.observedGatewayHostList = observedGatewayHostList;
    this.prescribedNamesSource = prescribedNamesSource;
    this.chosenNamesSource = chosenNamesSource;
    this.gatewayAssessmentConcurrency = gatewayAssessmentConcurrency;
    this.nameAssessmentConcurrency = nameAssessmentConcurrency;
    this.nodeReleaseVersion = nodeReleaseVersion;
    this.entropySource = entropySource;
    this.heightSource = heightSource;
    this.gotClient = client.extend({
      headers: { 'X-AR-IO-Node-Release': this.nodeReleaseVersion },
    });

    this.offsetAssessor = new OffsetAssessor({
      referenceGateway,
      arweaveUrl,
      gotClient: this.gotClient,
    });
  }

  async assessArnsName({
    host,
    arnsName,
    entropy,
  }: {
    host: string;
    arnsName: string;
    entropy: Buffer;
  }): Promise<ArnsNameAssessment> {
    // TODO instantiate cache in constructor
    // Currently not possible because we only have access to epochStartHeight in generateReport
    if (this.referenceGatewayResolutionCache === undefined) {
      throw new Error('Reference gateway resolution cache not set');
    }

    const referenceResolution = await this.referenceGatewayResolutionCache.get(
      arnsName,
      host,
    );

    const arnsResolutionTimer = metrics.arnsResolutionHistogram.startTimer();
    const gatewayResolution = await getArnsResolution({
      url: `https://${arnsName}.${host}/`,
      got: this.gotClient,
      referenceGatewayContentLength: referenceResolution.contentLength,
      entropy,
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

  // TODO add port
  async assessArnsNames({
    host,
    names,
    entropy,
  }: {
    host: string;
    names: string[];
    entropy: Buffer;
  }): Promise<ArnsNameAssessments> {
    return pMap(
      names,
      async (name) => {
        try {
          return await this.assessArnsName({
            host,
            arnsName: name,
            entropy,
          });
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

  private async runSingleObservation(
    epochStartTimestamp: number,
    epochEndTimestamp: number,
    epochStartHeight: number,
    epochIndex: number,
    prescribedNames: string[],
    chosenNames: string[],
    gatewayHosts: GatewayHost[],
    hostWallets: { [key: string]: string[] },
    entropy: Buffer,
  ): Promise<ObserverReport> {
    const gatewayAssessments: GatewayAssessments = {};

    // Calculate stable search parameters once for the entire observation
    // All gateways will use the same search space for consistency and cache efficiency
    let maxStableOffset = 0;
    let maxSearchHeight = 1;

    if (config.OFFSET_OBSERVATION_ENABLED) {
      const currentHeight = await this.heightSource.getHeight();
      maxSearchHeight = Math.max(1, currentHeight - MAX_FORK_DEPTH);

      // Get the weave size at the stable height to determine max stable offset
      const stableBlock = await this.offsetAssessor.getBlockByHeight(
        this.arweaveBaseUrl,
        maxSearchHeight,
      );
      maxStableOffset = parseInt(stableBlock.weave_size, 10);

      log.debug('Stable search parameters calculated for observation', {
        currentHeight,
        maxSearchHeight,
        maxStableOffset,
      });
    }

    // Shuffle the gateway hosts for this observation
    const shuffledGatewayHosts = [...gatewayHosts].sort(
      () => Math.random() - 0.5,
    );

    // Deterministically select gateways for offset observations based on sample rate
    const selectedGatewaysForOffset = selectGatewaysForOffsetAssessment({
      fqdns: shuffledGatewayHosts.map((host) => host.fqdn),
      entropy,
      enabled: config.OFFSET_OBSERVATION_ENABLED,
      sampleRate: config.OFFSET_OBSERVATION_SAMPLE_RATE,
    });
    if (selectedGatewaysForOffset.size > 0) {
      const gatewayCount = shuffledGatewayHosts.length;
      log.debug('Selected gateways for offset observations', {
        totalGateways: gatewayCount,
        sampleRate: config.OFFSET_OBSERVATION_SAMPLE_RATE,
        selectedCount: selectedGatewaysForOffset.size,
        selectedGateways: Array.from(selectedGatewaysForOffset).sort(),
      });
    }

    this.referenceGatewayResolutionCache = new ReferenceResolutionCache({
      referenceGateway: this.referenceGateway,
      entropy,
      // Shared entry per name plus entries for observed reference gateways
      capacity: (prescribedNames.length + chosenNames.length) * 2,
      ttlMs: 5 * 60_000, // 5 minutes
      log,
    });

    await pMap(
      shuffledGatewayHosts,
      async (host) => {
        // Run ownership assessment first, then other assessments in parallel
        const ownershipAssessment = await assessOwnership({
          host: host.fqdn,
          expectedWallets: hostWallets[host.fqdn].sort(),
        });

        const [[prescribedAssessments, chosenAssessments], offsetAssessments] =
          await Promise.all([
            // ArNS name assessments (prescribed and chosen in parallel)
            Promise.all([
              this.assessArnsNames({
                host: host.fqdn,
                names: prescribedNames,
                entropy,
              }),
              this.assessArnsNames({
                host: host.fqdn,
                names: chosenNames,
                entropy,
              }),
            ]),

            // Offset sampling (if enabled and gateway is selected)
            config.OFFSET_OBSERVATION_ENABLED &&
            selectedGatewaysForOffset.has(host.fqdn)
              ? this.offsetAssessor.assessSampledGateway({
                  targetHost: host.fqdn,
                  entropy,
                  offsetSampleCount: config.OFFSET_SAMPLE_COUNT,
                  maxStableOffset,
                  maxSearchHeight,
                  enforcementEnabled:
                    config.OFFSET_OBSERVATION_ENFORCEMENT_ENABLED,
                })
              : (async () => {
                  const reason = !config.OFFSET_OBSERVATION_ENABLED
                    ? 'disabled'
                    : 'not selected for sampling';
                  log.verbose(
                    `Offset sampling ${reason}, skipping for ${host.fqdn}`,
                  );
                  return undefined;
                })(),
          ]);

        // Track ArNS assessment metrics
        Object.values(prescribedAssessments).forEach((assessment) => {
          metrics.arnsAssessmentsCounter.inc({
            type: 'prescribed',
            status: assessment.pass ? 'pass' : 'fail',
            enforced: 'true',
          });
        });

        Object.values(chosenAssessments).forEach((assessment) => {
          metrics.arnsAssessmentsCounter.inc({
            type: 'chosen',
            status: assessment.pass ? 'pass' : 'fail',
            enforced: 'true',
          });
        });

        // Track offset assessment metrics
        recordOffsetAssessmentMetrics({
          sampled:
            config.OFFSET_OBSERVATION_ENABLED &&
            selectedGatewaysForOffset.has(host.fqdn),
          offsetAssessments,
          enforcementEnabled: config.OFFSET_OBSERVATION_ENFORCEMENT_ENABLED,
        });

        const nameCount = new Set([...prescribedNames, ...chosenNames]).size;
        const namePassCount = Object.values({
          ...prescribedAssessments,
          ...chosenAssessments,
        }).reduce(
          (count, assessment) => (assessment.pass ? count + 1 : count),
          0,
        );
        const namesPass = namePassCount >= nameCount * NAME_PASS_THRESHOLD;

        // Check if offset observation enforcement should affect pass status
        const offsetPass = offsetAssessmentPasses({
          offsetAssessments,
          enforcementEnabled: config.OFFSET_OBSERVATION_ENFORCEMENT_ENABLED,
        });

        const gatewayPass = ownershipAssessment.pass && namesPass && offsetPass;

        gatewayAssessments[host.fqdn] = {
          ownershipAssessment,
          arnsAssessments: {
            prescribedNames: prescribedAssessments,
            chosenNames: chosenAssessments,
            pass: namesPass,
          },
          ...(offsetAssessments !== undefined ? { offsetAssessments } : {}),
          pass: gatewayPass,
        };

        // Track gateway assessment metrics
        metrics.gatewayAssessmentsCounter.inc({
          status: gatewayPass ? 'pass' : 'fail',
        });
      },
      { concurrency: this.gatewayAssessmentConcurrency },
    );

    const report = {
      formatVersion: REPORT_FORMAT_VERSION,
      observerAddress: this.observerAddress,
      epochIndex,
      epochStartTimestamp,
      epochStartHeight,
      epochEndTimestamp,
      generatedAt: +(Date.now() / 1000).toFixed(0),
      gatewayAssessments,
    };

    // Track report generation metrics
    metrics.reportsGeneratedCounter.inc({ status: 'success' });

    // Update gauge metrics with latest report data
    const gatewayCount = Object.keys(gatewayAssessments).length;
    const failureRate = this.calculateFailureRate(report);

    metrics.lastReportGatewayCountGauge.set(gatewayCount);
    metrics.lastReportFailureRateGauge.set(failureRate);
    metrics.lastReportTimestampGauge.set(report.generatedAt);

    return report;
  }

  private calculateFailureRate(report: ObserverReport): number {
    let totalAssessments = 0;
    let failedAssessments = 0;

    Object.values(report.gatewayAssessments).forEach((gatewayAssessment) => {
      // Count ownership assessment
      totalAssessments++;
      if (!gatewayAssessment.ownershipAssessment.pass) {
        failedAssessments++;
      }

      // Count prescribed name assessments
      Object.values(gatewayAssessment.arnsAssessments.prescribedNames).forEach(
        (assessment) => {
          totalAssessments++;
          if (!assessment.pass) {
            failedAssessments++;
          }
        },
      );

      // Count chosen name assessments
      Object.values(gatewayAssessment.arnsAssessments.chosenNames).forEach(
        (assessment) => {
          totalAssessments++;
          if (!assessment.pass) {
            failedAssessments++;
          }
        },
      );
    });

    return totalAssessments > 0 ? failedAssessments / totalAssessments : 0;
  }

  async generateReport(): Promise<ObserverReport> {
    const epochStartTimestamp = await this.epochSource.getEpochStartTimestamp();
    const epochEndTimestamp = await this.epochSource.getEpochEndTimestamp();
    const epochStartHeight = await this.epochSource.getEpochStartHeight();
    const epochIndex = await this.epochSource.getEpochIndex();
    const prescribedNames = await this.prescribedNamesSource.getNames({
      epochIndex: epochIndex,
    });
    // observer will choose names based on the epoch start height
    const chosenNames = await this.chosenNamesSource.getNames({
      height: epochStartHeight,
    });

    // Assess gateway
    const gatewayHosts = await this.observedGatewayHostList.getHosts();

    // Create map of FQDN => hosts to handle duplicates
    const hostWallets: { [key: string]: string[] } = {};
    gatewayHosts.forEach((host) => {
      (hostWallets[host.fqdn] ||= []).push(host.wallet);
    });

    // use the epoch start height to compute entropy for
    const entropy = await this.entropySource.getEntropy({
      height: epochStartHeight,
    });

    // Run 2 observations serially
    const observations: ObserverReport[] = [];

    for (let i = 0; i < 2; i++) {
      const observation = await this.runSingleObservation(
        epochStartTimestamp,
        epochEndTimestamp,
        epochStartHeight,
        epochIndex,
        prescribedNames,
        chosenNames,
        gatewayHosts,
        hostWallets,
        entropy,
      );
      observations.push(observation);
    }

    // Calculate failure rates and select the observation with the lowest rate
    let bestObservation = observations[0];
    let lowestFailureRate = this.calculateFailureRate(observations[0]);

    for (let i = 1; i < observations.length; i++) {
      const failureRate = this.calculateFailureRate(observations[i]);
      if (failureRate < lowestFailureRate) {
        lowestFailureRate = failureRate;
        bestObservation = observations[i];
      }
    }

    return bestObservation;
  }
}
