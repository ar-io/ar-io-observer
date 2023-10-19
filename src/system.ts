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
import { default as NodeCache } from 'node-cache';

import { ChainSource } from './arweave.js';
import * as config from './config.js';
import { CachedEntropySource } from './entropy/cached-entropy-source.js';
import { ChainEntropySource } from './entropy/chain-entropy-source.js';
import { CompositeEntropySource } from './entropy/composite-entropy-source.js';
import { RandomEntropySource } from './entropy/random-entropy-source.js';
import { RemoteCacheHostList } from './hosts/remote-cache-host-list.js';
import { StaticHostList } from './hosts/static-host-list.js';
import { RandomArnsNamesSource } from './names/random-arns-names-source.js';
import { RemoteCacheArnsNameList } from './names/remote-cache-arns-name-list.js';
import { StaticArnsNameList } from './names/static-arns-name-list.js';
import { Observer } from './observer.js';
import { RandomObserversSource } from './observers/random-observers-source.js';
import { EPOCH_BLOCK_LENGTH, EpochHeightSource } from './protocol.js';
import { FsReportStore } from './store/fs-report-store.js';
import { PublishFromObservation } from './warp.js';

const REPORT_CACH_TTL_SECS = 60 * 60; // 1 hour

const observedGatewayHostList =
  config.OBSERVED_GATEWAY_HOSTS.length > 0
    ? new StaticHostList({
        hosts: config.OBSERVED_GATEWAY_HOSTS.map((fqdn) => ({
          fqdn,
          wallet: '<unknown>',
        })),
      })
    : new RemoteCacheHostList({
        baseCacheUrl: config.CONTRACT_CACHE_URL,
        contractId: config.CONTRACT_ID,
      });

const chainSource = new ChainSource({
  arweaveBaseUrl: config.ARWEAVE_URL,
});

export const epochHeightSelector = new EpochHeightSource({
  heightSource: chainSource,
});

const remoteCacheArnsNameList =
  config.ARNS_NAMES.length > 0
    ? new StaticArnsNameList({
        names: config.ARNS_NAMES,
      })
    : new RemoteCacheArnsNameList({
        baseCacheUrl: config.CONTRACT_CACHE_URL,
        contractId: config.CONTRACT_ID,
      });

const chainEntropySource = new ChainEntropySource({
  arweaveBaseUrl: config.ARWEAVE_URL,
});

const prescribedNamesSource = new RandomArnsNamesSource({
  nameList: remoteCacheArnsNameList,
  entropySource: chainEntropySource,
  numNamesToSource: 1,
});

const randomEntropySource = new RandomEntropySource();

const cachedEntropySource = new CachedEntropySource({
  entropySource: randomEntropySource,
  cachePath: './tmp/entropy',
});

const compositeEntropySource = new CompositeEntropySource({
  sources: [cachedEntropySource, chainEntropySource],
});

const chosenNamesSource = new RandomArnsNamesSource({
  nameList: remoteCacheArnsNameList,
  entropySource: compositeEntropySource,
  numNamesToSource: 1,
});

export const observer = new Observer({
  observerAddress: config.OBSERVER_ADDRESS,
  referenceGatewayHost: config.REFERENCE_GATEWAY_HOST,
  epochHeightSource: epochHeightSelector,
  observedGatewayHostList,
  prescribedNamesSource,
  chosenNamesSource,
  gatewayAssessmentConcurrency: config.GATEWAY_ASSESSMENT_CONCURRENCY,
  nameAssessmentConcurrency: config.NAME_ASSESSMENT_CONCURRENCY,
});

export const chosenObserversSource = new RandomObserversSource({
  observedGatewayHostList: observedGatewayHostList,
  entropySource: compositeEntropySource,
  numObserversToSource: 50,
});

export const prescribedObserversSource = new RandomObserversSource({
  observedGatewayHostList: observedGatewayHostList,
  entropySource: chainEntropySource,
  numObserversToSource: 50,
});

export const publishObservation = new PublishFromObservation();

export const reportCache = new NodeCache({
  stdTTL: REPORT_CACH_TTL_SECS,
});

const reportStore = new FsReportStore({
  baseDir: './data/reports',
});

export async function updateCurrentReport() {
  try {
    const report = await observer.generateReport();
    reportCache.set('current', report);
    const entropy = await compositeEntropySource.getEntropy({
      height: report.epochStartHeight,
    });
    // Save the report after a random block between 100 blocks after
    // the start of the epoch and 100 blocks before the end of the
    // epoch
    const saveAfterHeight =
      report.epochStartHeight +
      ((entropy.readUInt32BE(0) % EPOCH_BLOCK_LENGTH) - 200);
    console.log('saveAfterHeight', saveAfterHeight);
    const currentHeight = await chainSource.getHeight();
    if (currentHeight >= saveAfterHeight) {
      console.log('Saving report', report.epochStartHeight);
      reportStore.saveReport(report);
    }
  } catch (error) {
    console.error('Error generating report', error);
  }
}
