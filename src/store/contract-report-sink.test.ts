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
import { AoARIOWrite } from '@ar.io/sdk/node';
import { assert, expect } from 'chai';
import * as sinon from 'sinon';
import * as winston from 'winston';

import { ObserverReport } from '../types.js';
import { ContractReportSink } from './contract-report-sink.js';

describe('ContractReportSink', function () {
  let logStub: winston.Logger;
  let contractStub: AoARIOWrite;
  let contractReportSink: ContractReportSink;
  const walletAddress = 'test-wallet-address';

  beforeEach(function () {
    logStub = {
      debug: sinon.stub(),
      verbose: sinon.stub(),
      error: sinon.stub(),
    } as any;

    contractStub = {
      saveObservations: sinon.stub().resolves({ id: 'test-tx-id' }),
      getObservations: sinon.stub().resolves(undefined),
    } as any;

    contractReportSink = new ContractReportSink({
      log: logStub,
      contract: contractStub,
      walletAddress,
    });
  });

  afterEach(function () {
    sinon.restore();
  });

  function createMockReport(
    totalGateways: number,
    failedGateways: number,
  ): ObserverReport {
    const gatewayAssessments: any = {};

    // Create passing gateways
    for (let i = 0; i < totalGateways - failedGateways; i++) {
      gatewayAssessments[`gateway${i}.com`] = {
        ownershipAssessment: {
          expectedWallets: [`wallet${i}`],
          observedWallet: `wallet${i}`,
          pass: true,
        },
        arnsAssessments: {
          prescribedNames: {},
          chosenNames: {},
          pass: true,
        },
        pass: true,
      };
    }

    // Create failing gateways
    for (let i = totalGateways - failedGateways; i < totalGateways; i++) {
      gatewayAssessments[`gateway${i}.com`] = {
        ownershipAssessment: {
          expectedWallets: [`wallet${i}`],
          observedWallet: null,
          failureReason: 'Test failure',
          pass: false,
        },
        arnsAssessments: {
          prescribedNames: {},
          chosenNames: {},
          pass: false,
        },
        pass: false,
      };
    }

    return {
      formatVersion: 2,
      observerAddress: walletAddress,
      epochIndex: 1,
      epochStartTimestamp: 1000000,
      epochStartHeight: 100,
      epochEndTimestamp: 2000000,
      generatedAt: 1500000,
      gatewayAssessments,
    };
  }

  describe('saveReport', function () {
    it('should save report normally when less than 80% of gateways fail', async function () {
      // Test with 50% failure rate (5 out of 10)
      const report = createMockReport(10, 5);
      const reportInfo = { report, reportTxId: 'test-report-tx-id' };

      const result = await contractReportSink.saveReport(reportInfo);

      expect(result.interactionTxIds).to.include('test-tx-id');
      expect((contractStub.saveObservations as sinon.SinonStub).called).to.be
        .true;
      expect((logStub.error as sinon.SinonStub).called).to.be.false;
    });

    it('should save report when exactly 80% of gateways fail', async function () {
      // Test with 80% failure rate (8 out of 10)
      const report = createMockReport(10, 8);
      const reportInfo = { report, reportTxId: 'test-report-tx-id' };

      const result = await contractReportSink.saveReport(reportInfo);

      expect(result.interactionTxIds).to.include('test-tx-id');
      expect((contractStub.saveObservations as sinon.SinonStub).called).to.be
        .true;
      expect((logStub.error as sinon.SinonStub).called).to.be.false;
    });

    it('should save report when more than 80% of gateways fail', async function () {
      // Test with 90% failure rate (9 out of 10) - threshold check moved to pipeline
      const report = createMockReport(10, 9);
      const reportInfo = { report, reportTxId: 'test-report-tx-id' };

      const result = await contractReportSink.saveReport(reportInfo);

      expect(result.interactionTxIds).to.include('test-tx-id');
      expect((contractStub.saveObservations as sinon.SinonStub).called).to.be
        .true;
      expect((logStub.error as sinon.SinonStub).called).to.be.false;
    });

    it('should save report when all gateways fail', async function () {
      // Test with 100% failure rate (10 out of 10) - threshold check moved to pipeline
      const report = createMockReport(10, 10);
      const reportInfo = { report, reportTxId: 'test-report-tx-id' };

      const result = await contractReportSink.saveReport(reportInfo);

      expect(result.interactionTxIds).to.include('test-tx-id');
      expect((contractStub.saveObservations as sinon.SinonStub).called).to.be
        .true;
      expect((logStub.error as sinon.SinonStub).called).to.be.false;
    });

    it('should handle edge case with single gateway', async function () {
      // Test with 1 gateway failing (100% failure rate) - threshold check moved to pipeline
      const report = createMockReport(1, 1);
      const reportInfo = { report, reportTxId: 'test-report-tx-id' };

      const result = await contractReportSink.saveReport(reportInfo);

      expect(result.interactionTxIds).to.include('test-tx-id');
      expect((contractStub.saveObservations as sinon.SinonStub).called).to.be
        .true;
      expect((logStub.error as sinon.SinonStub).called).to.be.false;
    });

    it('should handle edge case with zero gateways', async function () {
      const report = createMockReport(0, 0);
      const reportInfo = { report, reportTxId: 'test-report-tx-id' };

      const result = await contractReportSink.saveReport(reportInfo);

      // With zero gateways, failurePercentage is NaN (0/0), and NaN > 0.8 is false
      // Since no gateways failed, splitFailedGatewaySummaries will be empty, so no saves
      expect(result.interactionTxIds).to.deep.equal([]);
      expect((contractStub.saveObservations as sinon.SinonStub).called).to.be
        .false;
    });

    it('should handle reports without reportTxId when threshold not exceeded', async function () {
      const report = createMockReport(10, 5);
      const reportInfo = { report };

      try {
        await contractReportSink.saveReport(reportInfo);
        assert.fail('Should have thrown an error');
      } catch (error: any) {
        expect(error.message).to.equal('Report TX ID is undefined');
      }
    });

    it('should check if interaction already saved before processing', async function () {
      (contractStub.getObservations as sinon.SinonStub).resolves({
        failureSummaries: {
          wallet5: [walletAddress],
          wallet6: [walletAddress],
          wallet7: [walletAddress],
          wallet8: [walletAddress],
          wallet9: [walletAddress],
        },
      });

      const report = createMockReport(10, 5);
      const reportInfo = { report, reportTxId: 'test-report-tx-id' };

      const result = await contractReportSink.saveReport(reportInfo);

      expect(result).to.equal(reportInfo);
      expect((contractStub.saveObservations as sinon.SinonStub).called).to.be
        .false;
      expect(
        (logStub.verbose as sinon.SinonStub).calledWith(
          'Observation interactions already saved',
        ),
      ).to.be.true;
    });
  });
});
