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
import got from 'got';
import crypto from 'node:crypto';
import pMap from 'p-map';

import {
  ArnsNameAssessment,
  ArnsNameAssessments,
  ArnsNamesSource,
  GatewayAssessments,
  GatewayHostList,
  HeightSource,
  ObserverReport,
  OwnershipAssessment,
} from './types.js';

interface ArnsResolution {
  statusCode: number;
  resolvedId: string | null;
  ttlSeconds: string | null;
  contentLength: string | null;
  contentType: string | null;
  dataHashDigest: string | null;
  timings: Timings | null;
}

// TODO consider moving this into a resolver class
function getArnsResolution({
  host,
  arnsName,
}: {
  host: string;
  arnsName: string;
}): Promise<ArnsResolution> {
  const url = `https://${arnsName}.${host}/`;
  const stream = got.stream.get(url, {
    timeout: {
      lookup: 5000,
      connect: 2000,
      secureConnect: 2000,
      socket: 1000,
    },
  });
  const dataHash = crypto.createHash('sha256');

  return new Promise<ArnsResolution>((resolve, reject) => {
    let response: any;

    stream.on('error', (error) => {
      if ((error as any)?.response?.statusCode === 404) {
        resolve({
          statusCode: 404,
          resolvedId: null,
          ttlSeconds: null,
          contentType: null,
          contentLength: null,
          dataHashDigest: null,
          timings: null,
        });
      } else {
        reject(error);
      }
    });

    stream.on('response', (resp) => {
      response = resp;
    });

    stream.on('data', (data) => {
      dataHash.update(data);
    });

    stream.on('end', () => {
      resolve({
        statusCode: +response.statusCode,
        resolvedId: response.headers['x-arns-resolved-id'],
        ttlSeconds: response.headers['x-arns-ttl-seconds'],
        contentType: response.headers['content-type'],
        contentLength: response.headers['content-length'],
        dataHashDigest: dataHash.digest('base64url'),
        timings: response.timings,
      });
    });
  });
}

async function assessOwnership({
  host,
  expectedWallet,
}: {
  host: string;
  expectedWallet: string;
}): Promise<OwnershipAssessment> {
  try {
    const url = `https://${host}/ar-io/info`;
    const resp = await got
      .get(url, {
        timeout: {
          lookup: 5000,
          connect: 2000,
          secureConnect: 2000,
          socket: 1000,
        },
      })
      .json<any>();
    if (resp?.wallet) {
      if (resp.wallet !== expectedWallet) {
        return {
          expectedWallet,
          observedWallet: null,
          failureReason: `Wallet mismatch: expected ${expectedWallet} but found ${resp.wallet}`,
          pass: false,
        };
      } else {
        return {
          expectedWallet,
          observedWallet: resp.wallet,
          pass: true,
        };
      }
    }
    return {
      expectedWallet,
      observedWallet: null,
      failureReason: `No wallet found`,
      pass: false,
    };
  } catch (error: any) {
    return {
      expectedWallet,
      observedWallet: null,
      failureReason: error?.message as string,
      pass: false,
    };
  }
}

export class Observer {
  private observerAddress: string;
  private referenceGatewayHost: string;
  private epochHeightSource: HeightSource;
  private observedGatewayHostList: GatewayHostList;
  private prescribedNamesSource: ArnsNamesSource;
  private chosenNamesSource: ArnsNamesSource;
  private gatewayAsessementConcurrency: number;
  private nameAssessmentConcurrency: number;

  constructor({
    observerAddress,
    prescribedNamesSource,
    epochHeightSource,
    chosenNamesSource,
    referenceGatewayHost,
    observedGatewayHostList,
    gatewayAssessmentConcurrency,
    nameAssessmentConcurrency,
  }: {
    observerAddress: string;
    referenceGatewayHost: string;
    epochHeightSource: HeightSource;
    observedGatewayHostList: GatewayHostList;
    prescribedNamesSource: ArnsNamesSource;
    chosenNamesSource: ArnsNamesSource;
    gatewayAssessmentConcurrency: number;
    nameAssessmentConcurrency: number;
  }) {
    this.observerAddress = observerAddress;
    this.referenceGatewayHost = referenceGatewayHost;
    this.epochHeightSource = epochHeightSource;
    this.observedGatewayHostList = observedGatewayHostList;
    this.prescribedNamesSource = prescribedNamesSource;
    this.chosenNamesSource = chosenNamesSource;
    this.gatewayAsessementConcurrency = gatewayAssessmentConcurrency;
    this.nameAssessmentConcurrency = nameAssessmentConcurrency;
  }

  async assessArnsName({
    host,
    arnsName,
  }: {
    host: string;
    arnsName: string;
  }): Promise<ArnsNameAssessment> {
    // TODO handle exceptions
    const referenceResolution = await getArnsResolution({
      host: this.referenceGatewayHost,
      arnsName,
    });

    const gatewayResolution = await getArnsResolution({
      host,
      arnsName,
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
  }: {
    host: string;
    names: string[];
  }): Promise<ArnsNameAssessments> {
    return pMap(
      names,
      async (name) => {
        try {
          return await this.assessArnsName({
            host,
            arnsName: name,
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
    const epochStartHeight = await this.epochHeightSource.getHeight();
    const prescribedNames = await this.prescribedNamesSource.getNames();
    const chosenNames = await this.chosenNamesSource.getNames();

    // Assess gateway
    const gatewayAssessments: GatewayAssessments = {};
    const gatewayHosts = await this.observedGatewayHostList.getHosts();
    await pMap(
      gatewayHosts,
      async (host) => {
        const [prescribedAssessments, chosenAssessments] = await Promise.all([
          await this.assessArnsNames({
            host: host.fqdn,
            names: prescribedNames,
          }),
          await this.assessArnsNames({
            host: host.fqdn,
            names: chosenNames,
          }),
        ]);
        const ownershipAssessment = await assessOwnership({
          host: host.fqdn,
          expectedWallet: host.wallet,
        });
        gatewayAssessments[host.fqdn] = {
          ownershipAssessment,
          arnsAssessments: {
            prescribedNames: prescribedAssessments,
            chosenNames: chosenAssessments,
          },
        };
      },
      { concurrency: this.gatewayAsessementConcurrency },
    );

    return {
      observerAddress: this.observerAddress,
      epochStartHeight,
      generatedAt: +(Date.now() / 1000).toFixed(0),
      gatewayAssessments,
    };
  }
}
