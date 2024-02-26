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
import { expect } from 'chai';
import nock from 'nock';

import { interactionAlreadySaved } from './contract-report-sink.js';

const observerWallet = 'test';
const epochStartHeight = 1234567890;
const contractCacheUrl = 'http://example.com';
const contractId = '123';
const networkCallPath = `/v1/contract/${contractId}/state/observations/${epochStartHeight}/failureSummaries`;

const failedGatewaySummaries = [
  'gateway-address',
  'gateway-address2',
  'gateway-address3',
];

describe('interactionAlreadySaved', function () {
  beforeEach(function () {
    nock.cleanAll();
  });

  it('should return true if all the failure gateway summaries are in the contract state', async function () {
    nock(contractCacheUrl)
      .get(networkCallPath)
      .reply(200, {
        contractTxId: '123',
        result: {
          [failedGatewaySummaries[0]]: [observerWallet],
          [failedGatewaySummaries[1]]: [observerWallet],
          [failedGatewaySummaries[2]]: [observerWallet],
        },
      });

    const result = await interactionAlreadySaved({
      observerWallet,
      epochStartHeight,
      failedGatewaySummaries,
      contractCacheUrl,
      contractId,
    });

    expect(result).to.be.true;
  });

  it('should return false if all failure gateway summary is not in the contract state', async function () {
    nock(contractCacheUrl)
      .get(networkCallPath)
      .reply(200, {
        contractTxId: '123',
        result: {
          [failedGatewaySummaries[0]]: ['observer'],
          [failedGatewaySummaries[1]]: ['another-observer'],
          [failedGatewaySummaries[2]]: ['yet-another-observer'],
        },
      });

    const result = await interactionAlreadySaved({
      observerWallet,
      epochStartHeight,
      failedGatewaySummaries,
      contractCacheUrl,
      contractId,
    });

    expect(result).to.be.false;
  });

  it('should return false if only some of the observer wallets match', async function () {
    nock(contractCacheUrl)
      .get(networkCallPath)
      .reply(200, {
        contractTxId: '123',
        result: {
          [failedGatewaySummaries[0]]: [observerWallet],
          [failedGatewaySummaries[1]]: ['another-observer'],
          [failedGatewaySummaries[2]]: ['yet-another-observer'],
        },
      });

    const result = await interactionAlreadySaved({
      observerWallet,
      epochStartHeight,
      failedGatewaySummaries,
      contractCacheUrl,
      contractId,
    });

    expect(result).to.be.false;
  });

  it('should return true when failedGatewaySummaries array is empty', async function () {
    nock(contractCacheUrl)
      .get(networkCallPath)
      .reply(200, { contractTxId: '123', result: {} });

    const result = await interactionAlreadySaved({
      observerWallet,
      epochStartHeight,
      failedGatewaySummaries: [],
      contractCacheUrl,
      contractId,
    });

    expect(result).to.be.true;
  });

  it('should return false when there are no observations for the provided failure gateway summaries', async function () {
    nock(contractCacheUrl)
      .get(networkCallPath)
      .reply(200, { contractTxId: '123', result: {} });

    const result = await interactionAlreadySaved({
      observerWallet,
      epochStartHeight,
      failedGatewaySummaries,
      contractCacheUrl,
      contractId,
    });

    expect(result).to.be.false;
  });

  it('should gracefully handle network errors', async function () {
    nock(contractCacheUrl).get(networkCallPath).replyWithError('Network error');

    try {
      await interactionAlreadySaved({
        observerWallet,
        epochStartHeight,
        failedGatewaySummaries,
        contractCacheUrl,
        contractId,
      });
    } catch (error: any) {
      expect(error.message).to.include('Network error');
    }
  });

  it('should handle invalid JSON response gracefully', async function () {
    nock(contractCacheUrl).get(networkCallPath).reply(200, 'Invalid JSON');

    try {
      await interactionAlreadySaved({
        observerWallet,
        epochStartHeight,
        failedGatewaySummaries,
        contractCacheUrl,
        contractId,
      });
    } catch (error) {
      expect(error).to.exist;
    }
  });
});
