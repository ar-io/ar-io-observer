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
// Observer report
//

export interface ArnsNameAssessment {
  resolvedId: string;
  dataHash: string;
  assessedAt: number;
  pass: boolean;
}

export interface ArnsNameAssessments {
  [arnsName: string]: ArnsNameAssessment;
}

export interface ArnsAssessments {
  [gatewayHost: string]: {
    prescribedNames: ArnsNameAssessments;
    chosenNames: ArnsNameAssessments;
  };
}

export interface ObserverReport {
  observerAddress: string;
  generatedAt: number;
  arnsAssessments: ArnsAssessments;
}

//
// Name selection
//

interface EntropySource {
  getEntropy(): Promise<Buffer>;
}

interface ArnsNameList {
  getNamesCount(): Promise<number>;
  getName(index: number): Promise<string>;
}

interface ArnsNamesSource {
  getNames(): Promise<string[]>;
}
