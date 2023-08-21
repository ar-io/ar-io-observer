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
import Ajv from 'ajv';
import got from 'got';
import crypto from 'node:crypto';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

const ajv = new Ajv();

interface ArnsNameAssessment {
  resolvedId: string;
  dataHash: string;
  assessedAt: number;
  pass: boolean;
}

interface ArnsNameAssessments {
  [name: string]: ArnsNameAssessment;
}

interface ArnsAssessments {
  [host: string]: {
    prescribedNames: ArnsNameAssessments;
    chosenNames: ArnsNameAssessments;
  };
}

interface ObserverReport {
  observerAddress: string;
  generatedAt: number;
  arnsAssessments: ArnsAssessments;
}

const observerReportSchema = {
  type: 'object',
  properties: {
    observerAddress: { $ref: '#/$defs/arweaveAddress' },
    generatedAt: { $ref: '#/$defs/timestamp' },
    arnsAssessments: { $ref: '#/$defs/arnsAssessments' },
  },
  required: ['arnsAssessments'],
  additionalProperties: true,
  $defs: {
    arweaveAddress: {
      type: 'string',
    },
    arweaveId: {
      type: 'string',
    },
    timestamp: {
      type: 'integer',
    },
    pass: {
      type: 'boolean',
    },
    arnsAssessment: {
      type: 'object',
      properties: {
        resolvedId: { $ref: '#/$defs/arweaveId' },
        assessedAt: { $ref: '#/$defs/timestamp' },
        pass: { $ref: '#/$defs/pass' },
      },
      additionalProperties: true,
    },
    arnsAssessments: {
      type: 'object',
      patternProperties: {
        '.*': {
          type: 'object',
          properties: {
            prescribedNames: {
              type: 'object',
              patternProperties: {
                '.*': { $ref: '#/$defs/arnsAssessment' },
              },
            },
            chosenNames: {
              type: 'object',
              patternProperties: {
                '.*': { $ref: '#/$defs/arnsAssessment' },
              },
            },
          },
        },
      },
    },
    /* TODO uncomment when we add report assessments 
    reportAssessment: {
      type: "object",
      properties: {
        pass: { $ref: "#/$defs/pass" },
        reasons: {
          type: "array",
          items: {
            type: "object",
            properties: {
              description: { type: "string" },
            },
          },
        },
      },
      additionalProperties: true,
    },
    reportAssessments: {
      type: "object",
      patternProperties: {
        ".*": { $ref: "#/$defs/reportAssessment" },
      },
    },
    */
  },
};

// NOTE addresses and timestamps are for convience only the chain is the authority
const exampleReport = {
  observerAddress: 'xxxx',
  generatedAt: 1234567890,
  arnsAssessments: {
    'example-gateway.net': {
      prescribedNames: {
        'example-name-1': {
          resolvedId: 'xxxx',
          assessedAt: 1234567890,
          pass: false,
        },
        // 9 more names
      },
      chosenNames: {
        'example-name-2': {
          resolvedId: 'xxxx',
          assessedAt: 1234567890,
          pass: true,
        },
        // 39 more names
      },
    },
  },
  /* TODO uncomment when we add report assessments
  reportAssessments: {
    "example-address-1": {
      pass: false,
      reasons: [
        {
          description: "An example reason",
        },
      ],
    },
  },
  */
};

//const validate = ajv.compile(observerReportSchema);
const valid = ajv.validate(observerReportSchema, exampleReport);
if (!valid) console.log(ajv.errors);

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

interface ArnsNamesSource {
  getNames(): Promise<string[]>;
}

class StaticArnsNamesSource implements ArnsNamesSource {
  private addresses: string[];

  constructor(addresses: string[]) {
    this.addresses = addresses;
  }

  async getNames(): Promise<string[]> {
    return this.addresses;
  }
}

class Observer {
  private observerAddress: string;
  private prescribedNamesSource: ArnsNamesSource;
  private chosenNamesSource: ArnsNamesSource;
  private gatewayHosts: string[];
  private referenceGatewayHost: string;

  constructor({
    observerAddress,
    prescribedNamesSource,
    chosenNamesSource,
    gatewayHosts,
    referenceGatewayHost,
  }: {
    observerAddress: string;
    prescribedNamesSource: ArnsNamesSource;
    chosenNamesSource: ArnsNamesSource;
    gatewayHosts: string[];
    referenceGatewayHost: string;
  }) {
    this.observerAddress = observerAddress;
    this.prescribedNamesSource = prescribedNamesSource;
    this.chosenNamesSource = chosenNamesSource;
    this.gatewayHosts = gatewayHosts;
    this.referenceGatewayHost = referenceGatewayHost;
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

    return {
      resolvedId: gatewayResolution.resolvedId,
      dataHash: gatewayResolution.dataHashDigest,
      assessedAt: +(Date.now() / 1000).toFixed(0),
      pass,
      timings: gatewayResolution.timings.phases,
    };
  }

  async generateReport(): Promise<ObserverReport> {
    const prescribedNames = await this.prescribedNamesSource.getNames();
    const chosenNames = await this.chosenNamesSource.getNames();

    // Assess gateway
    const arnsAssessments: ArnsAssessments = {};
    for (const gatewayAddress of this.gatewayHosts) {
      // Assess prescribed names
      const prescribedAssessments: ArnsNameAssessments = {};
      for (const prescribedAddress of prescribedNames) {
        const arnsAssessment = await this.assessArnsName({
          host: gatewayAddress,
          arnsName: prescribedAddress,
        });
        prescribedAssessments[prescribedAddress] = arnsAssessment;
      }

      // Assess chosen names
      const chosenAssessments: ArnsNameAssessments = {};
      for (const chosenAddress of chosenNames) {
        const arnsAssessment = await this.assessArnsName({
          host: gatewayAddress,
          arnsName: chosenAddress,
        });
        chosenAssessments[chosenAddress] = arnsAssessment;
      }

      arnsAssessments[gatewayAddress] = {
        prescribedNames: prescribedAssessments,
        chosenNames: chosenAssessments,
      };
    }

    return {
      observerAddress: this.observerAddress,
      generatedAt: +(Date.now() / 1000).toFixed(0),
      arnsAssessments,
    };
  }
}

const args = await yargs(hideBin(process.argv))
  .option('prescribed-names', {
    type: 'string',
    description: 'Comma separated list of prescribed names',
  })
  .option('chosen-names', {
    type: 'string',
    description: 'Comma separated list of chosen names',
  })
  .option('gateway-hosts', {
    type: 'string',
    description: 'Comma separated list of gateway hosts',
  })
  .option('reference-gateway', {
    type: 'string',
    description: 'Reference gateway host',
  })
  .parse();

const prescribedNames = (
  typeof args.prescribedNames === 'string' ? args.prescribedNames : 'now'
).split(',');

const chosenNames = (
  typeof args.chosenNames === 'string' ? args.chosenNames : 'ardrive'
).split(',');

const gatewayHosts = (
  typeof args.gatewayHosts === 'string' ? args.gatewayHosts : 'arweave.dev'
).split(',');

const prescribedNamesSource = new StaticArnsNamesSource(prescribedNames);
const chosenNamesSource = new StaticArnsNamesSource(chosenNames);

const observer = new Observer({
  observerAddress: '<example>',
  prescribedNamesSource,
  chosenNamesSource,
  gatewayHosts,
  referenceGatewayHost: args.referenceGateway ?? 'arweave.dev',
});

observer.generateReport().then((report) => {
  console.log(JSON.stringify(report, null, 2));
});
