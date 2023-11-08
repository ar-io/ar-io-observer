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
import {
  TurboAuthenticatedClient,
  TurboFactory,
  defaultTurboConfiguration,
} from '@ardrive/turbo-sdk/node';
import { ArweaveSigner } from 'arbundles/node';
import Arweave from 'arweave';
import { default as NodeCache } from 'node-cache';
import * as fs from 'node:fs';
import {
  JWKInterface,
  WarpFactory,
  defaultCacheOptions,
} from 'warp-contracts/mjs';

import { ChainSource } from './arweave.js';
import * as config from './config.js';
import { WarpContract } from './contract/warp-contract.js';
import { CachedEntropySource } from './entropy/cached-entropy-source.js';
import { ChainEntropySource } from './entropy/chain-entropy-source.js';
import { CompositeEntropySource } from './entropy/composite-entropy-source.js';
import { RandomEntropySource } from './entropy/random-entropy-source.js';
import { RemoteCacheHostList } from './hosts/remote-cache-host-list.js';
import { StaticHostList } from './hosts/static-host-list.js';
import log from './log.js';
import { RandomArnsNamesSource } from './names/random-arns-names-source.js';
import { RemoteCacheArnsNameList } from './names/remote-cache-arns-name-list.js';
import { StaticArnsNameList } from './names/static-arns-name-list.js';
import { Observer } from './observer.js';
import { RandomObserversSource } from './observers/random-observers-source.js';
import {
  EPOCH_BLOCK_LENGTH,
  EpochHeightSource,
  START_HEIGHT,
} from './protocol.js';
import { CompositeReportSink } from './store/composite-report-sink.js';
import { ContractReportSink } from './store/contract-report-sink.js';
import { FsReportStore } from './store/fs-report-store.js';
import { TurboReportSink } from './store/turbo-report-sink.js';
import { ReportSink } from './types.js';

const REPORT_CACHE_TTL_SECONDS = 60 * 60 * 2.5; // 2.5 hours

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
  cachePath: './data/tmp/observer/entropy',
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
  observerAddress: config.OBSERVER_WALLET,
  referenceGatewayHost: config.REFERENCE_GATEWAY_HOST,
  epochHeightSource: epochHeightSelector,
  observedGatewayHostList,
  prescribedNamesSource,
  chosenNamesSource,
  gatewayAssessmentConcurrency: config.GATEWAY_ASSESSMENT_CONCURRENCY,
  nameAssessmentConcurrency: config.NAME_ASSESSMENT_CONCURRENCY,
});

export const prescribedObserversSource = new RandomObserversSource({
  observedGatewayHostList: observedGatewayHostList,
  entropySource: chainEntropySource,
  numObserversToSource: 50,
});

export const reportCache = new NodeCache({
  stdTTL: REPORT_CACHE_TTL_SECONDS,
});

const fsReportStore = new FsReportStore({
  log,
  baseDir: './data/reports',
});

log.info(`Using wallet ${config.OBSERVER_WALLET}`);
export const walletJwk: JWKInterface | undefined = (() => {
  try {
    log.info('Loading key file...', {
      keyFile: config.KEY_FILE,
    });
    const jwk = JSON.parse(fs.readFileSync(config.KEY_FILE).toString());
    log.info('Key file loaded', {
      keyFile: config.KEY_FILE,
    });
    return jwk;
  } catch (error: any) {
    log.error('Unable to load key file:', {
      message: error.message,
    });
    log.warn('Reports will not be published to Arweave');
    return undefined;
  }
})();

export const turboClient: TurboAuthenticatedClient | undefined = (() => {
  if (walletJwk !== undefined) {
    return TurboFactory.authenticated({
      privateKey: walletJwk,
      ...defaultTurboConfiguration,
    });
  } else {
    return undefined;
  }
})();

const signer =
  walletJwk !== undefined ? new ArweaveSigner(walletJwk) : undefined;

export const arweave = new Arweave({
  host: 'arweave.net',
  port: 443,
  protocol: 'https',
});

const turboReportSink =
  turboClient && signer
    ? new TurboReportSink({
        log,
        arweave,
        turboClient: turboClient,
        walletAddress: config.OBSERVER_WALLET,
        signer,
      })
    : undefined;

const stores: ReportSink[] = [];
stores.push(fsReportStore);
if (turboReportSink !== undefined) {
  stores.push(turboReportSink);
}

export const reportSink = new CompositeReportSink({
  log,
  sinks: stores,
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
      reportSink.saveReport({ report });
    }
  } catch (error) {
    log.error('Error generating report', error);
  }
}

export const observers = await prescribedObserversSource.getObservers({
  startHeight: START_HEIGHT,
  epochBlockLength: EPOCH_BLOCK_LENGTH,
  height: await epochHeightSelector.getHeight(),
});

if (observers.includes(config.OBSERVER_WALLET)) {
  log.info('You have been selected as an observer');
}

export const warp = WarpFactory.forMainnet(
  {
    ...defaultCacheOptions,
  },
  true,
  arweave,
);

export const contract =
  walletJwk !== undefined
    ? new WarpContract({
        log,
        wallet: walletJwk,
        warp,
        contractId: config.CONTRACT_ID,
      })
    : undefined;

export const warpReportSink =
  contract !== undefined
    ? new ContractReportSink({
        log,
        contract,
      })
    : undefined;
