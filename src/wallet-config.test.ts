/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Unit tests for the four supported wallet configurations. These mock
 * both loaders (Solana keypair + Arweave JWK) so no disk I/O or signer
 * factory is touched — pure precedence/resolution logic under test.
 */
import { expect } from 'chai';
import * as sinon from 'sinon';
import type { Logger } from 'winston';

import bs58 from 'bs58';

import {
  decodeBase58SolanaSecretKey,
  resolveArweaveUploadJwk,
  resolveSolanaWallets,
  resolveUploadIdentity,
  type ArweaveJwkLoader,
  type SolanaKeypairBytesLoader,
  type SolanaKeypairLoader,
  type SolanaSignerLike,
  type UploadLoaders,
  type WalletEnv,
} from './wallet-config.js';

function makeLog(): Pick<Logger, 'info' | 'error'> {
  return {
    info: sinon.stub() as any,
    error: sinon.stub() as any,
  };
}

function mkSigner(pubkey: string): SolanaSignerLike {
  return { address: pubkey };
}

/** Loader that returns a deterministic signer for each path so the tests
 *  can assert which path was loaded for which role. */
function makeKeypairLoader(): {
  loader: SolanaKeypairLoader;
  calls: Array<{ path: string; role: string }>;
} {
  const calls: Array<{ path: string; role: string }> = [];
  const loader: SolanaKeypairLoader = async (path, role) => {
    calls.push({ path, role });
    // Encode the path into the pubkey so assertions are obvious.
    return mkSigner(`PUB_${path.split('/').pop()}`);
  };
  return { loader, calls };
}

/** Bytes loader that throws if invoked — installed as the default for
 *  existing tests that only exercise the path-based loader. Anything
 *  that accidentally drives them to the bytes branch fails loudly. */
const unusedBytesLoader: SolanaKeypairBytesLoader = async () => {
  throw new Error('unusedBytesLoader should not have been called');
};

/** Bytes loader paired with makeKeypairLoader for the `*_PRIVATE_KEY`
 *  path. Encodes the source env-var name into the pubkey so assertions
 *  can distinguish "loaded from PK env" vs "loaded from path". */
function makeKeypairBytesLoader(): {
  loader: SolanaKeypairBytesLoader;
  calls: Array<{ source: string; role: string; bytesLength: number }>;
} {
  const calls: Array<{ source: string; role: string; bytesLength: number }> =
    [];
  const loader: SolanaKeypairBytesLoader = async (bytes, role, source) => {
    calls.push({ source, role, bytesLength: bytes.length });
    return mkSigner(`PUB_${source}`);
  };
  return { loader, calls };
}

/** Build a valid 64-byte base58 string for use as a SOLANA_PRIVATE_KEY in
 *  tests. The bytes themselves don't need to be a real Ed25519 keypair —
 *  the mock loader never actually constructs a signer. */
function mkBase58Secret(seedByte = 0): string {
  const bytes = new Uint8Array(64);
  bytes.fill(seedByte);
  return bs58.encode(bytes);
}

/** Minimal WalletEnv with all fields undefined; tests override what they
 *  care about. Centralizes the field list so adding a new env var only
 *  touches this helper. */
function blankWalletEnv(): Pick<
  WalletEnv,
  | 'SOLANA_KEYPAIR_PATH'
  | 'SOLANA_PRIVATE_KEY'
  | 'OBSERVER_KEYPAIR_PATH'
  | 'OBSERVER_PRIVATE_KEY'
  | 'SOLANA_UPLOAD_KEYPAIR_PATH'
  | 'SOLANA_UPLOAD_PRIVATE_KEY'
> {
  return {
    SOLANA_KEYPAIR_PATH: undefined,
    SOLANA_PRIVATE_KEY: undefined,
    OBSERVER_KEYPAIR_PATH: undefined,
    OBSERVER_PRIVATE_KEY: undefined,
    SOLANA_UPLOAD_KEYPAIR_PATH: undefined,
    SOLANA_UPLOAD_PRIVATE_KEY: undefined,
  };
}

function makeJwkLoader(opts: {
  fileJwk?: any;
  envJwk?: any;
  fileThrows?: boolean;
  envThrows?: boolean;
}): ArweaveJwkLoader {
  return {
    fromFile: (_p) =>
      opts.fileThrows ? undefined : (opts.fileJwk ?? undefined),
    fromEnv: (_r) => (opts.envThrows ? undefined : (opts.envJwk ?? undefined)),
  };
}

describe('wallet-config', () => {
  describe('resolveArweaveUploadJwk', () => {
    it('prefers ARWEAVE_UPLOAD_KEY_FILE over ARWEAVE_UPLOAD_JWK', () => {
      const jwk = resolveArweaveUploadJwk(
        {
          ARWEAVE_UPLOAD_KEY_FILE: '/some/path.json',
          ARWEAVE_UPLOAD_JWK: '{"kty":"RSA","n":"env-jwk"}',
        },
        makeJwkLoader({
          fileJwk: { kty: 'RSA', n: 'file-jwk' },
          envJwk: { kty: 'RSA', n: 'env-jwk' },
        }),
        makeLog(),
      );
      expect(jwk).to.deep.equal({ kty: 'RSA', n: 'file-jwk' });
    });

    it('falls back to ARWEAVE_UPLOAD_JWK when file load fails', () => {
      const log = makeLog();
      const jwk = resolveArweaveUploadJwk(
        {
          ARWEAVE_UPLOAD_KEY_FILE: '/missing.json',
          ARWEAVE_UPLOAD_JWK: '{"kty":"RSA","n":"env-jwk"}',
        },
        makeJwkLoader({
          fileJwk: undefined,
          envJwk: { kty: 'RSA', n: 'env-jwk' },
        }),
        log,
      );
      expect(jwk).to.deep.equal({ kty: 'RSA', n: 'env-jwk' });
      expect((log.error as sinon.SinonStub).called).to.equal(true);
    });

    it('returns undefined when both are unset', () => {
      const jwk = resolveArweaveUploadJwk(
        {
          ARWEAVE_UPLOAD_KEY_FILE: undefined,
          ARWEAVE_UPLOAD_JWK: undefined,
        },
        makeJwkLoader({}),
        makeLog(),
      );
      expect(jwk).to.equal(undefined);
    });

    it('returns undefined and logs error when both fail to parse', () => {
      const log = makeLog();
      const jwk = resolveArweaveUploadJwk(
        {
          ARWEAVE_UPLOAD_KEY_FILE: '/bad.json',
          ARWEAVE_UPLOAD_JWK: 'not json',
        },
        makeJwkLoader({}),
        log,
      );
      expect(jwk).to.equal(undefined);
      expect((log.error as sinon.SinonStub).callCount).to.equal(2);
    });
  });

  describe('resolveSolanaWallets', () => {
    it('throws when SOLANA_KEYPAIR_PATH is unset', async () => {
      const { loader } = makeKeypairLoader();
      let threw = false;
      try {
        await resolveSolanaWallets(
          {
            SOLANA_KEYPAIR_PATH: undefined,
            OBSERVER_KEYPAIR_PATH: undefined,
            SOLANA_PRIVATE_KEY: undefined,
            OBSERVER_PRIVATE_KEY: undefined,
            SOLANA_UPLOAD_PRIVATE_KEY: undefined,
            SOLANA_UPLOAD_KEYPAIR_PATH: undefined,
          },
          undefined,
          loader,
          unusedBytesLoader,
          makeLog(),
        );
      } catch (e: any) {
        threw = true;
        expect(e.message).to.match(
          /Operator Solana key is required.*SOLANA_KEYPAIR_PATH.*SOLANA_PRIVATE_KEY/,
        );
      }
      expect(threw).to.equal(true);
    });

    describe('Config 1: all-Solana single key', () => {
      it('resolves operator = observer = upload to the same signer', async () => {
        const { loader, calls } = makeKeypairLoader();
        const result = await resolveSolanaWallets(
          {
            SOLANA_KEYPAIR_PATH: '/keys/op.json',
            OBSERVER_KEYPAIR_PATH: undefined,
            SOLANA_PRIVATE_KEY: undefined,
            OBSERVER_PRIVATE_KEY: undefined,
            SOLANA_UPLOAD_PRIVATE_KEY: undefined,
            SOLANA_UPLOAD_KEYPAIR_PATH: undefined,
          },
          undefined,
          loader,
          unusedBytesLoader,
          makeLog(),
        );
        expect(result.operator.address).to.equal('PUB_op.json');
        expect(result.observer).to.equal(result.operator);
        expect(result.upload.mode).to.equal('solana-bundle');
        if (result.upload.mode === 'solana-bundle') {
          expect(result.upload.signer).to.equal(result.operator);
        }
        // Only one disk read.
        expect(calls).to.have.length(1);
        expect(calls[0].role).to.equal('operator/cranker');
      });
    });

    describe('Config 2: Solana ops + Arweave JWK upload', () => {
      it('reuses operator for observer and routes uploads to the JWK', async () => {
        const { loader, calls } = makeKeypairLoader();
        const jwk = { kty: 'RSA', n: 'jwk-n' };
        const result = await resolveSolanaWallets(
          {
            SOLANA_KEYPAIR_PATH: '/keys/op.json',
            OBSERVER_KEYPAIR_PATH: undefined,
            SOLANA_PRIVATE_KEY: undefined,
            OBSERVER_PRIVATE_KEY: undefined,
            SOLANA_UPLOAD_PRIVATE_KEY: undefined,
            SOLANA_UPLOAD_KEYPAIR_PATH: undefined,
          },
          jwk,
          loader,
          unusedBytesLoader,
          makeLog(),
        );
        expect(result.operator.address).to.equal('PUB_op.json');
        expect(result.observer).to.equal(result.operator);
        expect(result.upload.mode).to.equal('arweave-jwk');
        if (result.upload.mode === 'arweave-jwk') {
          expect(result.upload.jwk).to.equal(jwk);
        }
        // Operator key loaded; no Solana upload load.
        expect(calls).to.have.length(1);
      });

      it('ignores SOLANA_UPLOAD_KEYPAIR_PATH when Arweave JWK is present', async () => {
        const { loader, calls } = makeKeypairLoader();
        const result = await resolveSolanaWallets(
          {
            SOLANA_KEYPAIR_PATH: '/keys/op.json',
            OBSERVER_KEYPAIR_PATH: undefined,
            SOLANA_PRIVATE_KEY: undefined,
            OBSERVER_PRIVATE_KEY: undefined,
            SOLANA_UPLOAD_PRIVATE_KEY: undefined,
            SOLANA_UPLOAD_KEYPAIR_PATH: '/keys/upload.json',
          },
          { kty: 'RSA', n: 'n' },
          loader,
          unusedBytesLoader,
          makeLog(),
        );
        expect(result.upload.mode).to.equal('arweave-jwk');
        // SOLANA_UPLOAD_KEYPAIR_PATH was NOT loaded — Arweave wins.
        expect(calls.find((c) => c.path === '/keys/upload.json')).to.equal(
          undefined,
        );
      });
    });

    describe('Config 3: three Solana keys', () => {
      it('loads each role to its own signer', async () => {
        const { loader, calls } = makeKeypairLoader();
        const result = await resolveSolanaWallets(
          {
            SOLANA_KEYPAIR_PATH: '/keys/op.json',
            OBSERVER_KEYPAIR_PATH: '/keys/obs.json',
            SOLANA_PRIVATE_KEY: undefined,
            OBSERVER_PRIVATE_KEY: undefined,
            SOLANA_UPLOAD_PRIVATE_KEY: undefined,
            SOLANA_UPLOAD_KEYPAIR_PATH: '/keys/upload.json',
          },
          undefined,
          loader,
          unusedBytesLoader,
          makeLog(),
        );
        expect(result.operator.address).to.equal('PUB_op.json');
        expect(result.observer.address).to.equal('PUB_obs.json');
        expect(result.upload.mode).to.equal('solana-bundle');
        if (result.upload.mode === 'solana-bundle') {
          expect(result.upload.signer.address).to.equal('PUB_upload.json');
        }
        expect(calls.map((c) => c.role)).to.deep.equal([
          'operator/cranker',
          'observer',
          'upload (explicit)',
        ]);
      });
    });

    describe('Config 4: two Solana + Arweave JWK upload', () => {
      it('loads operator + observer separately and routes uploads to Arweave', async () => {
        const { loader, calls } = makeKeypairLoader();
        const jwk = { kty: 'RSA', n: 'arweave-n' };
        const result = await resolveSolanaWallets(
          {
            SOLANA_KEYPAIR_PATH: '/keys/op.json',
            OBSERVER_KEYPAIR_PATH: '/keys/obs.json',
            SOLANA_PRIVATE_KEY: undefined,
            OBSERVER_PRIVATE_KEY: undefined,
            SOLANA_UPLOAD_PRIVATE_KEY: undefined,
            SOLANA_UPLOAD_KEYPAIR_PATH: undefined,
          },
          jwk,
          loader,
          unusedBytesLoader,
          makeLog(),
        );
        expect(result.operator.address).to.equal('PUB_op.json');
        expect(result.observer.address).to.equal('PUB_obs.json');
        expect(result.upload.mode).to.equal('arweave-jwk');
        if (result.upload.mode === 'arweave-jwk') {
          expect(result.upload.jwk).to.equal(jwk);
        }
        // No upload-Solana load attempted.
        expect(calls).to.have.length(2);
      });
    });

    describe('fallback edge cases', () => {
      it('uses operator for upload when only OBSERVER_KEYPAIR_PATH is set (no upload key, no Arweave)', async () => {
        // Documented precedence: SOLANA_UPLOAD_KEYPAIR_PATH > observer >
        // operator. With only OBSERVER set, upload falls to observer.
        const { loader } = makeKeypairLoader();
        const result = await resolveSolanaWallets(
          {
            SOLANA_KEYPAIR_PATH: '/keys/op.json',
            OBSERVER_KEYPAIR_PATH: '/keys/obs.json',
            SOLANA_PRIVATE_KEY: undefined,
            OBSERVER_PRIVATE_KEY: undefined,
            SOLANA_UPLOAD_PRIVATE_KEY: undefined,
            SOLANA_UPLOAD_KEYPAIR_PATH: undefined,
          },
          undefined,
          loader,
          unusedBytesLoader,
          makeLog(),
        );
        expect(result.upload.mode).to.equal('solana-bundle');
        if (result.upload.mode === 'solana-bundle') {
          expect(result.upload.signer).to.equal(result.observer);
        }
      });

      it('uses operator for both observer and upload when only operator is set', async () => {
        const { loader } = makeKeypairLoader();
        const result = await resolveSolanaWallets(
          {
            SOLANA_KEYPAIR_PATH: '/keys/op.json',
            OBSERVER_KEYPAIR_PATH: undefined,
            SOLANA_PRIVATE_KEY: undefined,
            OBSERVER_PRIVATE_KEY: undefined,
            SOLANA_UPLOAD_PRIVATE_KEY: undefined,
            SOLANA_UPLOAD_KEYPAIR_PATH: undefined,
          },
          undefined,
          loader,
          unusedBytesLoader,
          makeLog(),
        );
        expect(result.observer).to.equal(result.operator);
        if (result.upload.mode === 'solana-bundle') {
          expect(result.upload.signer).to.equal(result.operator);
        }
      });

      it('propagates loader errors from any keypair path', async () => {
        const loader: SolanaKeypairLoader = async (path) => {
          if (path === '/keys/obs.json') throw new Error('disk read failed');
          return mkSigner('PUB_' + path);
        };
        let threw = false;
        try {
          await resolveSolanaWallets(
            {
              SOLANA_KEYPAIR_PATH: '/keys/op.json',
              OBSERVER_KEYPAIR_PATH: '/keys/obs.json',
              SOLANA_PRIVATE_KEY: undefined,
              OBSERVER_PRIVATE_KEY: undefined,
              SOLANA_UPLOAD_PRIVATE_KEY: undefined,
              SOLANA_UPLOAD_KEYPAIR_PATH: undefined,
            },
            undefined,
            loader,
            makeLog(),
          );
        } catch (e: any) {
          threw = true;
          expect(e.message).to.match(/disk read failed/);
        }
        expect(threw).to.equal(true);
      });
    });

    describe('*_PRIVATE_KEY env support (Phantom-export base58 secret key)', () => {
      it('uses SOLANA_PRIVATE_KEY via the bytes loader (no file read)', async () => {
        const { loader: pathLoader, calls: pathCalls } = makeKeypairLoader();
        const { loader: bytesLoader, calls: bytesCalls } =
          makeKeypairBytesLoader();
        const result = await resolveSolanaWallets(
          {
            ...blankWalletEnv(),
            SOLANA_PRIVATE_KEY: mkBase58Secret(),
          },
          undefined,
          pathLoader,
          bytesLoader,
          makeLog(),
        );
        expect(result.operator.address).to.equal('PUB_SOLANA_PRIVATE_KEY');
        expect(pathCalls).to.have.length(0);
        expect(bytesCalls).to.have.length(1);
        expect(bytesCalls[0].role).to.equal('operator/cranker');
        expect(bytesCalls[0].bytesLength).to.equal(64);
      });

      it('loads observer from OBSERVER_PRIVATE_KEY while operator stays on path', async () => {
        const { loader: pathLoader, calls: pathCalls } = makeKeypairLoader();
        const { loader: bytesLoader, calls: bytesCalls } =
          makeKeypairBytesLoader();
        const result = await resolveSolanaWallets(
          {
            ...blankWalletEnv(),
            SOLANA_KEYPAIR_PATH: '/keys/op.json',
            OBSERVER_PRIVATE_KEY: mkBase58Secret(),
          },
          undefined,
          pathLoader,
          bytesLoader,
          makeLog(),
        );
        expect(result.operator.address).to.equal('PUB_op.json');
        expect(result.observer.address).to.equal('PUB_OBSERVER_PRIVATE_KEY');
        expect(pathCalls.map((c) => c.role)).to.deep.equal([
          'operator/cranker',
        ]);
        expect(bytesCalls.map((c) => c.role)).to.deep.equal(['observer']);
      });

      it('loads upload signer from SOLANA_UPLOAD_PRIVATE_KEY when no Arweave JWK', async () => {
        const { loader: pathLoader } = makeKeypairLoader();
        const { loader: bytesLoader, calls: bytesCalls } =
          makeKeypairBytesLoader();
        const result = await resolveSolanaWallets(
          {
            ...blankWalletEnv(),
            SOLANA_KEYPAIR_PATH: '/keys/op.json',
            SOLANA_UPLOAD_PRIVATE_KEY: mkBase58Secret(),
          },
          undefined,
          pathLoader,
          bytesLoader,
          makeLog(),
        );
        expect(result.upload.mode).to.equal('solana-bundle');
        if (result.upload.mode === 'solana-bundle') {
          expect(result.upload.signer.address).to.equal(
            'PUB_SOLANA_UPLOAD_PRIVATE_KEY',
          );
        }
        expect(bytesCalls.map((c) => c.role)).to.deep.equal([
          'upload (explicit)',
        ]);
      });

      it('rejects setting both SOLANA_PRIVATE_KEY and SOLANA_KEYPAIR_PATH (ambiguous)', async () => {
        const { loader: pathLoader } = makeKeypairLoader();
        const { loader: bytesLoader } = makeKeypairBytesLoader();
        let threw = false;
        try {
          await resolveSolanaWallets(
            {
              ...blankWalletEnv(),
              SOLANA_KEYPAIR_PATH: '/keys/op.json',
              SOLANA_PRIVATE_KEY: mkBase58Secret(),
            },
            undefined,
            pathLoader,
            bytesLoader,
            makeLog(),
          );
        } catch (e: any) {
          threw = true;
          expect(e.message).to.match(
            /exactly one of SOLANA_PRIVATE_KEY or SOLANA_KEYPAIR_PATH/,
          );
        }
        expect(threw).to.equal(true);
      });

      it('treats empty string as unset for *_PRIVATE_KEY envs', async () => {
        // Empty string is what some env-loading layers (compose, .env)
        // surface for unset vars; it must behave identically to undefined.
        const { loader: pathLoader, calls: pathCalls } = makeKeypairLoader();
        const result = await resolveSolanaWallets(
          {
            ...blankWalletEnv(),
            SOLANA_KEYPAIR_PATH: '/keys/op.json',
            OBSERVER_PRIVATE_KEY: '',
            SOLANA_UPLOAD_PRIVATE_KEY: '',
          },
          undefined,
          pathLoader,
          unusedBytesLoader,
          makeLog(),
        );
        // observer & upload both fall back to operator since the empty
        // PRIVATE_KEY envs are treated as not set.
        expect(result.observer).to.equal(result.operator);
        if (result.upload.mode === 'solana-bundle') {
          expect(result.upload.signer).to.equal(result.operator);
        }
        expect(pathCalls).to.have.length(1);
      });
    });

    describe('decodeBase58SolanaSecretKey', () => {
      it('round-trips a valid 64-byte secret key', () => {
        const original = new Uint8Array(64);
        for (let i = 0; i < 64; i++) original[i] = i;
        const decoded = decodeBase58SolanaSecretKey(
          bs58.encode(original),
          'SOLANA_PRIVATE_KEY',
        );
        expect(decoded).to.deep.equal(original);
      });

      it('rejects a 32-byte secret-only payload with a helpful message', () => {
        // Some tooling exports only the 32-byte secret (not the full
        // 64-byte secret+public). Catch that explicitly.
        const secretOnly = new Uint8Array(32);
        expect(() =>
          decodeBase58SolanaSecretKey(
            bs58.encode(secretOnly),
            'SOLANA_PRIVATE_KEY',
          ),
        ).to.throw(/decoded 32 bytes; expected 64/);
      });

      it('rejects non-base58 input with the env var name in the message', () => {
        // `0` is not a base58 character — Phantom would never produce
        // this, but an operator might paste a hex 0x... key by mistake.
        expect(() =>
          decodeBase58SolanaSecretKey('0xdeadbeef', 'OBSERVER_PRIVATE_KEY'),
        ).to.throw(/OBSERVER_PRIVATE_KEY.*not a valid base58/);
      });
    });
  });

  // =========================================================================
  // resolveUploadIdentity — 3-chain upload selection + sniff validators
  // =========================================================================
  describe('resolveUploadIdentity', () => {
    /** Minimal WalletEnv with everything off. Spread overrides per test. */
    const baseEnv: WalletEnv = {
      SOLANA_KEYPAIR_PATH: undefined,
      OBSERVER_KEYPAIR_PATH: undefined,
      ARWEAVE_UPLOAD_KEY_FILE: undefined,
      ARWEAVE_UPLOAD_JWK: undefined,
      SOLANA_UPLOAD_KEYPAIR_PATH: undefined,
      ETHEREUM_UPLOAD_PRIVATE_KEY_FILE: undefined,
      ETHEREUM_UPLOAD_PRIVATE_KEY: undefined,
    };

    /** Loader registry maps path → returned file content. */
    function makeLoaders(files: Record<string, string>): UploadLoaders {
      return {
        readFile: (path: string) => {
          if (!(path in files)) {
            throw new Error(`Test: no mock file content for path ${path}`);
          }
          return files[path];
        },
        arweaveJwk: {
          fromFile: () => undefined,
          fromEnv: () => undefined,
        },
      };
    }

    /** Helper: a valid 64-byte Solana keypair JSON. */
    const solanaKeypairJson = JSON.stringify(
      Array.from({ length: 64 }, (_, i) => i & 0xff),
    );
    /** Helper: a valid Arweave JWK. */
    const validJwkJson = JSON.stringify({
      kty: 'RSA',
      n: 'fake-modulus-base64url-encoded',
      e: 'AQAB',
    });
    /** Helper: a valid hex Ethereum private key. */
    const validEthHex = '0x' + 'a1'.repeat(32);

    it('returns disabled when no envs are set and no fallback path is given', () => {
      const id = resolveUploadIdentity(baseEnv, makeLoaders({}), makeLog());
      expect(id.mode).to.equal('disabled');
    });

    describe('Arweave path', () => {
      it('loads JWK from ARWEAVE_UPLOAD_KEY_FILE', () => {
        const id = resolveUploadIdentity(
          { ...baseEnv, ARWEAVE_UPLOAD_KEY_FILE: '/keys/jwk.json' },
          makeLoaders({ '/keys/jwk.json': validJwkJson }),
          makeLog(),
        );
        expect(id.mode).to.equal('arweave');
        if (id.mode === 'arweave') {
          expect(id.source).to.equal('file');
          expect(id.jwk.kty).to.equal('RSA');
        }
      });

      it('loads JWK from ARWEAVE_UPLOAD_JWK inline env', () => {
        const id = resolveUploadIdentity(
          { ...baseEnv, ARWEAVE_UPLOAD_JWK: validJwkJson },
          makeLoaders({}),
          makeLog(),
        );
        expect(id.mode).to.equal('arweave');
        if (id.mode === 'arweave') {
          expect(id.source).to.equal('env');
        }
      });

      it('rejects a Solana keypair file dropped into the Arweave slot', () => {
        try {
          resolveUploadIdentity(
            { ...baseEnv, ARWEAVE_UPLOAD_KEY_FILE: '/keys/solana.json' },
            makeLoaders({ '/keys/solana.json': solanaKeypairJson }),
            makeLog(),
          );
          expect.fail('expected throw');
        } catch (e: any) {
          expect(e.message).to.match(/found a JSON array/);
          expect(e.message).to.match(/SOLANA_UPLOAD_KEYPAIR_PATH/);
        }
      });

      it('rejects a JWK with missing modulus', () => {
        try {
          resolveUploadIdentity(
            { ...baseEnv, ARWEAVE_UPLOAD_JWK: '{"kty":"RSA"}' },
            makeLoaders({}),
            makeLog(),
          );
          expect.fail('expected throw');
        } catch (e: any) {
          expect(e.message).to.match(/missing.*"n"/);
        }
      });
    });

    describe('Ethereum path', () => {
      it('loads private key from ETHEREUM_UPLOAD_PRIVATE_KEY_FILE', () => {
        const id = resolveUploadIdentity(
          { ...baseEnv, ETHEREUM_UPLOAD_PRIVATE_KEY_FILE: '/keys/eth.hex' },
          makeLoaders({ '/keys/eth.hex': validEthHex }),
          makeLog(),
        );
        expect(id.mode).to.equal('ethereum');
        if (id.mode === 'ethereum') {
          expect(id.source).to.equal('file');
          expect(id.privateKey).to.have.length(32);
        }
      });

      it('loads private key from inline env (with 0x prefix)', () => {
        const id = resolveUploadIdentity(
          { ...baseEnv, ETHEREUM_UPLOAD_PRIVATE_KEY: validEthHex },
          makeLoaders({}),
          makeLog(),
        );
        expect(id.mode).to.equal('ethereum');
      });

      it('loads private key from inline env (without 0x prefix)', () => {
        const id = resolveUploadIdentity(
          { ...baseEnv, ETHEREUM_UPLOAD_PRIVATE_KEY: 'a1'.repeat(32) },
          makeLoaders({}),
          makeLog(),
        );
        expect(id.mode).to.equal('ethereum');
      });

      it('rejects wrong-length Ethereum key', () => {
        try {
          resolveUploadIdentity(
            { ...baseEnv, ETHEREUM_UPLOAD_PRIVATE_KEY: 'a1'.repeat(16) },
            makeLoaders({}),
            makeLog(),
          );
          expect.fail('expected throw');
        } catch (e: any) {
          expect(e.message).to.match(/32 bytes hex/);
        }
      });

      it('rejects non-hex Ethereum key', () => {
        try {
          resolveUploadIdentity(
            { ...baseEnv, ETHEREUM_UPLOAD_PRIVATE_KEY: 'z'.repeat(64) },
            makeLoaders({}),
            makeLog(),
          );
          expect.fail('expected throw');
        } catch (e: any) {
          expect(e.message).to.match(/non-hex/);
        }
      });
    });

    describe('Solana path', () => {
      it('loads keypair from SOLANA_UPLOAD_KEYPAIR_PATH', () => {
        const id = resolveUploadIdentity(
          { ...baseEnv, SOLANA_UPLOAD_KEYPAIR_PATH: '/keys/solana.json' },
          makeLoaders({ '/keys/solana.json': solanaKeypairJson }),
          makeLog(),
        );
        expect(id.mode).to.equal('solana');
        if (id.mode === 'solana') {
          expect(id.secretKey).to.have.length(64);
          expect(id.path).to.equal('/keys/solana.json');
        }
      });

      it('falls back to provided fallbackSolanaPath when nothing else is set', () => {
        const id = resolveUploadIdentity(
          baseEnv,
          makeLoaders({ '/keys/operator.json': solanaKeypairJson }),
          makeLog(),
          '/keys/operator.json',
        );
        expect(id.mode).to.equal('solana');
        if (id.mode === 'solana') {
          expect(id.path).to.equal('/keys/operator.json');
        }
      });

      it('rejects an Arweave JWK dropped into the Solana keypair slot', () => {
        try {
          resolveUploadIdentity(
            { ...baseEnv, SOLANA_UPLOAD_KEYPAIR_PATH: '/keys/jwk.json' },
            makeLoaders({ '/keys/jwk.json': validJwkJson }),
            makeLog(),
          );
          expect.fail('expected throw');
        } catch (e: any) {
          expect(e.message).to.match(/Arweave RSA JWK/);
          expect(e.message).to.match(/ARWEAVE_UPLOAD_KEY_FILE/);
        }
      });

      it('rejects a Solana keypair file of wrong length', () => {
        const shortKeypair = JSON.stringify(
          Array.from({ length: 32 }, () => 0),
        );
        try {
          resolveUploadIdentity(
            { ...baseEnv, SOLANA_UPLOAD_KEYPAIR_PATH: '/keys/half.json' },
            makeLoaders({ '/keys/half.json': shortKeypair }),
            makeLog(),
          );
          expect.fail('expected throw');
        } catch (e: any) {
          expect(e.message).to.match(/32 bytes, expected 64/);
        }
      });

      it('rejects a Solana keypair with non-byte entries', () => {
        const badKeypair = JSON.stringify(
          Array.from({ length: 64 }, (_, i) => (i === 0 ? 999 : 0)),
        );
        try {
          resolveUploadIdentity(
            { ...baseEnv, SOLANA_UPLOAD_KEYPAIR_PATH: '/keys/bad.json' },
            makeLoaders({ '/keys/bad.json': badKeypair }),
            makeLog(),
          );
          expect.fail('expected throw');
        } catch (e: any) {
          expect(e.message).to.match(/non-byte entries/);
        }
      });

      it('rejects an Ethereum hex key dropped into the Solana keypair slot', () => {
        try {
          resolveUploadIdentity(
            { ...baseEnv, SOLANA_UPLOAD_KEYPAIR_PATH: '/keys/eth.hex' },
            makeLoaders({ '/keys/eth.hex': validEthHex }),
            makeLog(),
          );
          expect.fail('expected throw');
        } catch (e: any) {
          expect(e.message).to.match(/32-byte hex string/);
          expect(e.message).to.match(/ETHEREUM_UPLOAD_PRIVATE_KEY_FILE/);
        }
      });
    });

    describe('precedence + conflict detection', () => {
      it('Arweave wins over Ethereum + Solana when all three are set', () => {
        try {
          resolveUploadIdentity(
            {
              ...baseEnv,
              ARWEAVE_UPLOAD_JWK: validJwkJson,
              ETHEREUM_UPLOAD_PRIVATE_KEY: validEthHex,
              SOLANA_UPLOAD_KEYPAIR_PATH: '/keys/sol.json',
            },
            makeLoaders({ '/keys/sol.json': solanaKeypairJson }),
            makeLog(),
          );
          expect.fail('expected throw');
        } catch (e: any) {
          // Conflict policy: refuse rather than silently pick one.
          expect(e.message).to.match(/ambiguous/);
          expect(e.message).to.match(/arweave/);
          expect(e.message).to.match(/ethereum/);
          expect(e.message).to.match(/solana/);
        }
      });

      it('throws on two-chain conflict with full env list', () => {
        try {
          resolveUploadIdentity(
            {
              ...baseEnv,
              ARWEAVE_UPLOAD_KEY_FILE: '/keys/jwk.json',
              ETHEREUM_UPLOAD_PRIVATE_KEY: validEthHex,
            },
            makeLoaders({ '/keys/jwk.json': validJwkJson }),
            makeLog(),
          );
          expect.fail('expected throw');
        } catch (e: any) {
          expect(e.message).to.match(/ARWEAVE_UPLOAD_KEY_FILE/);
          expect(e.message).to.match(/ETHEREUM_UPLOAD_PRIVATE_KEY/);
        }
      });

      it('allows multiple envs WITHIN the same chain group (e.g. both Arweave envs)', () => {
        // Both Arweave envs set isn't a conflict (they're alternatives
        // within the Arweave group; KEY_FILE > JWK env per precedence).
        const id = resolveUploadIdentity(
          {
            ...baseEnv,
            ARWEAVE_UPLOAD_KEY_FILE: '/keys/jwk.json',
            ARWEAVE_UPLOAD_JWK: validJwkJson,
          },
          makeLoaders({ '/keys/jwk.json': validJwkJson }),
          makeLog(),
        );
        expect(id.mode).to.equal('arweave');
        if (id.mode === 'arweave') {
          expect(id.source).to.equal('file'); // KEY_FILE wins
        }
      });

      it('explicit SOLANA_UPLOAD_KEYPAIR_PATH wins over fallback', () => {
        const id = resolveUploadIdentity(
          { ...baseEnv, SOLANA_UPLOAD_KEYPAIR_PATH: '/keys/explicit.json' },
          makeLoaders({
            '/keys/explicit.json': solanaKeypairJson,
            '/keys/fallback.json': solanaKeypairJson,
          }),
          makeLog(),
          '/keys/fallback.json',
        );
        expect(id.mode).to.equal('solana');
        if (id.mode === 'solana') {
          expect(id.path).to.equal('/keys/explicit.json');
        }
      });
    });
  });
});
