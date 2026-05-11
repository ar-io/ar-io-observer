/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Solana-mode wallet identity resolution.
 *
 * AR.IO gateways have three distinct on-chain/off-chain identities that
 * a deployer may wire to one, two, three, or four separate wallets. This
 * module reads the relevant envs (passed in as a plain config object) and
 * produces a resolved `{ operator, observer, upload }` view that the rest
 * of the system can consume without re-deriving the precedence rules.
 *
 * Precedence (Solana mode):
 *   operator           = SOLANA_KEYPAIR_PATH                                      (required)
 *   observer           = OBSERVER_KEYPAIR_PATH        ?? operator
 *   upload (Arweave)   = ARWEAVE_UPLOAD_KEY_FILE | ARWEAVE_UPLOAD_JWK             (wins if set)
 *   upload (Solana)    = SOLANA_UPLOAD_KEYPAIR_PATH   ?? observer                 (otherwise)
 *
 * Four supported configurations (each tested in wallet-config.test.ts):
 *   1. all-Solana single key  — SOLANA_KEYPAIR_PATH only
 *   2. Solana ops + Arweave   — SOLANA_KEYPAIR_PATH + ARWEAVE_UPLOAD_KEY_FILE
 *   3. three Solana keys      — SOLANA_KEYPAIR_PATH + OBSERVER_KEYPAIR_PATH
 *                                  + SOLANA_UPLOAD_KEYPAIR_PATH
 *   4. two Solana + Arweave   — SOLANA_KEYPAIR_PATH + OBSERVER_KEYPAIR_PATH
 *                                  + ARWEAVE_UPLOAD_KEY_FILE
 *
 * The actual `KeyPairSigner`/JWK construction is left to a caller-supplied
 * loader pair so tests can run without touching disk or invoking the
 * @solana/kit signer factory.
 */

import type { Logger } from 'winston';
import type { JWKInterface } from '@dha-team/arbundles/node';

export interface WalletEnv {
  NETWORK_SOURCE: 'ao' | 'solana';
  SOLANA_KEYPAIR_PATH: string | undefined;
  OBSERVER_KEYPAIR_PATH: string | undefined;
  ARWEAVE_UPLOAD_KEY_FILE: string | undefined;
  ARWEAVE_UPLOAD_JWK: string | undefined;
  SOLANA_UPLOAD_KEYPAIR_PATH: string | undefined;
}

/**
 * Minimal abstraction of a Solana signer — `address` is the only field
 * this module consumes. Matches `@solana/kit`'s `KeyPairSigner` shape so
 * the production loader can return a kit signer directly.
 */
export interface SolanaSignerLike {
  readonly address: string;
}

export type SolanaKeypairLoader = (
  path: string,
  role: string,
) => Promise<SolanaSignerLike>;

export type ArweaveJwkLoader = {
  /** Load a JWK from a JSON file path. Returns undefined on failure. */
  fromFile: (path: string) => JWKInterface | undefined;
  /** Parse an inline JWK env value. Returns undefined on failure. */
  fromEnv: (raw: string) => JWKInterface | undefined;
};

export type UploadMode = 'arweave-jwk' | 'solana-bundle' | 'disabled';

export interface ResolvedSolanaWallets {
  operator: SolanaSignerLike;
  observer: SolanaSignerLike;
  upload:
    | { mode: 'arweave-jwk'; jwk: JWKInterface }
    | { mode: 'solana-bundle'; signer: SolanaSignerLike }
    | { mode: 'disabled' };
}

/**
 * Resolve the Arweave upload JWK (if any) from env. Used by both AO and
 * Solana modes. AO callers should keep using the legacy fallback path —
 * this only handles the new `ARWEAVE_UPLOAD_*` envs which are Solana-mode
 * additions.
 */
export function resolveArweaveUploadJwk(
  env: Pick<WalletEnv, 'ARWEAVE_UPLOAD_KEY_FILE' | 'ARWEAVE_UPLOAD_JWK'>,
  loader: ArweaveJwkLoader,
  log: Pick<Logger, 'info' | 'error'>,
): JWKInterface | undefined {
  // Priority 1: explicit Arweave key file.
  if (env.ARWEAVE_UPLOAD_KEY_FILE !== undefined) {
    const jwk = loader.fromFile(env.ARWEAVE_UPLOAD_KEY_FILE);
    if (jwk !== undefined) {
      log.info(
        'Report uploads will use Arweave JWK from ARWEAVE_UPLOAD_KEY_FILE',
        { path: env.ARWEAVE_UPLOAD_KEY_FILE },
      );
      return jwk;
    }
    log.error('Unable to load ARWEAVE_UPLOAD_KEY_FILE; falling through', {
      path: env.ARWEAVE_UPLOAD_KEY_FILE,
    });
  }
  // Priority 2: inline JWK env.
  if (env.ARWEAVE_UPLOAD_JWK !== undefined) {
    const jwk = loader.fromEnv(env.ARWEAVE_UPLOAD_JWK);
    if (jwk !== undefined) {
      log.info('Report uploads will use Arweave JWK from ARWEAVE_UPLOAD_JWK');
      return jwk;
    }
    log.error('Unable to parse ARWEAVE_UPLOAD_JWK env; falling through');
  }
  return undefined;
}

/**
 * Resolve all three Solana wallet identities (operator/observer/upload)
 * given the parsed env, an Arweave JWK (already resolved upstream), and a
 * keypair loader. Throws if SOLANA_KEYPAIR_PATH is unset (required).
 */
export async function resolveSolanaWallets(
  env: Pick<
    WalletEnv,
    | 'SOLANA_KEYPAIR_PATH'
    | 'OBSERVER_KEYPAIR_PATH'
    | 'SOLANA_UPLOAD_KEYPAIR_PATH'
  >,
  arweaveJwk: JWKInterface | undefined,
  loadKeypair: SolanaKeypairLoader,
  log: Pick<Logger, 'info'>,
): Promise<ResolvedSolanaWallets> {
  if (env.SOLANA_KEYPAIR_PATH === undefined) {
    throw new Error(
      'SOLANA_KEYPAIR_PATH is required when NETWORK_SOURCE=solana',
    );
  }

  const operator = await loadKeypair(
    env.SOLANA_KEYPAIR_PATH,
    'operator/cranker',
  );

  let observer: SolanaSignerLike;
  if (env.OBSERVER_KEYPAIR_PATH !== undefined) {
    observer = await loadKeypair(env.OBSERVER_KEYPAIR_PATH, 'observer');
  } else {
    log.info(
      'Observer signer not explicitly set — reusing operator/cranker keypair for save_observations.',
      { pubkey: operator.address },
    );
    observer = operator;
  }

  let upload: ResolvedSolanaWallets['upload'];
  if (arweaveJwk !== undefined) {
    // Arweave wins; no need for a Solana upload signer.
    upload = { mode: 'arweave-jwk', jwk: arweaveJwk };
  } else if (env.SOLANA_UPLOAD_KEYPAIR_PATH !== undefined) {
    const signer = await loadKeypair(
      env.SOLANA_UPLOAD_KEYPAIR_PATH,
      'upload (explicit)',
    );
    upload = { mode: 'solana-bundle', signer };
  } else {
    log.info(
      'No upload wallet explicitly configured — reusing observer keypair for any Solana-signed bundle uploads.',
      { pubkey: observer.address },
    );
    upload = { mode: 'solana-bundle', signer: observer };
  }

  return { operator, observer, upload };
}
