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
  ArnsAssessments,
  ArnsNameAssessment,
  ArnsNameAssessments,
  ArnsNamesSource,
  HostList,
  ObserverReport,
} from './types.js';

// TODO consider moving this into a resolver class
function getArnsResolution({
  host,
  arnsName,
}: {
  host: string;
  arnsName: string;
}): Promise<{
  resolvedId: string;
  ttlSeconds: string;
  contentLength: string;
  contentType: string;
  dataHashDigest: string;
  timings: Timings;
}> {
  const url = `https://${arnsName}.${host}/`;
  const stream = got.stream.get(url, {
    timeout: {
      lookup: 500,
      connect: 200,
      secureConnect: 200,
      socket: 1000,
    },
  });
  const dataHash = crypto.createHash('sha256');

  return new Promise<{
    resolvedId: string;
    ttlSeconds: string;
    contentType: string;
    contentLength: string;
    dataHashDigest: string;
    timings: any;
  }>((resolve, reject) => {
    let response: any;

    stream.on('error', (error) => {
      reject(error);
    });

    stream.on('response', (resp) => {
      response = resp;
    });

    stream.on('data', (data) => {
      dataHash.update(data);
    });

    stream.on('end', () => {
      resolve({
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

export class Observer {
  private observerAddress: string;
  private referenceGatewayHost: string;
  private observedGatewayHostList: HostList;
  private prescribedNamesSource: ArnsNamesSource;
  private chosenNamesSource: ArnsNamesSource;
  private gatewayAsessementConcurrency: number;
  private nameAssessmentConcurrency: number;

  constructor({
    observerAddress,
    prescribedNamesSource,
    chosenNamesSource,
    referenceGatewayHost,
    observedGatewayHostList,
    gatewayAssessmentConcurrency,
    nameAssessmentConcurrency,
  }: {
    observerAddress: string;
    referenceGatewayHost: string;
    observedGatewayHostList: HostList;
    prescribedNamesSource: ArnsNamesSource;
    chosenNamesSource: ArnsNamesSource;
    gatewayAssessmentConcurrency: number;
    nameAssessmentConcurrency: number;
  }) {
    this.observerAddress = observerAddress;
    this.referenceGatewayHost = referenceGatewayHost;
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

    const pass =
      gatewayResolution.resolvedId === referenceResolution.resolvedId &&
      gatewayResolution.ttlSeconds === referenceResolution.ttlSeconds &&
      gatewayResolution.contentType === referenceResolution.contentType &&
      gatewayResolution.contentLength === referenceResolution.contentLength &&
      gatewayResolution.dataHashDigest === referenceResolution.dataHashDigest;

    return {
      assessedAt: +(Date.now() / 1000).toFixed(0),
      expectedId: referenceResolution.resolvedId ?? null,
      resolvedId: gatewayResolution.resolvedId ?? null,
      expectedDataHash: referenceResolution.dataHashDigest ?? null,
      resolvedDataHash: gatewayResolution.dataHashDigest ?? null,
      pass,
      timings: gatewayResolution.timings.phases,
    };
  }

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
            failureMessage: errorMessage?.slice(0, 512),
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
    const prescribedNames = await this.prescribedNamesSource.getNames();
    const chosenNames = await this.chosenNamesSource.getNames();

    // Assess gateway
    const arnsAssessments: ArnsAssessments = {};
    const gatewayHosts = await this.observedGatewayHostList.getHosts();
    await pMap(
      gatewayHosts,
      async (host) => {
        const [prescribedAssessments, chosenAssessments] = await Promise.all([
          await this.assessArnsNames({
            host,
            names: prescribedNames,
          }),
          await this.assessArnsNames({
            host,
            names: chosenNames,
          }),
        ]);
        arnsAssessments[host] = {
          prescribedNames: prescribedAssessments,
          chosenNames: chosenAssessments,
        };
      },
      { concurrency: this.gatewayAsessementConcurrency },
    );

    return {
      observerAddress: this.observerAddress,
      generatedAt: +(Date.now() / 1000).toFixed(0),
      arnsAssessments,
    };
  }
}
