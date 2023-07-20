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
import Ajv from "ajv";

const ajv = new Ajv();

const observerReportschema = {
  type: "object",
  properties: {
    reporterAddress: { $ref: "#/$defs/arweaveAddress" },
    generatedAt: { $ref: "#/$defs/timestamp" },
    arnsAssessments: { $ref: "#/$defs/arnsAssessments" },
  },
  required: ["reporterAddress", "generatedAt", "arnsAssessments"],
  additionalProperties: false,
  $defs: {
    arweaveAddress: {
      type: "string",
    },
    arweaveId: {
      type: "string",
    },
    timestamp: {
      type: "integer",
    },
    arnsName: {
      type: "string",
    },
    hostName: {
      type: "string",
    },
    qosScore: {
      type: "number",
      // TODO what range should we use - 0-1? 0-100?
    },
    pass: {
      type: "boolean",
    },
    arnsAssessment: {
      type: "object",
      properties: {
        resolvedId: { $ref: "#/$defs/arweaveId" },
        assessedAt: { $ref: "#/$defs/timestamp" },
        pass: { $ref: "#/$defs/pass" },
        qosScore: { $ref: "#/$defs/qosScore" },
      },
      additionalProperties: false,
    },
    arnsAssessments: {
      type: "object",
      patternProperties: {
        ".*": {
          type: "object",
          properties: {
            prescribedNames: {
              type: "object",
              patternProperties: {
                ".*": { $ref: "#/$defs/arnsAssessment" },
              },
            },
          },
        },
      },
    },
  },
};

// NOTE addresses and timestamps are for convience only the chain is the authority
const exampleReport = {
  reporterAddress: "xxxx",
  generatedAt: 1234567890,
  arnsAssessments: {
    "example-gateway.net": {
      prescribedNames: {
        "example-name-1": {
          resolvedId: "xxxx",
          assessedAt: 1234567890,
          pass: false,
          qosScore: 0.2,
        },
        // 9 more names
      },
      chosenNames: {
        "example-name-2": {
          resolvedId: "xxxx",
          assessedAt: 1234567890,
          pass: true,
          qosScore: 0.8,
        },
        // 39 more names
      },
    },
  },
};

const valid = ajv.validate(observerReportschema, exampleReport);
if (!valid) console.log(ajv.errors);
