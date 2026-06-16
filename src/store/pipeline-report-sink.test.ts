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
import * as sinon from 'sinon';
import * as winston from 'winston';

import { ObserverReport, ReportInfo, ReportSink } from '../types.js';
import { PipelineReportSink, ReportSinkEntry } from './pipeline-report-sink.js';

describe('PipelineReportSink', function () {
  let logStub: winston.Logger;
  let pipelineReportSink: PipelineReportSink;
  let mockSink1: ReportSink;
  let mockSink2: ReportSink;
  let mockSink3: ReportSink;

  beforeEach(function () {
    logStub = {
      child: sinon.stub().returnsThis(),
      debug: sinon.stub(),
      verbose: sinon.stub(),
      error: sinon.stub(),
    } as any;

    mockSink1 = {
      saveReport: sinon.stub().callsFake(async (reportInfo) => ({
        ...reportInfo,
        sink1Processed: true,
      })),
    };

    mockSink2 = {
      saveReport: sinon.stub().callsFake(async (reportInfo) => ({
        ...reportInfo,
        sink2Processed: true,
      })),
    };

    mockSink3 = {
      saveReport: sinon.stub().callsFake(async (reportInfo) => ({
        ...reportInfo,
        sink3Processed: true,
      })),
    };
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
      observerAddress: 'test-observer-address',
      epochIndex: 1,
      epochStartTimestamp: 1000000,
      epochStartHeight: 100,
      epochEndTimestamp: 2000000,
      generatedAt: 1500000,
      gatewayAssessments,
    };
  }

  describe('constructor', function () {
    it('should create a PipelineReportSink instance', function () {
      const sinks: ReportSinkEntry[] = [
        { name: 'sink1', sink: mockSink1 },
        { name: 'sink2', sink: mockSink2 },
      ];

      pipelineReportSink = new PipelineReportSink({
        log: logStub,
        sinks,
      });

      expect(pipelineReportSink).to.be.instanceOf(PipelineReportSink);
      expect(
        (logStub.child as sinon.SinonStub).calledWith({
          class: 'PipelineReportSink',
        }),
      ).to.be.true;
    });
  });

  describe('saveReport - threshold logic', function () {
    it('should process all sinks when failure is below the default threshold', async function () {
      const sinks: ReportSinkEntry[] = [
        { name: 'sink1', sink: mockSink1 },
        { name: 'sink2', sink: mockSink2 },
      ];

      pipelineReportSink = new PipelineReportSink({
        log: logStub,
        sinks,
      });

      // 50% failure rate (5 out of 10)
      const report = createMockReport(10, 5);
      const reportInfo: ReportInfo = { report };

      const result = await pipelineReportSink.saveReport(reportInfo);

      expect((mockSink1.saveReport as sinon.SinonStub).calledOnce).to.be.true;
      expect((mockSink2.saveReport as sinon.SinonStub).calledOnce).to.be.true;
      expect((logStub.error as sinon.SinonStub).called).to.be.false;
      expect(result).to.have.property('sink1Processed', true);
      expect(result).to.have.property('sink2Processed', true);
    });

    it('should process all sinks at exactly the default 95% threshold', async function () {
      const sinks: ReportSinkEntry[] = [
        { name: 'sink1', sink: mockSink1 },
        { name: 'sink2', sink: mockSink2 },
      ];

      // No explicit threshold → exercises the 0.95 default. `>` semantics mean
      // exactly-at-threshold still forwards.
      pipelineReportSink = new PipelineReportSink({
        log: logStub,
        sinks,
      });

      // 95% failure rate (19 out of 20) — exactly the default, so it forwards.
      const report = createMockReport(20, 19);
      const reportInfo: ReportInfo = { report };

      const result = await pipelineReportSink.saveReport(reportInfo);

      expect((mockSink1.saveReport as sinon.SinonStub).calledOnce).to.be.true;
      expect((mockSink2.saveReport as sinon.SinonStub).calledOnce).to.be.true;
      expect((logStub.error as sinon.SinonStub).called).to.be.false;
      expect(result).to.have.property('sink1Processed', true);
      expect(result).to.have.property('sink2Processed', true);
    });

    it('should skip all sinks when failure exceeds the default 95% threshold', async function () {
      const sinks: ReportSinkEntry[] = [
        { name: 'sink1', sink: mockSink1 },
        { name: 'sink2', sink: mockSink2 },
      ];

      // No explicit threshold → exercises the 0.95 default.
      pipelineReportSink = new PipelineReportSink({
        log: logStub,
        sinks,
      });

      // 96% failure rate (96 out of 100) — above the 0.95 default.
      const report = createMockReport(100, 96);
      const reportInfo: ReportInfo = { report };

      const result = await pipelineReportSink.saveReport(reportInfo);

      expect((mockSink1.saveReport as sinon.SinonStub).called).to.be.false;
      expect((mockSink2.saveReport as sinon.SinonStub).called).to.be.false;
      expect((logStub.error as sinon.SinonStub).calledOnce).to.be.true;

      const errorCall = (logStub.error as sinon.SinonStub).firstCall;
      expect(errorCall.args[0]).to.include('More than 95% of gateways failed');
      expect(errorCall.args[0]).to.include(
        'Please check your observer configuration',
      );
      expect(errorCall.args[1]).to.deep.include({
        totalGateways: 100,
        failedGateways: 96,
        failurePercentage: '96.00%',
        threshold: '95%',
      });

      expect(result).to.equal(reportInfo);
    });

    it('should skip all sinks when all gateways fail', async function () {
      const sinks: ReportSinkEntry[] = [
        { name: 'sink1', sink: mockSink1 },
        { name: 'sink2', sink: mockSink2 },
      ];

      pipelineReportSink = new PipelineReportSink({
        log: logStub,
        sinks,
      });

      // 100% failure rate (10 out of 10)
      const report = createMockReport(10, 10);
      const reportInfo: ReportInfo = { report };

      const result = await pipelineReportSink.saveReport(reportInfo);

      expect((mockSink1.saveReport as sinon.SinonStub).called).to.be.false;
      expect((mockSink2.saveReport as sinon.SinonStub).called).to.be.false;
      expect((logStub.error as sinon.SinonStub).calledOnce).to.be.true;
      expect(result).to.equal(reportInfo);
    });

    it('honors a custom maxGatewayFailureThreshold below the default', async function () {
      // Threshold 0.5 → 60% failure should trip; 50% should pass.
      const sinks: ReportSinkEntry[] = [{ name: 'sink1', sink: mockSink1 }];
      pipelineReportSink = new PipelineReportSink({
        log: logStub,
        sinks,
        maxGatewayFailureThreshold: 0.5,
      });
      // 60% failure (6/10) — above threshold 0.5, should drop.
      const report = createMockReport(10, 6);
      const result = await pipelineReportSink.saveReport({ report });
      expect((mockSink1.saveReport as sinon.SinonStub).called).to.be.false;
      expect((logStub.error as sinon.SinonStub).calledOnce).to.be.true;
      const errCall = (logStub.error as sinon.SinonStub).firstCall;
      expect(errCall.args[0]).to.include('More than 50% of gateways failed');
      expect(errCall.args[1]).to.deep.include({ threshold: '50%' });
      expect(result.report).to.equal(report); // unchanged passthrough
    });

    it('disables the gate when maxGatewayFailureThreshold = 1.0 (forwards 100% failure reports)', async function () {
      // On devnet with stub gateways, the operator sets the threshold
      // to 1.0 so honest "everything is broken" reports still ship.
      // With `>` semantics, 1.0 can never trip (100% > 1.0 is false).
      const sinks: ReportSinkEntry[] = [
        { name: 'sink1', sink: mockSink1 },
        { name: 'sink2', sink: mockSink2 },
      ];
      pipelineReportSink = new PipelineReportSink({
        log: logStub,
        sinks,
        maxGatewayFailureThreshold: 1.0,
      });
      const report = createMockReport(10, 10); // 100% failures
      await pipelineReportSink.saveReport({ report });
      expect((mockSink1.saveReport as sinon.SinonStub).calledOnce).to.be.true;
      expect((mockSink2.saveReport as sinon.SinonStub).calledOnce).to.be.true;
      expect((logStub.error as sinon.SinonStub).called).to.be.false;
    });

    it('handles an empty gateway-assessments map without crashing (no divide-by-zero)', async function () {
      const sinks: ReportSinkEntry[] = [{ name: 'sink1', sink: mockSink1 }];
      pipelineReportSink = new PipelineReportSink({ log: logStub, sinks });
      const report = createMockReport(0, 0); // no gateways
      await pipelineReportSink.saveReport({ report });
      // 0/0 is treated as 0% failure — should forward, not trip.
      expect((mockSink1.saveReport as sinon.SinonStub).calledOnce).to.be.true;
      expect((logStub.error as sinon.SinonStub).called).to.be.false;
    });
  });

  describe('saveReport - pipeline functionality', function () {
    it('should process reports through all sinks in order', async function () {
      const sinks: ReportSinkEntry[] = [
        { name: 'sink1', sink: mockSink1 },
        { name: 'sink2', sink: mockSink2 },
        { name: 'sink3', sink: mockSink3 },
      ];

      pipelineReportSink = new PipelineReportSink({
        log: logStub,
        sinks,
      });

      const report = createMockReport(10, 2); // 20% failure rate
      const reportInfo: ReportInfo = { report };

      const result = await pipelineReportSink.saveReport(reportInfo);

      // Verify all sinks were called in order
      expect((mockSink1.saveReport as sinon.SinonStub).calledOnce).to.be.true;
      expect((mockSink2.saveReport as sinon.SinonStub).calledOnce).to.be.true;
      expect((mockSink3.saveReport as sinon.SinonStub).calledOnce).to.be.true;

      // Verify each sink received the output from the previous sink
      const sink1Call = (mockSink1.saveReport as sinon.SinonStub).firstCall;
      expect(sink1Call.args[0]).to.deep.equal(reportInfo);

      const sink2Call = (mockSink2.saveReport as sinon.SinonStub).firstCall;
      expect(sink2Call.args[0]).to.have.property('sink1Processed', true);

      const sink3Call = (mockSink3.saveReport as sinon.SinonStub).firstCall;
      expect(sink3Call.args[0]).to.have.property('sink1Processed', true);
      expect(sink3Call.args[0]).to.have.property('sink2Processed', true);

      // Verify final result has all processing flags
      expect(result).to.have.property('sink1Processed', true);
      expect(result).to.have.property('sink2Processed', true);
      expect(result).to.have.property('sink3Processed', true);
    });

    it('should continue processing even if one sink fails', async function () {
      const failingSink: ReportSink = {
        saveReport: sinon.stub().rejects(new Error('Sink failed')),
      };

      const sinks: ReportSinkEntry[] = [
        { name: 'sink1', sink: mockSink1 },
        { name: 'failingSink', sink: failingSink },
        { name: 'sink3', sink: mockSink3 },
      ];

      pipelineReportSink = new PipelineReportSink({
        log: logStub,
        sinks,
      });

      const report = createMockReport(10, 2); // 20% failure rate
      const reportInfo: ReportInfo = { report };

      const result = await pipelineReportSink.saveReport(reportInfo);

      // Verify all sinks were attempted
      expect((mockSink1.saveReport as sinon.SinonStub).calledOnce).to.be.true;
      expect((failingSink.saveReport as sinon.SinonStub).calledOnce).to.be.true;
      expect((mockSink3.saveReport as sinon.SinonStub).calledOnce).to.be.true;

      // Verify error was logged
      expect((logStub.error as sinon.SinonStub).calledOnce).to.be.true;
      const errorCall = (logStub.error as sinon.SinonStub).firstCall;
      expect(errorCall.args[0]).to.equal(
        'Error saving report using failingSink',
      );

      // Verify final result includes successful processing flags
      expect(result).to.have.property('sink1Processed', true);
      expect(result).to.have.property('sink3Processed', true);
    });

    it('should handle empty sinks array', async function () {
      pipelineReportSink = new PipelineReportSink({
        log: logStub,
        sinks: [],
      });

      const report = createMockReport(10, 2);
      const reportInfo: ReportInfo = { report };

      const result = await pipelineReportSink.saveReport(reportInfo);

      expect(result).to.equal(reportInfo);
    });

    it('should set child logger with report metadata', async function () {
      const sinks: ReportSinkEntry[] = [{ name: 'sink1', sink: mockSink1 }];

      pipelineReportSink = new PipelineReportSink({
        log: logStub,
        sinks,
      });

      const report = createMockReport(10, 2);
      const reportInfo: ReportInfo = { report };

      await pipelineReportSink.saveReport(reportInfo);

      expect(
        (logStub.child as sinon.SinonStub).calledWith({
          epochStartTimestamp: report.epochStartTimestamp,
          epochIndex: report.epochIndex,
          epochStartHeight: report.epochStartHeight,
        }),
      ).to.be.true;
    });
  });
});
