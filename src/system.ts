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
import './tracing.js';

import {
  AOProcess,
  ARIO,
  ARIOWriteable,
  AoARIOWrite,
  AoWeightedObserver,
} from '@ar.io/sdk/node';
import { SolanaARIOWriteable } from '@ar.io/sdk/solana';
import {
  type KeyPairSigner,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  fetchEncodedAccount,
} from '@solana/kit';
import {
  TurboAuthenticatedClient,
  TurboFactory,
  defaultTurboConfiguration,
} from '@ardrive/turbo-sdk/node';
import {
  ArweaveSigner,
  EthereumSigner,
  JWKInterface,
  Signer,
  SolanaSigner,
} from '@dha-team/arbundles/node';
import bs58 from 'bs58';
import { connect } from '@permaweb/aoconnect';
import Arweave from 'arweave';
import { default as NodeCache } from 'node-cache';
import * as fs from 'node:fs';

import {
  AVERAGE_BLOCK_TIME_MS,
  ChainSource,
  MAX_FORK_DEPTH,
} from './arweave.js';
import * as config from './config.js';
import {
  resolveArweaveUploadJwk,
  resolveSolanaWallets,
  resolveUploadIdentity,
} from './wallet-config.js';
import { CachedEntropySource } from './entropy/cached-entropy-source.js';
import { ChainEntropySource } from './entropy/chain-entropy-source.js';
import { CompositeEntropySource } from './entropy/composite-entropy-source.js';
import { RandomEntropySource } from './entropy/random-entropy-source.js';
import { ContractEpochSource } from './epochs/contract-epoch-source.js';
import { ContractHostsSource } from './hosts/contract-hosts-source.js';
import { StaticHostsSource } from './hosts/static-hosts-source.js';
import log from './log.js';
import * as metrics from './metrics.js';
import { ContractNamesSource } from './names/contract-names-source.js';
import { RandomArnsNamesSource } from './names/random-arns-names-source.js';
import { StaticArnsNameList } from './names/static-arns-name-list.js';
import { Observer } from './observer.js';
import { DefaultArnsConsensusResolver } from './reference/arns-consensus-resolver.js';
import { CompositeReferenceGateway } from './reference/composite-reference-gateway.js';
import { FallbackReferenceGateway } from './reference/fallback-reference-gateway.js';
import { CachedNetworkGatewaySource } from './reference/network-gateway-source.js';
import { ArweaveReportSink } from './store/arweave-report-sink.js';
import { ContractReportSink } from './store/contract-report-sink.js';
import { FsReportStore } from './store/fs-report-store.js';
import { LogReportSink } from './store/log-report-sink.js';
import {
  PipelineReportSink,
  ReportSinkEntry,
} from './store/pipeline-report-sink.js';
import { TurboReportSink } from './store/turbo-report-sink.js';
import { ContinuousObserver } from './continuous/continuous-observer.js';
import { FsObservationStateStore } from './continuous/observation-state-store.js';

const REPORT_CACHE_TTL_SECONDS = 60 * 60 * 2.5; // 2.5 hours

log.verbose(`Using wallet ${config.OBSERVER_WALLET}`);

// Report-upload identity resolution (solana mode only). Operator and
// observer signers are constructed inside the NETWORK_SOURCE branch
// below. Here we just resolve the Arweave JWK if one was explicitly
// configured for uploads — leaving the legacy AO path untouched.
export const walletJwk: JWKInterface | undefined = (() => {
  if (config.NETWORK_SOURCE === 'solana') {
    return resolveArweaveUploadJwk(
      config,
      {
        fromFile: (path) => {
          try {
            return JSON.parse(fs.readFileSync(path, 'utf-8'));
          } catch {
            return undefined;
          }
        },
        fromEnv: (raw) => {
          try {
            return JSON.parse(raw);
          } catch {
            return undefined;
          }
        },
      },
      log,
    );
  }

  if (config.JWK !== undefined) {
    try {
      const jwk = JSON.parse(config.JWK);
      log.verbose('Key loaded from environment');
      return jwk;
    } catch (error: any) {
      log.error('Unable to load key from environment:', {
        message: error.message,
      });
    }
  }

  try {
    log.verbose('Loading key file...', {
      keyFile: config.KEY_FILE,
    });
    const jwk = JSON.parse(fs.readFileSync(config.KEY_FILE).toString());
    log.verbose('Key file loaded', {
      keyFile: config.KEY_FILE,
    });
    return jwk;
  } catch (error: any) {
    log.error('Unable to load key file:', {
      message: error.message,
    });
  }

  log.warn('Reports will not be published to Arweave');
  return undefined;
})();

const chainSource = new ChainSource({
  arweaveBaseUrl: config.ARWEAVE_URL,
});

// The arbundles `Signer` used to sign observation-report data items
// before Turbo upload. In AO mode this is the ArweaveSigner built from
// the legacy single JWK. In Solana mode it's resolved from the
// UploadIdentity below (any of Arweave / Solana / Ethereum). May be
// undefined if no upload identity is configured — TurboReportSink is
// skipped in that case.
let bundleSigner: Signer | undefined =
  walletJwk !== undefined ? new ArweaveSigner(walletJwk) : undefined;

// Address label surfaced on TurboReportSink + /info — set to whichever
// identity is actually signing bundles. Default matches AO behavior; the
// Solana branch overwrites with the upload pubkey/address.
let bundleSignerLabel: string = config.OBSERVER_WALLET;

let networkContract: AoARIOWrite | ReturnType<typeof ARIO.init>;
let observerAddress: string = config.OBSERVER_WALLET;

if (config.NETWORK_SOURCE === 'solana') {
  if (!config.SOLANA_RPC_URL) {
    throw new Error('SOLANA_RPC_URL is required when NETWORK_SOURCE=solana');
  }
  if (!config.SOLANA_KEYPAIR_PATH) {
    throw new Error(
      'SOLANA_KEYPAIR_PATH is required when NETWORK_SOURCE=solana',
    );
  }
  const solanaRpc = createSolanaRpc(config.SOLANA_RPC_URL);
  // Derive WS URL from HTTP URL (same pattern as the SDK CLI).
  const wsUrl = config.SOLANA_RPC_URL.replace(/^http/, 'ws');
  const solanaRpcSubscriptions = createSolanaRpcSubscriptions(wsUrl);
  // -------- Identity loading (decoupled by role) --------
  // Resolution rules + 4 supported configurations live in `wallet-config.ts`
  // and are covered by `wallet-config.test.ts`. We just supply the
  // production loader (real file I/O + kit signer factory) here.
  const loadKeypair = async (path: string, role: string) => {
    const data = JSON.parse(fs.readFileSync(path, 'utf-8'));
    const signer = await createKeyPairSignerFromBytes(Uint8Array.from(data));
    log.info(`Loaded ${role} Solana keypair`, {
      path,
      pubkey: signer.address,
    });
    return signer;
  };
  const wallets = await resolveSolanaWallets(
    config,
    walletJwk,
    loadKeypair,
    log,
  );
  const solanaSigner = wallets.operator as KeyPairSigner;
  const observerSigner = wallets.observer as KeyPairSigner;
  const uploadSolanaSigner: KeyPairSigner | undefined =
    wallets.upload.mode === 'solana-bundle'
      ? (wallets.upload.signer as KeyPairSigner)
      : undefined;
  networkContract = new SolanaARIOWriteable({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    rpc: solanaRpc as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    rpcSubscriptions: solanaRpcSubscriptions as any,
    signer: solanaSigner,
    ...(config.ARIO_CORE_PROGRAM_ID
      ? { coreProgramId: config.ARIO_CORE_PROGRAM_ID as any }
      : {}),
    ...(config.ARIO_GAR_PROGRAM_ID
      ? { garProgramId: config.ARIO_GAR_PROGRAM_ID as any }
      : {}),
    ...(config.ARIO_ARNS_PROGRAM_ID
      ? { arnsProgramId: config.ARIO_ARNS_PROGRAM_ID as any }
      : {}),
    ...(config.ARIO_ANT_PROGRAM_ID
      ? { antProgramId: config.ARIO_ANT_PROGRAM_ID as any }
      : {}),
  }) as unknown as AoARIOWrite;
  // On Solana, the on-chain observer identity is the observer keypair's
  // pubkey (which equals the operator's when no separate observer key is
  // provided). This is what must match `Gateway.observer_address` for
  // `save_observations` to land.
  observerAddress = observerSigner.address as string;

  // Resolve the bundle-upload identity (Arweave / Solana / Ethereum) and
  // construct the corresponding arbundles signer. resolveUploadIdentity
  // owns the precedence + conflict-detection logic; we just turn the
  // discriminated union into a concrete signer here.
  const fallbackSolanaPath =
    config.OBSERVER_KEYPAIR_PATH ?? config.SOLANA_KEYPAIR_PATH;
  const uploadIdentity = resolveUploadIdentity(
    config,
    {
      readFile: (p: string) => fs.readFileSync(p, 'utf-8'),
      arweaveJwk: {
        fromFile: (p) => {
          try {
            return JSON.parse(fs.readFileSync(p, 'utf-8'));
          } catch {
            return undefined;
          }
        },
        fromEnv: (raw) => {
          try {
            return JSON.parse(raw);
          } catch {
            return undefined;
          }
        },
      },
    },
    log,
    fallbackSolanaPath,
  );
  switch (uploadIdentity.mode) {
    case 'arweave':
      bundleSigner = new ArweaveSigner(uploadIdentity.jwk);
      bundleSignerLabel = await arweave.wallets.jwkToAddress(uploadIdentity.jwk);
      break;
    case 'solana':
      // arbundles' SolanaSigner takes the secret key as base58.
      bundleSigner = new SolanaSigner(bs58.encode(uploadIdentity.secretKey));
      // The arbundles SolanaSigner publicKey is the on-chain pubkey bytes.
      bundleSignerLabel = bs58.encode((bundleSigner as any).publicKey);
      break;
    case 'ethereum':
      bundleSigner = new EthereumSigner(
        '0x' + Buffer.from(uploadIdentity.privateKey).toString('hex'),
      );
      bundleSignerLabel =
        '0x' +
        Buffer.from((bundleSigner as any).publicKey).toString('hex').slice(-40);
      break;
    case 'disabled':
      bundleSigner = undefined;
      break;
  }

  log.info('Solana wallet identities resolved', {
    operator: solanaSigner.address,
    observer: observerSigner.address,
    uploadMode: uploadIdentity.mode,
    uploadIdentityLabel:
      uploadIdentity.mode !== 'disabled' ? bundleSignerLabel : undefined,
    rpcUrl: config.SOLANA_RPC_URL,
  });

  // Epoch cranking — opt-in via ENABLE_EPOCH_CRANKING=true. Zero overhead
  // when disabled (dynamic import).
  if (config.ENABLE_EPOCH_CRANKING) {
    const { EpochCranker } = await import('./epoch/epoch-cranker.js');
    const {
      getEpochSettingsPDA,
      getArnsRegistryPDA,
      deserializeEpochSettingsFull,
    } = await import('@ar.io/sdk/solana');

    const [nameRegistryPda] = await getArnsRegistryPDA(
      config.ARIO_ARNS_PROGRAM_ID as any,
    );
    const cranker = new EpochCranker({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      contract: networkContract as unknown as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      rpc: solanaRpc as any,
      signer: solanaSigner,
      pollIntervalMs: config.CRANK_POLL_INTERVAL_MS,
      batchSize: config.CRANK_BATCH_SIZE,
      closeEpochs: config.CRANK_CLOSE_EPOCHS,
      epochRetention: config.CRANK_EPOCH_RETENTION,
      warnBalanceSol: config.CRANK_WARN_BALANCE_SOL,
      criticalBalanceSol: config.CRANK_CRITICAL_BALANCE_SOL,
      enableCleanup: config.ENABLE_CLEANUP,
      cleanupBatchSize: config.CLEANUP_BATCH_SIZE,
      maxCleanupTxsPerCycle: config.MAX_CLEANUP_TXS_PER_CYCLE,
      cleanupFailureThreshold: config.CLEANUP_FAILURE_THRESHOLD,
      cleanupMinIntervalMs: config.CLEANUP_MIN_INTERVAL_MS,
      log,
      nameRegistryAccount: nameRegistryPda,
      getEpochSettings: async () => {
        const [pda] = await getEpochSettingsPDA(
          config.ARIO_GAR_PROGRAM_ID as any,
        );
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const account = await fetchEncodedAccount(solanaRpc as any, pda, {
          commitment: 'confirmed',
        });
        if (!account.exists) throw new Error('EpochSettings not found');
        const data = deserializeEpochSettingsFull(Buffer.from(account.data));
        return {
          currentEpochIndex: data.currentEpochIndex as number,
          genesisTimestamp: data.genesisTimestamp as number,
          epochDuration: data.epochDuration as number,
          enabled: (data.enabled as boolean) ?? true,
        };
      },
    });
    cranker.start();
    log.verbose('Epoch cranking enabled', {
      pollIntervalMs: config.CRANK_POLL_INTERVAL_MS,
      batchSize: config.CRANK_BATCH_SIZE,
      epochRetention: config.CRANK_EPOCH_RETENTION,
      enableCleanup: config.ENABLE_CLEANUP,
    });
  }
} else {
  networkContract = ARIO.init({
    ...(signer !== undefined ? { signer } : {}),
    process: new AOProcess({
      processId: config.IO_PROCESS_ID,
      ao: connect({
        MU_URL: config.AO_MU_URL,
        CU_URL: config.NETWORK_AO_CU_URL,
        GRAPHQL_URL: config.AO_GRAPHQL_URL,
        GATEWAY_URL: config.AO_GATEWAY_URL,
      }),
    }),
  });

  log.verbose(
    `Using process ${config.IO_PROCESS_ID} to fetch contract information`,
    {
      processId: config.IO_PROCESS_ID,
    },
  );
}

const observedGatewayHostList =
  config.OBSERVED_GATEWAY_HOSTS.length > 0
    ? new StaticHostsSource({
        hosts: config.OBSERVED_GATEWAY_HOSTS.map((fqdn) => ({
          fqdn,
          wallet: '<unknown>',
        })),
      })
    : new ContractHostsSource({
        contract: networkContract,
      });

export const epochSource = new ContractEpochSource({
  contract: networkContract,
  blockSource: chainSource,
  heightSource: chainSource,
});

const namesSource = new ContractNamesSource({
  contract: networkContract,
});

const chainEntropySource = new ChainEntropySource({
  arweaveBaseUrl: config.ARWEAVE_URL,
});

const randomEntropySource = new RandomEntropySource();

const cachedEntropySource = new CachedEntropySource({
  entropySource: randomEntropySource,
  cachePath: './data/tmp/observer/entropy',
});

const compositeEntropySource = new CompositeEntropySource({
  sources: [cachedEntropySource, chainEntropySource],
});

const nameListSource =
  config.ARNS_NAMES.length > 0
    ? new StaticArnsNameList({
        names: config.ARNS_NAMES,
      })
    : namesSource; // use the contract source if nothing configured

const chosenNamesSource = new RandomArnsNamesSource({
  nameList: nameListSource,
  entropySource: compositeEntropySource,
  numNamesToSource: config.NUM_ARNS_NAMES_TO_OBSERVE_PER_GROUP,
});

// Setup reference gateway with optional network fallback
if (
  config.REFERENCE_GATEWAY_NETWORK_ONLY &&
  config.REFERENCE_GATEWAY_HOSTS.length > 0
) {
  log.warn(
    'REFERENCE_GATEWAY_NETWORK_ONLY is enabled; REFERENCE_GATEWAY_HOSTS will be ignored',
  );
}

const explicitReferenceGateway = config.REFERENCE_GATEWAY_NETWORK_ONLY
  ? null
  : new FallbackReferenceGateway({
      hosts: config.REFERENCE_GATEWAY_HOSTS,
      nodeReleaseVersion: config.AR_IO_NODE_RELEASE,
      log,
    });

// Setup network gateway source if network fallback is enabled or network only mode
const networkGatewaySource =
  config.REFERENCE_GATEWAY_NETWORK_FALLBACK ||
  config.REFERENCE_GATEWAY_NETWORK_ONLY
    ? new CachedNetworkGatewaySource({
        contract: networkContract,
        config: {
          minPassRate: config.REFERENCE_GATEWAY_MIN_PASS_RATE,
          minConsecutivePasses: config.REFERENCE_GATEWAY_MIN_CONSECUTIVE_PASSES,
          minEpochCount: config.REFERENCE_GATEWAY_MIN_EPOCH_COUNT,
          maxCount: config.REFERENCE_GATEWAY_MAX_NETWORK_POOL,
          cacheTtlSeconds: config.REFERENCE_GATEWAY_NETWORK_CACHE_TTL_SECONDS,
        },
        log,
      })
    : null;

// Setup consensus resolver if network fallback or network only mode
const consensusResolver =
  networkGatewaySource !== null
    ? new DefaultArnsConsensusResolver({
        networkGatewaySource,
        consensusSize: config.REFERENCE_GATEWAY_CONSENSUS_SIZE,
        consensusThreshold: config.REFERENCE_GATEWAY_CONSENSUS_THRESHOLD,
        maxAttempts: config.REFERENCE_GATEWAY_CONSENSUS_MAX_ATTEMPTS,
        nodeReleaseVersion: config.AR_IO_NODE_RELEASE,
        log,
      })
    : null;

// Create composite reference gateway
const referenceGateway = new CompositeReferenceGateway({
  explicitGateway: explicitReferenceGateway,
  networkGatewaySource,
  consensusResolver,
  networkOnly: config.REFERENCE_GATEWAY_NETWORK_ONLY,
  networkFallback: config.REFERENCE_GATEWAY_NETWORK_FALLBACK,
  nodeReleaseVersion: config.AR_IO_NODE_RELEASE,
  log,
});

export const observer = new Observer({
  observerAddress,
  referenceGateway,
  arweaveUrl: config.ARWEAVE_URL,
  epochSource,
  observedGatewayHostList,
  prescribedNamesSource: namesSource,
  chosenNamesSource,
  gatewayAssessmentConcurrency: config.GATEWAY_ASSESSMENT_CONCURRENCY,
  nameAssessmentConcurrency: config.NAME_ASSESSMENT_CONCURRENCY,
  nodeReleaseVersion: config.AR_IO_NODE_RELEASE,
  entropySource: chainEntropySource,
  heightSource: chainSource,
});

export const reportCache = new NodeCache({
  stdTTL: REPORT_CACHE_TTL_SECONDS,
});

const fsReportStore = new FsReportStore({
  log,
  baseDir: './data/reports',
});

export const turboClient: TurboAuthenticatedClient | undefined = (() => {
  if (walletJwk !== undefined) {
    return TurboFactory.authenticated({
      privateKey: walletJwk,
      ...defaultTurboConfiguration,
      ...(config.TURBO_UPLOAD_SERVICE_URL !== undefined
        ? {
            uploadServiceConfig: {
              url: config.TURBO_UPLOAD_SERVICE_URL,
              token: 'arweave',
            },
          }
        : {}),
      ...(config.TURBO_PAYMENT_SERVICE_URL !== undefined
        ? {
            uploadServiceConfig: {
              url: config.TURBO_PAYMENT_SERVICE_URL,
              token: 'arweave',
            },
          }
        : {}),
    });
  } else {
    return undefined;
  }
})();

const arweaveURL = new URL(config.ARWEAVE_URL);
export const arweave = new Arweave({
  host: arweaveURL.host,
  port: 443,
  protocol: arweaveURL.protocol.replace(':', ''),
});

// `walletAddress` historically held the gateway operator's Arweave
// address (derived from walletJwk). Under Solana mode it tracks the
// identity that's actually signing report bundles — which may be an
// Arweave address, Solana pubkey, or Ethereum address depending on
// UploadIdentity. AO-mode callers keep the legacy Arweave-address value.
export const walletAddress =
  walletJwk !== undefined
    ? await arweave.wallets.jwkToAddress(walletJwk)
    : config.NETWORK_SOURCE === 'solana' && bundleSigner !== undefined
      ? bundleSignerLabel
      : 'INVALID';

const turboReportSink =
  turboClient && bundleSigner
    ? new TurboReportSink({
        log,
        arweave,
        turboClient: turboClient,
        walletAddress: bundleSignerLabel,
        signer: bundleSigner,
      })
    : undefined;

const arweaveReportSink = new ArweaveReportSink({
  log,
  arweave,
  walletJwk,
});

const stores: ReportSinkEntry[] = [];

// Add the log report sink if enabled
if (config.ENABLE_LOG_REPORT_SINK) {
  const logReportSink = new LogReportSink({
    log,
  });

  stores.push({
    name: 'LogReportSink',
    sink: logReportSink,
  });

  log.verbose(
    'LogReportSink enabled - detailed assessment logs will be shown at info level',
  );
} else {
  log.verbose(
    'LogReportSink disabled - set ENABLE_LOG_REPORT_SINK=true to enable detailed assessment logs',
  );
}

stores.push({
  name: 'FsReportStore',
  sink: fsReportStore,
});

if (config.REPORT_DATA_SINK === 'turbo') {
  if (turboReportSink !== undefined) {
    stores.push({
      name: 'TurboReportSink',
      sink: turboReportSink,
    });
  } else {
    log.warn('TurboReportSink not configured - report data will not be saved');
  }
} else if (config.REPORT_DATA_SINK === 'arweave') {
  if (walletJwk !== undefined) {
    stores.push({
      name: 'ArweaveReportSink',
      sink: arweaveReportSink,
    });
  } else {
    log.warn(
      'ArweaveReportSink not configured - report data will not be saved',
    );
  }
} else {
  log.error('Invalid REPORT_DATA_SINK value', {
    REPORT_DATA_SINK: config.REPORT_DATA_SINK,
  });
}

// On Solana, `networkContract` is a SolanaARIOWriteable (already structurally
// AoARIOWrite via the SDK), not an ARIOWriteable instance. Loosen the guard
// so we still spin up the sink for the Solana path; the saveObservations
// batching strategy is selected via the `networkSource` constructor arg.
export const contractReportSink =
  networkContract !== undefined &&
  (networkContract instanceof ARIOWriteable ||
    config.NETWORK_SOURCE === 'solana')
    ? new ContractReportSink({
        log,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        contract: networkContract as any,
        walletAddress: observerAddress,
        networkSource: config.NETWORK_SOURCE,
      })
    : undefined;

if (!config.SUBMIT_CONTRACT_INTERACTIONS) {
  log.verbose(
    'SUBMIT_CONTRACT_INTERACTIONS is false - contract interactions will not be saved',
  );
} else if (contractReportSink === undefined) {
  log.verbose(
    'Wallet not configured - contract interactions will not be saved',
  );
} else {
  stores.push({
    name: 'ContractReportSink',
    sink: contractReportSink,
  });
}

export const reportSink = new PipelineReportSink({
  log,
  sinks: stores,
});

// Wait for chain stability before saving reports
// const START_HEIGHT_START_OFFSET = MAX_FORK_DEPTH;
const START_HEIGHT_START_OFFSET_MS = MAX_FORK_DEPTH * AVERAGE_BLOCK_TIME_MS;

// Ensure there is enough time to save the report at the end of the epoch. We
// use 2 * MAX_FORK_DEPTH because it allows MAX_FORK_DEPTH blocks (somewhat
// arbitrary but pleasingly symmetric) before we stop attempting to save
// altogether for consistency reasons at the end of the epoch.
// const START_HEIGHT_END_OFFSET = 2 * MAX_FORK_DEPTH;
const START_HEIGHT_END_OFFSET_MS = 2 * MAX_FORK_DEPTH * AVERAGE_BLOCK_TIME_MS;

export async function updateAndSaveCurrentReport() {
  try {
    // check that epochs have started
    const { epochZeroStartTimestamp } = await epochSource.getEpochSettings();
    if (Date.now() < epochZeroStartTimestamp) {
      log.verbose('First epoch has not started yet. Not generating report.');
      return;
    }
    log.verbose('Generating report...');
    const reportStartTime = Date.now();

    let report;
    try {
      // Track report generation timing
      const endTimer = metrics.reportGenerationHistogram.startTimer();
      report = await observer.generateReport();
      endTimer();

      const reportDuration = Date.now() - reportStartTime;
      log.verbose(`Report generated in ${reportDuration}ms`);
      reportCache.set('current', report);
      log.verbose('Report cached');
    } catch (error: any) {
      // Track failed report generation
      metrics.reportsGeneratedCounter.inc({ status: 'failure' });
      log.error('Failed to generate report:', {
        message: error.message,
        stack: error.stack,
      });
      throw error; // Re-throw to maintain existing error handling
    }

    log.verbose('Getting observers from contract state...');
    // Get selected observers for the current epoch from the contract
    const observers: string[] = await networkContract
      .getPrescribedObservers({ epochIndex: report.epochIndex })
      .then((observers: AoWeightedObserver[]) => {
        log.verbose(
          `Retrieved ${observers.length} observers from contract state`,
        );
        return observers.map(
          (observer: AoWeightedObserver) => observer.observerAddress,
        );
      })
      .catch((error: any) => {
        log.error('Unable to get observers from contract state:', {
          message: error.message,
          stack: error.stack,
        });
        return [];
      });

    if (observers.length === 0) {
      log.warn('Not saving report - no observers retrieved from the contract');
      return;
    }

    const entropyHeight = report.epochStartHeight;
    const epochBlockLengthMs =
      report.epochEndTimestamp - report.epochStartTimestamp;
    // Save the report after a random block between 50 blocks after the start
    // of the epoch and 100 blocks before the end of the epoch
    const entropy = await compositeEntropySource.getEntropy({
      height: entropyHeight,
    });
    const saveAfterTimestamp =
      report.epochStartTimestamp +
      START_HEIGHT_START_OFFSET_MS +
      (entropy.readUInt32BE(0) %
        (epochBlockLengthMs -
          START_HEIGHT_START_OFFSET_MS -
          START_HEIGHT_END_OFFSET_MS));

    const currentHeight = await chainSource.getHeight();
    const block = await chainSource.getBlockByHeight(currentHeight);
    const currentBlockTimestamp = block.timestamp * 1000;

    if (config.ALWAYS_SAVE_REPORTS) {
      log.verbose(
        'Always save reports enabled - saving report regardless of conditions',
      );
      reportSink.saveReport({ report });
    } else if (!observers.includes(observerAddress)) {
      log.verbose('Not saving report - not selected as an observer');
    } else if (
      currentBlockTimestamp >
      report.epochEndTimestamp - config.REPORT_SAVE_EPOCH_END_OFFSET_MS
    ) {
      // The contract protects against saving reports too close to the end of
      // the epoch, but allow for configurable buffer to account for any
      // potential issues with the contract state.
      log.verbose('Not saving report - too close to end of epoch', {
        currentHeight,
        currentBlockTimestamp,
        epochEndTimestamp: report.epochEndTimestamp,
        reportSaveOffsetMs: config.REPORT_SAVE_EPOCH_END_OFFSET_MS,
      });
    } else if (currentBlockTimestamp < saveAfterTimestamp) {
      log.verbose('Not saving report - save timestamp not reached', {
        currentHeight,
        saveAfterTimestamp,
        currentBlockTimestamp,
        epochIndex: report.epochIndex,
      });
    } else {
      reportSink.saveReport({ report });
    }
  } catch (error: any) {
    log.error('Error generating report', {
      message: error.message,
      stack: error.stack,
    });
  }
}

// Continuous observation state store
export const observationStateStore = new FsObservationStateStore({
  statePath: './data/observer/observation-state.json',
  log,
});

/**
 * Factory function to create a ContinuousObserver instance.
 */
export function createContinuousObserver(): ContinuousObserver {
  return new ContinuousObserver({
    observerAddress,
    referenceGateway,
    epochSource,
    hostsSource: observedGatewayHostList,
    prescribedNamesSource: namesSource,
    chosenNamesSource,
    entropySource: compositeEntropySource,
    stateStore: observationStateStore,
    reportSink,
    nodeReleaseVersion: config.AR_IO_NODE_RELEASE,
    nameAssessmentConcurrency: config.NAME_ASSESSMENT_CONCURRENCY,
    config: {
      cycleIntervalMs: config.OBSERVATION_CYCLE_INTERVAL_MS,
      gatewayAssessmentConcurrency: config.GATEWAY_ASSESSMENT_CONCURRENCY,
      observationsPerGateway: config.OBSERVATIONS_PER_GATEWAY,
      majorityThreshold: config.MAJORITY_VOTE_THRESHOLD,
    },
    log,
  });
}

// Exception Handlers

process.on('uncaughtException', (error: any) => {
  log.error('Uncaught exception!', {
    error: error?.message,
    stack: error?.stack,
  });
});

process.on('SIGTERM', () => {
  log.verbose('SIGTERM received, exiting...');
  process.exit(0);
});

process.on('SIGINT', () => {
  log.verbose('SIGINT received, exiting...');
  process.exit(0);
});
