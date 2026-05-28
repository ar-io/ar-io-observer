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

import { SolanaARIOWriteable } from '@ar.io/sdk';
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
  HexSolanaSigner,
  JWKInterface,
  Signer,
} from '@dha-team/arbundles/node';
import bs58 from 'bs58';
import Arweave from 'arweave';
import { default as NodeCache } from 'node-cache';
import * as fs from 'node:fs';

import { ChainSource } from './arweave.js';
import * as config from './config.js';
import {
  resolveArweaveUploadJwk,
  resolveSolanaWallets,
  resolveUploadIdentity,
} from './wallet-config.js';
import { CachedEntropySource } from './entropy/cached-entropy-source.js';
import { SolanaEpochEntropySource } from './entropy/solana-epoch-entropy-source.js';
import { CompositeEntropySource } from './entropy/composite-entropy-source.js';
import { RandomEntropySource } from './entropy/random-entropy-source.js';
import { SolanaEpochSource } from './epochs/solana-epoch-source.js';
import { SolanaHostsSource } from './hosts/solana-hosts-source.js';
import { StaticHostsSource } from './hosts/static-hosts-source.js';
import log from './log.js';
import { SolanaNamesSource } from './names/solana-names-source.js';
import { RandomArnsNamesSource } from './names/random-arns-names-source.js';
import { StaticArnsNameList } from './names/static-arns-name-list.js';
import { Observer } from './observer.js';
import { DefaultArnsConsensusResolver } from './reference/arns-consensus-resolver.js';
import { CompositeReferenceGateway } from './reference/composite-reference-gateway.js';
import { FallbackReferenceGateway } from './reference/fallback-reference-gateway.js';
import { CachedNetworkGatewaySource } from './reference/network-gateway-source.js';
import { ArweaveReportSink } from './store/arweave-report-sink.js';
import { SolanaContractReportSink } from './store/solana-contract-report-sink.js';
import { FsReportStore } from './store/fs-report-store.js';
import { LogReportSink } from './store/log-report-sink.js';
import {
  PipelineReportSink,
  ReportSinkEntry,
} from './store/pipeline-report-sink.js';
import { TurboReportSink } from './store/turbo-report-sink.js';
import { ContinuousObserver } from './continuous/continuous-observer.js';
import { FsObservationStateStore } from './continuous/observation-state-store.js';
import type { ObserverReport } from './types.js';

const REPORT_CACHE_TTL_SECONDS = 60 * 60 * 2.5; // 2.5 hours

log.verbose(`Using wallet ${config.OBSERVER_WALLET}`);

// Optional Arweave JWK used to sign report-bundle uploads to Turbo. Only
// loaded when the operator has explicitly opted for an Arweave upload
// identity — the operator/observer protocol identities are Solana
// keypairs (resolved further down).
export const walletJwk: JWKInterface | undefined = resolveArweaveUploadJwk(
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

const chainSource = new ChainSource({
  arweaveBaseUrl: config.ARWEAVE_URL,
});

const arweaveURL = new URL(config.ARWEAVE_URL);
export const arweave = new Arweave({
  host: arweaveURL.host,
  port: 443,
  protocol: arweaveURL.protocol.replace(':', ''),
});

// The arbundles `Signer` used to sign observation-report data items
// before Turbo upload. Resolved from `UploadIdentity` below (any of
// Arweave / Solana / Ethereum). May be undefined if no upload identity
// is configured — TurboReportSink is skipped in that case.
let bundleSigner: Signer | undefined =
  walletJwk !== undefined ? new ArweaveSigner(walletJwk) : undefined;

// Address label surfaced on TurboReportSink + /info — set to whichever
// identity is actually signing bundles. Default matches the legacy
// behavior; the upload-identity switch below overwrites it.
let bundleSignerLabel: string = config.OBSERVER_WALLET;

// Which chain the upload signer belongs to. Drives Turbo's `token:`
// param so the upload service derives the correct owner address. Set
// alongside `bundleSigner` in the upload-identity switch. `undefined`
// when no upload identity is configured.
let bundleSignerChain: 'arweave' | 'solana' | 'ethereum' | undefined =
  walletJwk !== undefined ? 'arweave' : undefined;

// Cranker/operator-signed network contract. All on-chain reads (epoch,
// gateways, ArNS records) flow through this. `save_observations` uses a
// distinct observer-signed instance built below.
let networkContract: SolanaARIOWriteable;

// Observer-signed writeable used exclusively by SolanaContractReportSink
// for `save_observations`. Distinct from the cranker contract so the
// send pipeline doesn't mix signers when operator ≠ observer.
let solanaObserverContract: SolanaARIOWriteable;
let solanaObserverAddress: string;
let observerAddress: string = config.OBSERVER_WALLET;

if (!config.SOLANA_RPC_URL) {
  throw new Error('SOLANA_RPC_URL is required');
}
// Operator-key validation happens inside resolveSolanaWallets, which now
// accepts either SOLANA_KEYPAIR_PATH or SOLANA_PRIVATE_KEY. A separate
// pre-check here would only re-implement (or contradict) that logic.
const solanaRpc = createSolanaRpc(config.SOLANA_RPC_URL);
// Derive WS URL from HTTP URL (same pattern as the SDK CLI).
const wsUrl = config.SOLANA_RPC_URL.replace(/^http/, 'ws');
const solanaRpcSubscriptions = createSolanaRpcSubscriptions(wsUrl);
{
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
  const loadKeypairFromBytes = async (
    bytes: Uint8Array,
    role: string,
    source: string,
  ) => {
    const signer = await createKeyPairSignerFromBytes(bytes);
    log.info(`Loaded ${role} Solana keypair`, {
      source,
      pubkey: signer.address,
    });
    return signer;
  };
  const wallets = await resolveSolanaWallets(
    config,
    walletJwk,
    loadKeypair,
    loadKeypairFromBytes,
    log,
  );
  const solanaSigner = wallets.operator as KeyPairSigner;
  const observerSigner = wallets.observer as KeyPairSigner;
  networkContract = new SolanaARIOWriteable({
    rpc: solanaRpc,
    rpcSubscriptions: solanaRpcSubscriptions,
    signer: solanaSigner,
    ...(config.ARIO_CORE_PROGRAM_ID !== undefined &&
    config.ARIO_CORE_PROGRAM_ID !== ''
      ? { coreProgramId: config.ARIO_CORE_PROGRAM_ID as any }
      : {}),
    ...(config.ARIO_GAR_PROGRAM_ID !== undefined &&
    config.ARIO_GAR_PROGRAM_ID !== ''
      ? { garProgramId: config.ARIO_GAR_PROGRAM_ID as any }
      : {}),
    ...(config.ARIO_ARNS_PROGRAM_ID !== undefined &&
    config.ARIO_ARNS_PROGRAM_ID !== ''
      ? { arnsProgramId: config.ARIO_ARNS_PROGRAM_ID as any }
      : {}),
    ...(config.ARIO_ANT_PROGRAM_ID !== undefined &&
    config.ARIO_ANT_PROGRAM_ID !== ''
      ? { antProgramId: config.ARIO_ANT_PROGRAM_ID as any }
      : {}),
  });

  // Second SolanaARIOWriteable instance signed by the OBSERVER keypair
  // (distinct from the cranker's `networkContract` which is signed by
  // operator/cranker). Used exclusively by SolanaContractReportSink for
  // `save_observations`. When operator == observer (config 1/2), the
  // two instances share the same signer — still distinct objects so
  // the cranker's send pipeline doesn't accidentally consume them
  // interchangeably.
  solanaObserverContract = new SolanaARIOWriteable({
    rpc: solanaRpc,
    rpcSubscriptions: solanaRpcSubscriptions,
    signer: observerSigner,
    ...(config.ARIO_CORE_PROGRAM_ID !== undefined &&
    config.ARIO_CORE_PROGRAM_ID !== ''
      ? { coreProgramId: config.ARIO_CORE_PROGRAM_ID as any }
      : {}),
    ...(config.ARIO_GAR_PROGRAM_ID !== undefined &&
    config.ARIO_GAR_PROGRAM_ID !== ''
      ? { garProgramId: config.ARIO_GAR_PROGRAM_ID as any }
      : {}),
    ...(config.ARIO_ARNS_PROGRAM_ID !== undefined &&
    config.ARIO_ARNS_PROGRAM_ID !== ''
      ? { arnsProgramId: config.ARIO_ARNS_PROGRAM_ID as any }
      : {}),
    ...(config.ARIO_ANT_PROGRAM_ID !== undefined &&
    config.ARIO_ANT_PROGRAM_ID !== ''
      ? { antProgramId: config.ARIO_ANT_PROGRAM_ID as any }
      : {}),
  });
  solanaObserverAddress = observerSigner.address as string;

  // The on-chain observer identity is the observer keypair's pubkey
  // (which equals the operator's when no separate observer key is
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
      bundleSignerLabel = await arweave.wallets.jwkToAddress(
        uploadIdentity.jwk,
      );
      bundleSignerChain = 'arweave';
      break;
    case 'solana':
      // `HexSolanaSigner` is what Turbo's `TurboSigner` union accepts
      // for Solana-signed ANS-104 bundles. It extends arbundles'
      // SolanaSigner (so `createData()` still works) — only the
      // signing-message encoding differs. The constructor still takes
      // the secret key as base58.
      bundleSigner = new HexSolanaSigner(bs58.encode(uploadIdentity.secretKey));
      bundleSignerLabel = bs58.encode((bundleSigner as any).publicKey);
      bundleSignerChain = 'solana';
      break;
    case 'ethereum':
      bundleSigner = new EthereumSigner(
        '0x' + Buffer.from(uploadIdentity.privateKey).toString('hex'),
      );
      bundleSignerLabel =
        '0x' +
        Buffer.from((bundleSigner as any).publicKey)
          .toString('hex')
          .slice(-40);
      bundleSignerChain = 'ethereum';
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
    if (
      config.ARIO_ARNS_PROGRAM_ID === undefined ||
      config.ARIO_ARNS_PROGRAM_ID === ''
    ) {
      throw new Error(
        'ARIO_ARNS_PROGRAM_ID is required when ENABLE_EPOCH_CRANKING=true (needed to derive the NameRegistry PDA for prescribe_epoch).',
      );
    }
    if (
      config.ARIO_GAR_PROGRAM_ID === undefined ||
      config.ARIO_GAR_PROGRAM_ID === ''
    ) {
      throw new Error(
        'ARIO_GAR_PROGRAM_ID is required when ENABLE_EPOCH_CRANKING=true (needed to read EpochSettings).',
      );
    }
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
      contract: networkContract,
      rpc: solanaRpc,
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
}

const observedGatewayHostList =
  config.OBSERVED_GATEWAY_HOSTS.length > 0
    ? new StaticHostsSource({
        hosts: config.OBSERVED_GATEWAY_HOSTS.map((fqdn) => ({
          fqdn,
          wallet: '<unknown>',
        })),
      })
    : new SolanaHostsSource({
        readable: networkContract,
        log,
      });

if (
  config.ARIO_GAR_PROGRAM_ID === undefined ||
  config.ARIO_GAR_PROGRAM_ID === ''
) {
  throw new Error(
    'ARIO_GAR_PROGRAM_ID is required (used to derive the EpochSettings PDA).',
  );
}
export const epochSource = new SolanaEpochSource({
  rpc: solanaRpc as any,

  garProgramAddress: config.ARIO_GAR_PROGRAM_ID as any,
  log,
});

const namesSource = new SolanaNamesSource({
  readable: networkContract,
  log,
});

// Shared deterministic entropy for prescribed observers. Replaces the
// AO-era `ChainEntropySource` (which hashes Arweave block headers at
// `epochStartHeight - 50`) — Solana epochs aren't Arweave-block-aligned
// and `SolanaEpochSource.getEpochStartHeight()` returns a 0 sentinel, so
// the chain source would fetch `block/height/-50` and the gateway 400s.
// See `solana-epoch-entropy-source.ts` for the derivation rationale.
//
// We pass in the raw RPC + GAR program address instead of the SDK
// readable so the source does a single `getAccountInfo` per epoch
// rather than `readable.getEpoch()`'s ~30 RPC fan-out (per-observer
// gateway lookup + per-name record PDA fetch). Free-tier RPC won't
// sustain the fan-out alongside the cranker's parallel traffic.
if (!config.ARIO_GAR_PROGRAM_ID) {
  throw new Error(
    'ARIO_GAR_PROGRAM_ID is required (used to derive the Epoch PDA for shared entropy).',
  );
}
const sharedEpochEntropySource = new SolanaEpochEntropySource({
  epochSource,

  rpc: solanaRpc as any,

  garProgramAddress: config.ARIO_GAR_PROGRAM_ID as any,
  log,
});

const randomEntropySource = new RandomEntropySource();

const cachedEntropySource = new CachedEntropySource({
  entropySource: randomEntropySource,
  cachePath: './data/tmp/observer/entropy',
});

const compositeEntropySource = new CompositeEntropySource({
  sources: [cachedEntropySource, sharedEpochEntropySource],
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
  entropySource: sharedEpochEntropySource,
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
  if (bundleSigner === undefined || bundleSignerChain === undefined) {
    return undefined;
  }
  // Turbo accepts either an Arweave JWK via `privateKey` or any of its
  // supported `TurboSigner` instances (ArweaveSigner / HexSolanaSigner /
  // EthereumSigner) via `signer`. `token` tells Turbo which chain to
  // derive the data item's owner address from — must match the signer.
  const authConfig =
    bundleSignerChain === 'arweave' && walletJwk !== undefined
      ? { privateKey: walletJwk, token: 'arweave' as const }
      : { signer: bundleSigner as any, token: bundleSignerChain };

  return TurboFactory.authenticated({
    ...authConfig,
    ...defaultTurboConfiguration,
    ...(config.TURBO_UPLOAD_SERVICE_URL !== undefined
      ? {
          uploadServiceConfig: {
            url: config.TURBO_UPLOAD_SERVICE_URL,
            token: bundleSignerChain,
          },
        }
      : {}),
    ...(config.TURBO_PAYMENT_SERVICE_URL !== undefined
      ? {
          paymentServiceConfig: {
            url: config.TURBO_PAYMENT_SERVICE_URL,
            token: bundleSignerChain,
          },
        }
      : {}),
  });
})();

// Tracks the identity actually signing report bundles for the operator
// `/info` endpoint — Arweave address, Solana pubkey, or Ethereum address
// depending on UploadIdentity. `INVALID` when no upload identity is
// configured (uploads disabled).
export const walletAddress =
  walletJwk !== undefined
    ? await arweave.wallets.jwkToAddress(walletJwk)
    : bundleSigner !== undefined
      ? bundleSignerLabel
      : 'INVALID';

const turboReportSink =
  turboClient && bundleSigner
    ? new TurboReportSink({
        log,
        arweave,
        turboClient: turboClient,
        signer: bundleSigner,
      })
    : undefined;

const arweaveReportSink = new ArweaveReportSink({
  log,
  arweave,
  walletJwk,
});

// ============================================================
// Report pipelines — split into persistence (always runs) and
// submission (gated on prescription). The observer owns the
// decision between them via `submissionGate` below.
// ============================================================

// --- Persistence: local-only sinks. ALWAYS run so we have a local
//     record + can restart-restore even when we don't submit. ---
const persistenceStores: ReportSinkEntry[] = [];

if (config.ENABLE_LOG_REPORT_SINK) {
  persistenceStores.push({
    name: 'LogReportSink',
    sink: new LogReportSink({ log }),
  });
  log.verbose(
    'LogReportSink enabled - detailed assessment logs will be shown at info level',
  );
} else {
  log.verbose(
    'LogReportSink disabled - set ENABLE_LOG_REPORT_SINK=true to enable detailed assessment logs',
  );
}

persistenceStores.push({ name: 'FsReportStore', sink: fsReportStore });

export const persistenceReportSink = new PipelineReportSink({
  log: log.child({ pipeline: 'persistence' }),
  sinks: persistenceStores,
  maxGatewayFailureThreshold: config.OBSERVER_MAX_GATEWAY_FAILURE_THRESHOLD,
});

// --- Submission: external-cost sinks. Run only when the observer's
//     `submissionGate` proceeds (i.e. we're prescribed for this epoch
//     and haven't already submitted). The 80% failure-rate safety
//     still applies here — a bad-looking report shouldn't ship even
//     if we ARE prescribed. ---
const submissionStores: ReportSinkEntry[] = [];

if (config.REPORT_DATA_SINK === 'turbo') {
  if (turboReportSink !== undefined) {
    submissionStores.push({ name: 'TurboReportSink', sink: turboReportSink });
  } else {
    log.warn('TurboReportSink not configured - report data will not be saved');
  }
} else if (config.REPORT_DATA_SINK === 'arweave') {
  if (walletJwk !== undefined) {
    submissionStores.push({
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

// Contract-submission sink: SolanaContractReportSink calls
// `save_observations` signed by the OBSERVER keypair (which may differ
// from the operator/cranker that signs `networkContract`).
export const contractReportSink = new SolanaContractReportSink({
  log,
  contract: solanaObserverContract,
  readable: solanaObserverContract, // Writeable extends Readable

  observerAddress: solanaObserverAddress as any,
});

if (!config.SUBMIT_CONTRACT_INTERACTIONS) {
  log.verbose(
    'SUBMIT_CONTRACT_INTERACTIONS is false - contract interactions will not be saved',
  );
} else {
  submissionStores.push({
    name: 'SolanaContractReportSink',
    sink: contractReportSink,
  });
}

// If no external-submission sinks are configured at all (Turbo
// missing AND SUBMIT_CONTRACT_INTERACTIONS=false), skip wiring the
// pipeline + gate entirely. The observer will run as a pure
// persistence loop — useful for dev / dry-run / sniffing.
export const submissionReportSink =
  submissionStores.length > 0
    ? new PipelineReportSink({
        log: log.child({ pipeline: 'submission' }),
        sinks: submissionStores,
        maxGatewayFailureThreshold:
          config.OBSERVER_MAX_GATEWAY_FAILURE_THRESHOLD,
      })
    : undefined;

// Prescription gate — one RPC read per submission attempt. Returns
// `proceed: false` when there's no protocol pathway for this report
// (we weren't prescribed, or we already submitted), in which case the
// observer skips the whole submission pipeline (no Turbo upload, no
// on-chain tx). The defensive copy inside SolanaContractReportSink
// stays for tests / direct callers that bypass the observer.
export const submissionGate =
  submissionReportSink !== undefined
    ? async (report: ObserverReport) => {
        const status = await solanaObserverContract.getEpochObservationStatus(
          report.epochIndex,

          solanaObserverAddress as any,
        );
        if (!status.prescribed) {
          return {
            proceed: false,
            reason: 'observer not prescribed for this epoch',
          };
        }
        if (status.alreadyObserved) {
          return {
            proceed: false,
            reason: 'observation already submitted for this epoch',
          };
        }
        return { proceed: true };
      }
    : undefined;

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
    persistenceSink: persistenceReportSink,
    submissionSink: submissionReportSink,
    submissionGate,
    nodeReleaseVersion: config.AR_IO_NODE_RELEASE,
    nameAssessmentConcurrency: config.NAME_ASSESSMENT_CONCURRENCY,
    config: {
      cycleIntervalMs: config.OBSERVATION_CYCLE_INTERVAL_MS,
      gatewayAssessmentConcurrency: config.GATEWAY_ASSESSMENT_CONCURRENCY,
      observationsPerGateway: config.OBSERVATIONS_PER_GATEWAY,
      majorityThreshold: config.MAJORITY_VOTE_THRESHOLD,
      stabilityBufferMs: config.OBSERVATION_STABILITY_BUFFER_MS,
      submissionBufferMs: config.OBSERVATION_SUBMISSION_BUFFER_MS,
      windowFraction: config.OBSERVATION_WINDOW_FRACTION,
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
