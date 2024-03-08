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
import { Timings } from '@szmarczak/http-timer';
import got, { RequestError, Response } from 'got';
import crypto from 'node:crypto';
import pMap from 'p-map';

import {
  ArnsNameAssessment,
  ArnsNameAssessments,
  ArnsNamesSource,
  EntropySource,
  EpochHeightSource,
  GatewayAssessments,
  GatewayHostsSource,
  ObserverReport,
  OwnershipAssessment,
} from './types.js';

const REPORT_FORMAT_VERSION = 1;

const NAME_PASS_THRESHOLD = 0.8;

interface ArnsResolution {
  statusCode: number;
  resolvedId: string | null;
  ttlSeconds: string | null;
  contentLength: string | null;
  contentType: string | null;
  dataHashDigest: string | null;
  timings: Timings | null;
}

const client = got.extend({
  timeout: {
    lookup: 5000,
    connect: 2000,
    secureConnect: 2000,
    socket: 1000,
  },
});

export function customHashPRNG(seed: Buffer) {
  if (!Buffer.isBuffer(seed)) {
    throw new Error('Seed must be a Buffer.');
  }

  let currentHash = seed;

  return () => {
    // Create a new hash from the current hash
    const hash = crypto.createHash('sha256');
    hash.update(currentHash);
    currentHash = hash.digest();

    // Convert the hash to a floating-point number and return it
    const int = currentHash.readBigUInt64BE(0);
    return Number(int) / 2 ** 64;
  };
}

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
  host,
  arnsName,
  nodeReleaseVersion,
  entropy,
}: {
  host: string;
  arnsName: string;
  nodeReleaseVersion?: string;
  entropy: Buffer;
}): Promise<ArnsResolution> {
  const MAX_BYTES_TO_PROCESS = 1048576; // 1MiB
  const url = `https://${arnsName}.${host}/`;

  let gotClient = client;

  if (nodeReleaseVersion !== undefined) {
    gotClient = client.extend({
      headers: { 'X-AR-IO-Node-Release': nodeReleaseVersion },
    });
  }

  const notFoundResponse = {
    statusCode: 404,
    resolvedId: null,
    ttlSeconds: null,
    contentType: null,
    contentLength: null,
    dataHashDigest: null,
    timings: null,
  };

  const resolveWithResponse = (
    resolve: (value: ArnsResolution | PromiseLike<ArnsResolution>) => void,
    response: Response,
  ) => {
    if (response.statusCode === 404) {
      resolve(notFoundResponse);
    } else {
      resolve({
        statusCode: response.statusCode,
        resolvedId:
          (response.headers['x-arns-resolved-id'] as string | undefined) ??
          null,
        ttlSeconds:
          (response.headers['x-arns-ttl-seconds'] as string | undefined) ??
          null,
        contentType:
          (response.headers['content-type'] as string | undefined) ?? null,
        contentLength: response.headers['content-length'] ?? null,
        dataHashDigest: dataHash.digest('base64url'),
        timings: response.timings,
      });
    }
  };

  let headResponse: Response;

  try {
    headResponse = await gotClient.head(url);
  } catch (error: any) {
    if ((error as any)?.response?.statusCode === 404) {
      return notFoundResponse;
    }

    throw error;
  }

  if (headResponse.headers['content-length'] === undefined) {
    throw new Error('Content length is not defined');
  }

  const contentLength = headResponse.headers['content-length'];

  const dataHash = crypto.createHash('sha256');

  if (+contentLength > MAX_BYTES_TO_PROCESS) {
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
          gotClient.get(headResponse.requestUrl, {
            responseType: 'buffer',
            headers: {
              Range: `bytes=${range}`,
            },
          }),
        ),
      )
        .then((rangeResponses) => {
          rangeResponses.forEach((response) => {
            dataHash.update(response.body);
          });

          resolveWithResponse(resolve, headResponse);
        })
        .catch((error) => {
          if ((error as any)?.response?.statusCode === 404) {
            resolveWithResponse(resolve, error.response);
          } else {
            reject(error);
          }
        });
    });
  }

  return new Promise<ArnsResolution>((resolve, reject) => {
    const stream = gotClient.stream.get(url);

    stream.on('error', (error: RequestError) => {
      if (error.response !== undefined && error.response.statusCode === 404) {
        resolveWithResponse(resolve, error.response);
      } else {
        reject(error);
      }
    });

    stream.on('data', (data) => {
      dataHash.update(data);
    });

    stream.on('end', () => {
      resolveWithResponse(resolve, headResponse);
    });
  });
}

async function assessOwnership({
  host,
  expectedWallets,
}: {
  host: string;
  expectedWallets: string[];
}): Promise<OwnershipAssessment> {
  try {
    const url = `https://${host}/ar-io/info`;
    const resp = await client.get(url).json<any>();
    if (resp?.wallet) {
      if (!expectedWallets.includes(resp.wallet)) {
        return {
          expectedWallets,
          observedWallet: null,
          failureReason: `Wallet mismatch: expected one of ${expectedWallets.join(
            ', ',
          )} but found ${resp.wallet}`,
          pass: false,
        };
      } else {
        return {
          expectedWallets,
          observedWallet: resp.wallet,
          pass: true,
        };
      }
    }
    return {
      expectedWallets,
      observedWallet: null,
      failureReason: `No wallet found`,
      pass: false,
    };
  } catch (error: any) {
    return {
      expectedWallets,
      observedWallet: null,
      failureReason: error?.message as string,
      pass: false,
    };
  }
}

export class Observer {
  private observerAddress: string;
  private referenceGatewayHost: string;
  private epochHeightSource: EpochHeightSource;
  private observedGatewayHostList: GatewayHostsSource;
  private prescribedNamesSource: ArnsNamesSource;
  private chosenNamesSource: ArnsNamesSource;
  private gatewayAsessementConcurrency: number;
  private nameAssessmentConcurrency: number;
  private nodeReleaseVersion: string;
  private entropySource: EntropySource;

  constructor({
    observerAddress,
    prescribedNamesSource,
    epochHeightSource,
    chosenNamesSource,
    referenceGatewayHost,
    observedGatewayHostList,
    gatewayAssessmentConcurrency,
    nameAssessmentConcurrency,
    nodeReleaseVersion,
    entropySource,
  }: {
    observerAddress: string;
    referenceGatewayHost: string;
    epochHeightSource: EpochHeightSource;
    observedGatewayHostList: GatewayHostsSource;
    prescribedNamesSource: ArnsNamesSource;
    chosenNamesSource: ArnsNamesSource;
    gatewayAssessmentConcurrency: number;
    nameAssessmentConcurrency: number;
    nodeReleaseVersion: string;
    entropySource: EntropySource;
  }) {
    this.observerAddress = observerAddress;
    this.referenceGatewayHost = referenceGatewayHost;
    this.epochHeightSource = epochHeightSource;
    this.observedGatewayHostList = observedGatewayHostList;
    this.prescribedNamesSource = prescribedNamesSource;
    this.chosenNamesSource = chosenNamesSource;
    this.gatewayAsessementConcurrency = gatewayAssessmentConcurrency;
    this.nameAssessmentConcurrency = nameAssessmentConcurrency;
    this.nodeReleaseVersion = nodeReleaseVersion;
    this.entropySource = entropySource;
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
    // TODO handle exceptions
    const referenceResolution = await getArnsResolution({
      host: this.referenceGatewayHost,
      arnsName,
      nodeReleaseVersion: this.nodeReleaseVersion,
      entropy,
    });

    const gatewayResolution = await getArnsResolution({
      host,
      arnsName,
      entropy,
    });

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

  async generateReport(): Promise<ObserverReport> {
    const epochStartHeight = await this.epochHeightSource.getEpochStartHeight();
    const epochEndHeight = await this.epochHeightSource.getEpochEndHeight();
    const prescribedNames = await this.prescribedNamesSource.getNames({
      height: epochStartHeight,
    });
    const chosenNames = await this.chosenNamesSource.getNames({
      height: epochStartHeight,
    });

    // Assess gateway
    const gatewayAssessments: GatewayAssessments = {};
    const gatewayHosts = await this.observedGatewayHostList.getHosts();

    // Create map of FQDN => hosts to handle duplicates
    const hostWallets: { [key: string]: string[] } = {};
    gatewayHosts.forEach((host) => {
      (hostWallets[host.fqdn] ||= []).push(host.wallet);
    });

    const entropy = await this.entropySource.getEntropy({
      height: epochStartHeight,
    });

    await pMap(
      gatewayHosts,
      async (host) => {
        const ownershipAssessment = await assessOwnership({
          host: host.fqdn,
          expectedWallets: hostWallets[host.fqdn].sort(),
        });

        const [prescribedAssessments, chosenAssessments] = await Promise.all([
          await this.assessArnsNames({
            host: host.fqdn,
            names: prescribedNames,
            entropy,
          }),
          await this.assessArnsNames({
            host: host.fqdn,
            names: chosenNames,
            entropy,
          }),
        ]);

        const nameCount = new Set([...prescribedNames, ...chosenNames]).size;
        const namePassCount = Object.values({
          ...prescribedAssessments,
          ...chosenAssessments,
        }).reduce(
          (count, assessment) => (assessment.pass ? count + 1 : count),
          0,
        );
        const namesPass = namePassCount >= nameCount * NAME_PASS_THRESHOLD;

        gatewayAssessments[host.fqdn] = {
          ownershipAssessment,
          arnsAssessments: {
            prescribedNames: prescribedAssessments,
            chosenNames: chosenAssessments,
            pass: namesPass,
          },
          pass: ownershipAssessment.pass && namesPass,
        };
      },
      { concurrency: this.gatewayAsessementConcurrency },
    );

    return {
      formatVersion: REPORT_FORMAT_VERSION,
      observerAddress: this.observerAddress,
      epochStartHeight,
      epochEndHeight,
      generatedAt: +(Date.now() / 1000).toFixed(0),
      gatewayAssessments,
    };
  }
}
