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
import got from 'got';
import crypto from 'node:crypto';

import {
  ArnsAssessments,
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
  timings: any;
}> {
  const url = `https://${arnsName}.${host}/`;
  const stream = got.stream.get(url);
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
        timings: response.timings.phases,
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

  constructor({
    observerAddress,
    prescribedNamesSource,
    chosenNamesSource,
    referenceGatewayHost,
    observedGatewayHostList,
  }: {
    observerAddress: string;
    referenceGatewayHost: string;
    observedGatewayHostList: HostList;
    prescribedNamesSource: ArnsNamesSource;
    chosenNamesSource: ArnsNamesSource;
  }) {
    this.observerAddress = observerAddress;
    this.referenceGatewayHost = referenceGatewayHost;
    this.observedGatewayHostList = observedGatewayHostList;
    this.prescribedNamesSource = prescribedNamesSource;
    this.chosenNamesSource = chosenNamesSource;
  }

  async assessArnsName({ host, arnsName }: { host: string; arnsName: string }) {
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

    // TODO fix timings (currently not working)
    return {
      assessedAt: +(Date.now() / 1000).toFixed(0),
      resolvedId: gatewayResolution.resolvedId,
      dataHash: gatewayResolution.dataHashDigest,
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
    return Promise.allSettled(
      names.map((name) => {
        return this.assessArnsName({
          host,
          arnsName: name,
        });
      }),
    ).then((results) => {
      return results.reduce((acc, result, index) => {
        if (result.status === 'fulfilled') {
          acc[names[index]] = result.value;
        }
        // TODO log or otherwise handle errors
        return acc;
      }, {} as ArnsNameAssessments);
    });
  }

  async generateReport(): Promise<ObserverReport> {
    const prescribedNames = await this.prescribedNamesSource.getNames();
    const chosenNames = await this.chosenNamesSource.getNames();

    // Assess gateway
    const arnsAssessments: ArnsAssessments = {};
    const gatewayHosts = await this.observedGatewayHostList.getHosts();
    for (const host of gatewayHosts) {
      arnsAssessments[host] = {
        prescribedNames: await this.assessArnsNames({
          host,
          names: prescribedNames,
        }),
        chosenNames: await this.assessArnsNames({
          host,
          names: chosenNames,
        }),
      };
    }

    return {
      observerAddress: this.observerAddress,
      generatedAt: +(Date.now() / 1000).toFixed(0),
      arnsAssessments,
    };
  }
}
