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

import {
  resolveArweaveUploadJwk,
  resolveSolanaWallets,
  type ArweaveJwkLoader,
  type SolanaKeypairLoader,
  type SolanaSignerLike,
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
            SOLANA_UPLOAD_KEYPAIR_PATH: undefined,
          },
          undefined,
          loader,
          makeLog(),
        );
      } catch (e: any) {
        threw = true;
        expect(e.message).to.match(/SOLANA_KEYPAIR_PATH is required/);
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
            SOLANA_UPLOAD_KEYPAIR_PATH: undefined,
          },
          undefined,
          loader,
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
            SOLANA_UPLOAD_KEYPAIR_PATH: undefined,
          },
          jwk,
          loader,
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
            SOLANA_UPLOAD_KEYPAIR_PATH: '/keys/upload.json',
          },
          { kty: 'RSA', n: 'n' },
          loader,
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
            SOLANA_UPLOAD_KEYPAIR_PATH: '/keys/upload.json',
          },
          undefined,
          loader,
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
            SOLANA_UPLOAD_KEYPAIR_PATH: undefined,
          },
          jwk,
          loader,
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
            SOLANA_UPLOAD_KEYPAIR_PATH: undefined,
          },
          undefined,
          loader,
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
            SOLANA_UPLOAD_KEYPAIR_PATH: undefined,
          },
          undefined,
          loader,
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
  });
});
