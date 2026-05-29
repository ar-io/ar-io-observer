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
 *   operator           = SOLANA_PRIVATE_KEY | SOLANA_KEYPAIR_PATH                  (required, exactly one)
 *   observer           = OBSERVER_PRIVATE_KEY | OBSERVER_KEYPAIR_PATH ?? operator
 *   upload (Arweave)   = ARWEAVE_UPLOAD_KEY_FILE | ARWEAVE_UPLOAD_JWK              (wins if set)
 *   upload (Solana)    = SOLANA_UPLOAD_PRIVATE_KEY | SOLANA_UPLOAD_KEYPAIR_PATH    (otherwise)
 *                          ?? observer
 *
 * Each Solana role accepts EITHER a base58-encoded 64-byte secret key
 * (`*_PRIVATE_KEY`, the format Phantom and similar wallets export) OR a
 * path to a 64-byte JSON keypair file (`*_KEYPAIR_PATH`). Setting both
 * for the same role is rejected as ambiguous.
 *
 * Four supported configurations (each tested in wallet-config.test.ts):
 *   1. all-Solana single key  — SOLANA_KEYPAIR_PATH (or SOLANA_PRIVATE_KEY) only
 *   2. Solana ops + Arweave   — SOLANA_*           + ARWEAVE_UPLOAD_KEY_FILE
 *   3. three Solana keys      — SOLANA_* + OBSERVER_* + SOLANA_UPLOAD_*
 *   4. two Solana + Arweave   — SOLANA_* + OBSERVER_* + ARWEAVE_UPLOAD_KEY_FILE
 *
 * The actual `KeyPairSigner`/JWK construction is left to two
 * caller-supplied loaders (one path-based, one bytes-based) so tests can
 * run without touching disk or invoking the @solana/kit signer factory.
 */

import bs58 from 'bs58';
import type { Logger } from 'winston';
import type { JWKInterface } from '@dha-team/arbundles/node';

export interface WalletEnv {
  SOLANA_KEYPAIR_PATH: string | undefined;
  SOLANA_PRIVATE_KEY: string | undefined;
  OBSERVER_KEYPAIR_PATH: string | undefined;
  OBSERVER_PRIVATE_KEY: string | undefined;
  ARWEAVE_UPLOAD_KEY_FILE: string | undefined;
  ARWEAVE_UPLOAD_JWK: string | undefined;
  SOLANA_UPLOAD_KEYPAIR_PATH: string | undefined;
  SOLANA_UPLOAD_PRIVATE_KEY: string | undefined;
  ETHEREUM_UPLOAD_PRIVATE_KEY_FILE: string | undefined;
  ETHEREUM_UPLOAD_PRIVATE_KEY: string | undefined;
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

/**
 * Loader for the in-memory `*_PRIVATE_KEY` path. Takes the raw 64-byte
 * secret key (already validated + base58-decoded) and a role + source
 * label (the env var name) for logging. Kept separate from the
 * path-based loader so the caller can keep `@solana/kit` confined to the
 * production wiring layer.
 */
export type SolanaKeypairBytesLoader = (
  bytes: Uint8Array,
  role: string,
  source: string,
) => Promise<SolanaSignerLike>;

/**
 * Decode a Phantom-style base58 Solana secret key into the 64-byte form
 * required by `createKeyPairSignerFromBytes`. Throws with a friendly
 * error naming the env var on bad input — most common failure modes are:
 *
 *   - non-base58 characters (e.g. an Arweave JWK or hex 0x-prefixed key
 *     dropped into the slot),
 *   - 32-byte (secret-only) input — Phantom exports the full 64-byte
 *     secret+public; SDKs that emit 32-byte material would silently
 *     produce the wrong signer here.
 */
export function decodeBase58SolanaSecretKey(
  raw: string,
  envName: string,
): Uint8Array {
  let bytes: Uint8Array;
  try {
    bytes = bs58.decode(raw);
  } catch {
    throw new Error(
      `${envName}: not a valid base58 string (expected the 64-byte secret key from a Solana wallet export, e.g. Phantom).`,
    );
  }
  if (bytes.length !== 64) {
    throw new Error(
      `${envName}: decoded ${bytes.length} bytes; expected 64 (the full secret + public key Solana wallets export). 32-byte secret-only material is not supported.`,
    );
  }
  return bytes;
}

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
 * Per-role source picker: returns either a path (file) or pre-decoded
 * bytes (inline `*_PRIVATE_KEY`), or `undefined` if neither is set.
 * Throws if both are set — both being set is ambiguous, not redundant.
 */
function pickSolanaSignerSource(
  pkEnv: string | undefined,
  pkEnvName: string,
  pathEnv: string | undefined,
  pathEnvName: string,
):
  | { kind: 'path'; path: string }
  | { kind: 'bytes'; bytes: Uint8Array; source: string }
  | undefined {
  const pkSet = pkEnv !== undefined && pkEnv !== '';
  const pathSet = pathEnv !== undefined && pathEnv !== '';
  if (pkSet && pathSet) {
    throw new Error(
      `Set exactly one of ${pkEnvName} or ${pathEnvName} — both are set, which is ambiguous.`,
    );
  }
  if (pkSet) {
    return {
      kind: 'bytes',
      bytes: decodeBase58SolanaSecretKey(pkEnv as string, pkEnvName),
      source: pkEnvName,
    };
  }
  if (pathSet) {
    return { kind: 'path', path: pathEnv as string };
  }
  return undefined;
}

async function loadFromSource(
  source: NonNullable<ReturnType<typeof pickSolanaSignerSource>>,
  role: string,
  loadKeypair: SolanaKeypairLoader,
  loadKeypairFromBytes: SolanaKeypairBytesLoader,
): Promise<SolanaSignerLike> {
  return source.kind === 'bytes'
    ? loadKeypairFromBytes(source.bytes, role, source.source)
    : loadKeypair(source.path, role);
}

/**
 * Resolve all three Solana wallet identities (operator/observer/upload)
 * given the parsed env, an Arweave JWK (already resolved upstream), and
 * the file + bytes loader pair. Throws if neither SOLANA_KEYPAIR_PATH
 * nor SOLANA_PRIVATE_KEY is set (operator is required).
 */
export async function resolveSolanaWallets(
  env: Pick<
    WalletEnv,
    | 'SOLANA_KEYPAIR_PATH'
    | 'SOLANA_PRIVATE_KEY'
    | 'OBSERVER_KEYPAIR_PATH'
    | 'OBSERVER_PRIVATE_KEY'
    | 'SOLANA_UPLOAD_KEYPAIR_PATH'
    | 'SOLANA_UPLOAD_PRIVATE_KEY'
  >,
  arweaveJwk: JWKInterface | undefined,
  loadKeypair: SolanaKeypairLoader,
  loadKeypairFromBytes: SolanaKeypairBytesLoader,
  log: Pick<Logger, 'info'>,
): Promise<ResolvedSolanaWallets> {
  const operatorSource = pickSolanaSignerSource(
    env.SOLANA_PRIVATE_KEY,
    'SOLANA_PRIVATE_KEY',
    env.SOLANA_KEYPAIR_PATH,
    'SOLANA_KEYPAIR_PATH',
  );
  if (operatorSource === undefined) {
    throw new Error(
      'Operator Solana key is required: set SOLANA_KEYPAIR_PATH (file) or SOLANA_PRIVATE_KEY (base58 secret key).',
    );
  }
  const operator = await loadFromSource(
    operatorSource,
    'operator/cranker',
    loadKeypair,
    loadKeypairFromBytes,
  );

  const observerSource = pickSolanaSignerSource(
    env.OBSERVER_PRIVATE_KEY,
    'OBSERVER_PRIVATE_KEY',
    env.OBSERVER_KEYPAIR_PATH,
    'OBSERVER_KEYPAIR_PATH',
  );
  let observer: SolanaSignerLike;
  if (observerSource !== undefined) {
    observer = await loadFromSource(
      observerSource,
      'observer',
      loadKeypair,
      loadKeypairFromBytes,
    );
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
  } else {
    const uploadSource = pickSolanaSignerSource(
      env.SOLANA_UPLOAD_PRIVATE_KEY,
      'SOLANA_UPLOAD_PRIVATE_KEY',
      env.SOLANA_UPLOAD_KEYPAIR_PATH,
      'SOLANA_UPLOAD_KEYPAIR_PATH',
    );
    if (uploadSource !== undefined) {
      const signer = await loadFromSource(
        uploadSource,
        'upload (explicit)',
        loadKeypair,
        loadKeypairFromBytes,
      );
      upload = { mode: 'solana-bundle', signer };
    } else {
      log.info(
        'No upload wallet explicitly configured — reusing observer keypair for any Solana-signed bundle uploads.',
        { pubkey: observer.address },
      );
      upload = { mode: 'solana-bundle', signer: observer };
    }
  }

  return { operator, observer, upload };
}

// =========================================================================
// Multi-chain upload identity (Solana mode)
// =========================================================================
//
// Beyond the resolveSolanaWallets() output above (which keeps the legacy
// shape consumed by existing call sites), an operator may want to sign
// observation-report bundles for Turbo upload with any of:
//
//   - Arweave JWK            → `ArweaveSigner`  (legacy)
//   - Solana keypair         → `SolanaSigner`   (NEW — natural for Solana operators)
//   - Ethereum private key   → `EthereumSigner` (NEW — Turbo also accepts these)
//
// `resolveUploadIdentity` picks one based on documented precedence and
// throws on ambiguous configuration. Sniff validators give friendly
// errors when a JWK is dropped into the Solana keypair slot, etc.

/** Raw material for an arbundles Signer. The system module turns this
 *  into the concrete arbundles class instance — keeping this module free
 *  of arbundles runtime dependencies (tests stay pure). */
export type UploadIdentity =
  | { mode: 'arweave'; source: 'file' | 'env'; jwk: JWKInterface }
  | {
      mode: 'solana';
      source: 'file';
      path: string;
      secretKey: Uint8Array;
    }
  | {
      mode: 'solana';
      source: 'env';
      secretKey: Uint8Array;
    }
  | {
      mode: 'ethereum';
      source: 'file' | 'env';
      privateKey: Uint8Array;
    }
  | { mode: 'disabled' };

export interface UploadLoaders {
  /** Read raw bytes from disk; throw on missing/unreadable file. */
  readFile: (path: string) => string;
  /** Optional pre-parsed JWK loader (mostly for symmetry with arweave loader). */
  arweaveJwk: ArweaveJwkLoader;
}

/** Hex-string sniff: 32-byte Ethereum private key. */
function parseEthereumPrivateKey(raw: string, origin: string): Uint8Array {
  const cleaned = raw.trim().replace(/^0x/i, '');
  if (cleaned.length !== 64) {
    throw new Error(
      `Ethereum private key must be 32 bytes hex (64 chars after stripping "0x"); ${origin} had ${cleaned.length} chars. ` +
        (cleaned.length === 0
          ? 'Empty value — set ETHEREUM_UPLOAD_PRIVATE_KEY or ETHEREUM_UPLOAD_PRIVATE_KEY_FILE.'
          : ''),
    );
  }
  if (!/^[0-9a-fA-F]+$/.test(cleaned)) {
    throw new Error(
      `Ethereum private key from ${origin} contains non-hex characters. Expected only [0-9a-fA-F].`,
    );
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    out[i] = parseInt(cleaned.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** Parse a Solana keypair file content and validate shape. Recognizes
 *  common mis-types and produces actionable errors. */
function parseSolanaKeypair(raw: string, path: string): Uint8Array {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err: any) {
    // Maybe a hex Ethereum key got dropped in here?
    const trimmed = raw.trim();
    if (/^(0x)?[0-9a-fA-F]{64}$/.test(trimmed)) {
      throw new Error(
        `Expected a Solana keypair (64-byte JSON array) at ${path}, found a 32-byte hex string. ` +
          'If this is an Ethereum private key, set ETHEREUM_UPLOAD_PRIVATE_KEY_FILE instead.',
      );
    }
    throw new Error(
      `Failed to parse Solana keypair at ${path}: ${err.message}`,
    );
  }
  if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const keys = Object.keys(parsed as object).slice(0, 5);
    if (
      (parsed as any).kty === 'RSA' &&
      typeof (parsed as any).n === 'string'
    ) {
      throw new Error(
        `Expected a Solana keypair (64-byte JSON array) at ${path}, found an Arweave RSA JWK ` +
          `(keys: [${keys.join(', ')}]). Did you mean to set ARWEAVE_UPLOAD_KEY_FILE instead?`,
      );
    }
    throw new Error(
      `Expected a Solana keypair (64-byte JSON array) at ${path}, found an object with keys [${keys.join(', ')}].`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error(
      `Expected a Solana keypair (64-byte JSON array) at ${path}, found a ${typeof parsed}.`,
    );
  }
  if (parsed.length !== 64) {
    throw new Error(
      `Solana keypair at ${path} is ${parsed.length} bytes, expected 64.`,
    );
  }
  if (parsed.some((b) => typeof b !== 'number' || b < 0 || b > 255)) {
    throw new Error(
      `Solana keypair at ${path} contains non-byte entries (each must be 0–255).`,
    );
  }
  return Uint8Array.from(parsed as number[]);
}

/** Parse + validate an Arweave JWK. */
function parseArweaveJwk(raw: string, origin: string): JWKInterface {
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch (err: any) {
    throw new Error(
      `Failed to parse Arweave JWK from ${origin}: ${err.message}`,
    );
  }
  if (Array.isArray(parsed)) {
    throw new Error(
      `Expected an Arweave RSA JWK at ${origin}, found a JSON array (length ${parsed.length}). ` +
        'If this is a Solana keypair, set SOLANA_UPLOAD_KEYPAIR_PATH instead.',
    );
  }
  if (parsed === null || typeof parsed !== 'object') {
    throw new Error(
      `Expected an Arweave RSA JWK (object) at ${origin}, found a ${typeof parsed}.`,
    );
  }
  if (parsed.kty !== 'RSA') {
    throw new Error(
      `Arweave JWK at ${origin} has kty="${parsed.kty}", expected "RSA".`,
    );
  }
  if (typeof parsed.n !== 'string' || parsed.n.length === 0) {
    throw new Error(
      `Arweave JWK at ${origin} is missing the "n" (modulus) field.`,
    );
  }
  return parsed as JWKInterface;
}

/**
 * Resolve the upload identity (Solana mode only — AO mode keeps its own
 * single-JWK path). Documented precedence:
 *
 *   1. Arweave: ARWEAVE_UPLOAD_KEY_FILE > ARWEAVE_UPLOAD_JWK
 *   2. Ethereum: ETHEREUM_UPLOAD_PRIVATE_KEY_FILE > ETHEREUM_UPLOAD_PRIVATE_KEY
 *   3. Solana (explicit): SOLANA_UPLOAD_PRIVATE_KEY > SOLANA_UPLOAD_KEYPAIR_PATH
 *      When SOLANA_UPLOAD_PRIVATE_KEY (base58 secret key) is set the result
 *      is `{ mode: 'solana', source: 'env', secretKey }` and no file is read.
 *      Setting both SOLANA_UPLOAD_PRIVATE_KEY and SOLANA_UPLOAD_KEYPAIR_PATH
 *      is rejected as same-role ambiguity.
 *   4. Solana (implicit fallback): OBSERVER_KEYPAIR_PATH ?? SOLANA_KEYPAIR_PATH
 *
 * **Conflict policy:** if envs from MORE THAN ONE chain group are set,
 * throw immediately with the full list. Operators must pick exactly one
 * upload chain (or none).
 */
export function resolveUploadIdentity(
  env: WalletEnv,
  loaders: UploadLoaders,
  log: Pick<Logger, 'info'>,
  fallbackSolanaPath?: string, // observer or operator path, when no explicit upload key
): UploadIdentity {
  const arweaveEnvs = [
    Boolean(env.ARWEAVE_UPLOAD_KEY_FILE) && 'ARWEAVE_UPLOAD_KEY_FILE',
    Boolean(env.ARWEAVE_UPLOAD_JWK) && 'ARWEAVE_UPLOAD_JWK',
  ].filter(Boolean) as string[];
  const ethereumEnvs = [
    Boolean(env.ETHEREUM_UPLOAD_PRIVATE_KEY_FILE) &&
      'ETHEREUM_UPLOAD_PRIVATE_KEY_FILE',
    Boolean(env.ETHEREUM_UPLOAD_PRIVATE_KEY) && 'ETHEREUM_UPLOAD_PRIVATE_KEY',
  ].filter(Boolean) as string[];
  const solanaEnvs = [
    Boolean(env.SOLANA_UPLOAD_KEYPAIR_PATH) && 'SOLANA_UPLOAD_KEYPAIR_PATH',
    Boolean(env.SOLANA_UPLOAD_PRIVATE_KEY) && 'SOLANA_UPLOAD_PRIVATE_KEY',
  ].filter(Boolean) as string[];
  if (solanaEnvs.length > 1) {
    throw new Error(
      `Upload-wallet Solana config is ambiguous: set exactly one of ${solanaEnvs.join(', ')}.`,
    );
  }

  const groups = [
    arweaveEnvs.length > 0 && 'arweave',
    ethereumEnvs.length > 0 && 'ethereum',
    solanaEnvs.length > 0 && 'solana',
  ].filter(Boolean) as string[];

  if (groups.length > 1) {
    const allEnvs = [...arweaveEnvs, ...ethereumEnvs, ...solanaEnvs];
    throw new Error(
      `Upload-wallet config is ambiguous: envs from ${groups.length} chains are set (${groups.join(', ')}). ` +
        `Pick exactly one chain. Conflicting envs: ${allEnvs.join(', ')}.`,
    );
  }

  // Arweave path
  if (arweaveEnvs.length > 0) {
    if (env.ARWEAVE_UPLOAD_KEY_FILE !== undefined) {
      const raw = loaders.readFile(env.ARWEAVE_UPLOAD_KEY_FILE);
      const jwk = parseArweaveJwk(
        raw,
        `ARWEAVE_UPLOAD_KEY_FILE (${env.ARWEAVE_UPLOAD_KEY_FILE})`,
      );
      log.info('Upload identity: Arweave JWK (from file)', {
        path: env.ARWEAVE_UPLOAD_KEY_FILE,
      });
      return { mode: 'arweave', source: 'file', jwk };
    }
    const jwk = parseArweaveJwk(
      env.ARWEAVE_UPLOAD_JWK!,
      'ARWEAVE_UPLOAD_JWK env',
    );
    log.info('Upload identity: Arweave JWK (from env)');
    return { mode: 'arweave', source: 'env', jwk };
  }

  // Ethereum path
  if (ethereumEnvs.length > 0) {
    let raw: string;
    let source: 'file' | 'env';
    if (env.ETHEREUM_UPLOAD_PRIVATE_KEY_FILE !== undefined) {
      raw = loaders.readFile(env.ETHEREUM_UPLOAD_PRIVATE_KEY_FILE);
      source = 'file';
    } else {
      raw = env.ETHEREUM_UPLOAD_PRIVATE_KEY!;
      source = 'env';
    }
    const privateKey = parseEthereumPrivateKey(
      raw,
      source === 'file'
        ? `ETHEREUM_UPLOAD_PRIVATE_KEY_FILE (${env.ETHEREUM_UPLOAD_PRIVATE_KEY_FILE})`
        : 'ETHEREUM_UPLOAD_PRIVATE_KEY env',
    );
    log.info(`Upload identity: Ethereum private key (from ${source})`);
    return { mode: 'ethereum', source, privateKey };
  }

  // Solana explicit (env-string PRIVATE_KEY takes priority over file path)
  if (
    env.SOLANA_UPLOAD_PRIVATE_KEY !== undefined &&
    env.SOLANA_UPLOAD_PRIVATE_KEY !== ''
  ) {
    const secretKey = decodeBase58SolanaSecretKey(
      env.SOLANA_UPLOAD_PRIVATE_KEY,
      'SOLANA_UPLOAD_PRIVATE_KEY',
    );
    log.info(
      'Upload identity: Solana keypair (from SOLANA_UPLOAD_PRIVATE_KEY env)',
    );
    return { mode: 'solana', source: 'env', secretKey };
  }
  if (env.SOLANA_UPLOAD_KEYPAIR_PATH !== undefined) {
    const raw = loaders.readFile(env.SOLANA_UPLOAD_KEYPAIR_PATH);
    const secretKey = parseSolanaKeypair(raw, env.SOLANA_UPLOAD_KEYPAIR_PATH);
    log.info('Upload identity: Solana keypair (explicit upload key)', {
      path: env.SOLANA_UPLOAD_KEYPAIR_PATH,
    });
    return {
      mode: 'solana',
      source: 'file',
      path: env.SOLANA_UPLOAD_KEYPAIR_PATH,
      secretKey,
    };
  }

  // Solana implicit fallback
  if (fallbackSolanaPath !== undefined) {
    const raw = loaders.readFile(fallbackSolanaPath);
    const secretKey = parseSolanaKeypair(raw, fallbackSolanaPath);
    log.info(
      'Upload identity: Solana keypair (fallback to observer/operator key)',
      {
        path: fallbackSolanaPath,
      },
    );
    return {
      mode: 'solana',
      source: 'file',
      path: fallbackSolanaPath,
      secretKey,
    };
  }

  return { mode: 'disabled' };
}
