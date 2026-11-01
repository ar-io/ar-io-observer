/**
 * AR.IO Observer
 * Copyright (C) 2022-2026 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { expect } from 'chai';
import * as sinon from 'sinon';
import * as winston from 'winston';

import { GatewayAssessor } from './gateway-assessor.js';

describe('GatewayAssessor', () => {
  describe('assessArnsNames', () => {
    it('leaves out names that are not valid hostname labels', async () => {
      const referenceGateway = {
        getArnsResolution: sinon.stub(),
        checkChunkAvailability: sinon.stub(),
        getChunkMetadata: sinon.stub(),
      };
      const assessor = new GatewayAssessor({
        referenceGateway,
        nodeReleaseVersion: 'test-version',
        nameAssessmentConcurrency: 1,
        log: winston.createLogger({ silent: true }),
      });

      // punycode for U+25B6 U+FE0F, rejected by the URL parser
      const assessments = await assessor.assessArnsNames({
        host: 'gateway.example.com',
        names: ['xn--g1h4420f'],
      });

      expect(assessments).to.deep.equal({});
      expect(referenceGateway.getArnsResolution.called).to.equal(false);
    });
  });
});
