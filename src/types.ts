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

//
// Arweave
//
export interface BlockSource {
  getBlockByHeight(height: number): Promise<any>; // TODO fix any
}

export interface HeightSource {
  getHeight(): Promise<number>;
}

//
// Epochs
//

export interface EpochTimestampParams {
  epochStartTimestamp: number;
  epochStartHeight: number;
  epochEndTimestamp: number;
  epochIndex: number;
}

// deprecated
export interface EpochHeightSource {
  getEpochStartHeight(): Promise<number>;
  getEpochEndHeight(): Promise<number>;
}

export interface EpochTimestampSource {
  getEpochStartHeight(): Promise<number>;
  getEpochStartTimestamp(): Promise<number>;
  getEpochEndTimestamp(): Promise<number>;
  getEpochIndex(): Promise<number>;
}

//
// Name selection
//

export interface EntropySource {
  getEntropy(opts?: { [key: string]: any }): Promise<Buffer>;
}

export interface ArnsNameList {
  getNamesCount(height: number): Promise<number>;
  getName(height: number, index: number): Promise<string>;
  getAllNames(height: number): Promise<string[]>;
}

export interface ArnsNamesSource {
  getNames(opts?: { [key: string]: any }): Promise<string[]>;
}

//
// Gateways
//

export interface GatewayHost {
  start?: number;
  end?: number;
  fqdn: string;
  port?: number;
  protocol?: string;
  wallet: string;
}

export interface GatewayHostsSource {
  getHosts(): Promise<GatewayHost[]>;
}

//
// Observer report
//

export interface OwnershipAssessment {
  expectedWallets: string[];
  observedWallet: string | null;
  failureReason?: string;
  pass: boolean;
}

export interface ArnsNameAssessment {
  assessedAt: number;
  expectedStatusCode?: number;
  resolvedStatusCode?: number;
  expectedId: string | null;
  resolvedId: string | null;
  expectedDataHash: string | null;
  resolvedDataHash: string | null;
  pass: boolean;
  failureReason?: string;
  timings?: {
    wait?: number;
    dns?: number;
    tcp?: number;
    tls?: number;
    firstByte?: number;
    download?: number;
    total?: number;
  };
}

export interface ArnsNameAssessments {
  [arnsName: string]: ArnsNameAssessment;
}

export interface GatewayArnsAssessments {
  prescribedNames: ArnsNameAssessments;
  chosenNames: ArnsNameAssessments;
  pass: boolean;
}

export interface GatewayAssessments {
  [gatewayHost: string]: {
    ownershipAssessment: OwnershipAssessment;
    arnsAssessments: GatewayArnsAssessments;
    pass: boolean;
  };
}

export interface ObserverReport {
  formatVersion: number;
  observerAddress: string;
  epochStartTimestamp: number;
  epochEndTimestamp: number;
  epochStartHeight: number;
  epochIndex: number;
  generatedAt: number;
  gatewayAssessments: GatewayAssessments;
}

//
// Report store and sink
//

export interface ReportInfo {
  report: ObserverReport;
  reportTxId?: string;
  interactionTxIds?: string[];
}

export interface ReportSink {
  saveReport(reportInfo: ReportInfo): Promise<ReportInfo>;
}

export interface ReportStore {
  saveReport(reportInfo: ReportInfo): Promise<ReportInfo>;
  getReport(epochStartHeight: number): Promise<ObserverReport | null>;
  latestReport(): Promise<ObserverReport | null>;
}
