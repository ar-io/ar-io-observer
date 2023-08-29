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
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';

import {
  ArnsAssessments,
  ArnsNameAssessments,
  ArnsNameList,
  ArnsNamesSource,
  EntropySource,
  ObserverReport,
} from './types.js';

// TODO move this into a resolver class
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

export class StaticArnsNameList implements ArnsNameList {
  private names: string[];

  constructor(names: string[]) {
    this.names = names;
  }

  async getNamesCount(): Promise<number> {
    return this.names.length;
  }

  async getName(index: number): Promise<string> {
    return this.names[index];
  }
}

export class StaticArnsNamesSource implements ArnsNamesSource {
  private addresses: string[];

  constructor(addresses: string[]) {
    this.addresses = addresses;
  }

  async getNames(): Promise<string[]> {
    return this.addresses;
  }
}

export class RandomArnsNamesSource implements ArnsNamesSource {
  private nameList: ArnsNameList;
  private entropySource: EntropySource;
  private nameCount: number;

  constructor({
    nameList,
    entropySource,
    nameCount,
  }: {
    nameList: ArnsNameList;
    entropySource: EntropySource;
    nameCount: number;
  }) {
    this.nameList = nameList;
    this.entropySource = entropySource;
    this.nameCount = nameCount;
  }

  async getNames(): Promise<string[]> {
    const names: string[] = [];
    const usedIndexes = new Set<number>();
    const entropy = await this.entropySource.getEntropy();
    let hash = crypto.createHash('sha256').update(entropy).digest();

    for (let i = 0; i < this.nameCount; i++) {
      let index = hash.readUInt32BE(0) % this.nameCount;

      while (usedIndexes.has(index)) {
        index = (index + 1) % this.nameCount;
      }

      usedIndexes.add(index);
      names.push(await this.nameList.getName(index));

      hash = crypto.createHash('sha256').update(hash).digest();
    }

    return names;
  }
}

export class RandomEntropySource implements EntropySource {
  async getEntropy(): Promise<Buffer> {
    return randomBytes(256);
  }
}

export class CachedEntropySource implements EntropySource {
  private entropySource: EntropySource;
  private cachePath: string;

  constructor({
    entropySource,
    cachePath,
  }: {
    entropySource: EntropySource;
    cachePath: string;
  }) {
    this.entropySource = entropySource;
    this.cachePath = cachePath;

    this.ensureEntropyFileExists();
  }

  async ensureEntropyFileExists(): Promise<void> {
    try {
      await fs.promises.access(this.cachePath);
    } catch {
      const entropy = await this.entropySource.getEntropy();
      await fs.promises.writeFile(this.cachePath, entropy);
    }
  }

  async getEntropy(): Promise<Buffer> {
    return fs.promises.readFile(this.cachePath);
  }
}

export class CompositeEntroySource {
  private sources: EntropySource[];

  constructor(sources: EntropySource[]) {
    this.sources = sources;
  }

  async getEntropy(): Promise<Buffer> {
    const hash = crypto.createHash('sha256');

    const entropies = await Promise.all(
      this.sources.map((source) => source.getEntropy()),
    );

    entropies.forEach((entropy) => hash.update(entropy));

    return hash.digest();
  }
}

export class Observer {
  private observerAddress: string;
  private referenceGatewayHost: string;
  private observedGatewayHosts: string[];
  private prescribedNamesSource: ArnsNamesSource;
  private chosenNamesSource: ArnsNamesSource;

  constructor({
    observerAddress,
    prescribedNamesSource,
    chosenNamesSource,
    referenceGatewayHost,
    observedGatewayHosts,
  }: {
    observerAddress: string;
    referenceGatewayHost: string;
    observedGatewayHosts: string[];
    prescribedNamesSource: ArnsNamesSource;
    chosenNamesSource: ArnsNamesSource;
  }) {
    this.observerAddress = observerAddress;
    this.referenceGatewayHost = referenceGatewayHost;
    this.observedGatewayHosts = observedGatewayHosts;
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

    // TODO fix timings
    return {
      assessedAt: +(Date.now() / 1000).toFixed(0),
      resolvedId: gatewayResolution.resolvedId,
      dataHash: gatewayResolution.dataHashDigest,
      pass,
      timings: gatewayResolution.timings.phases,
    };
  }

  async assessArnsNames(names: string[]): Promise<ArnsNameAssessments> {
    return Promise.all(
      names.map((name) => {
        return this.assessArnsName({
          host: this.referenceGatewayHost,
          arnsName: name,
        });
      }),
    ).then((assessments) => {
      return assessments.reduce((acc, assessment, index) => {
        acc[names[index]] = assessment;
        return acc;
      }, {} as ArnsNameAssessments);
    });
  }

  async generateReport(): Promise<ObserverReport> {
    const prescribedNames = await this.prescribedNamesSource.getNames();
    const chosenNames = await this.chosenNamesSource.getNames();

    // Assess gateway
    const arnsAssessments: ArnsAssessments = {};
    for (const gatewayAddress of this.observedGatewayHosts) {
      arnsAssessments[gatewayAddress] = {
        prescribedNames: await this.assessArnsNames(prescribedNames),
        chosenNames: await this.assessArnsNames(chosenNames),
      };
    }

    return {
      observerAddress: this.observerAddress,
      generatedAt: +(Date.now() / 1000).toFixed(0),
      arnsAssessments,
    };
  }
}
