/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { expect } from 'chai';
import crypto from 'node:crypto';
import type { Signer } from '@dha-team/arbundles/node';

import { signerOwnerAddress } from './turbo-report-sink.js';

/**
 * Build a fake arbundles Signer carrying a raw pubkey buffer. The real
 * implementation only reads `.publicKey` (a `Buffer` of raw bytes), so
 * we can sub in any chain's pubkey shape without instantiating actual
 * keypairs: 512 bytes for ArweaveSigner (RSA-4096 modulus), 32 for
 * SolanaSigner (ed25519), 65 for EthereumSigner (secp256k1, uncompressed).
 */
function fakeSigner(pubkey: Buffer): Signer {
  return { publicKey: pubkey } as unknown as Signer;
}

describe('signerOwnerAddress', () => {
  it('returns base64url(sha256(publicKey)) for a 32-byte (Solana-shape) pubkey', () => {
    const pubkey = Buffer.from(
      '01'.repeat(32), // 32 bytes, distinct from zero
      'hex',
    );
    const expected = crypto
      .createHash('sha256')
      .update(pubkey)
      .digest()
      .toString('base64url');
    expect(signerOwnerAddress(fakeSigner(pubkey))).to.equal(expected);
  });

  it('returns base64url(sha256(publicKey)) for a 65-byte (Ethereum-shape) pubkey', () => {
    const pubkey = Buffer.concat([Buffer.from([0x04]), Buffer.alloc(64, 0xaa)]);
    const expected = crypto
      .createHash('sha256')
      .update(pubkey)
      .digest()
      .toString('base64url');
    expect(signerOwnerAddress(fakeSigner(pubkey))).to.equal(expected);
  });

  it('returns base64url(sha256(publicKey)) for a 512-byte (Arweave RSA-4096) pubkey', () => {
    // Use a random-looking but deterministic 512-byte modulus.
    const pubkey = crypto
      .createHash('sha512')
      .update('arweave-modulus')
      .digest();
    const modulus = Buffer.concat([pubkey, pubkey, pubkey, pubkey]); // 256 bytes
    const fullModulus = Buffer.concat([modulus, modulus]); // 512 bytes
    const expected = crypto
      .createHash('sha256')
      .update(fullModulus)
      .digest()
      .toString('base64url');
    expect(signerOwnerAddress(fakeSigner(fullModulus))).to.equal(expected);
  });

  it('produces a 43-character base64url string (Arweave-style address)', () => {
    // SHA-256 → 32 bytes → 43 chars base64url (no padding).
    const pubkey = Buffer.from('abcd'.repeat(8), 'utf-8');
    const addr = signerOwnerAddress(fakeSigner(pubkey));
    expect(addr).to.have.length(43);
    // base64url charset: A-Z, a-z, 0-9, -, _
    expect(addr).to.match(/^[A-Za-z0-9_-]+$/);
  });

  it('is deterministic — same pubkey always yields the same owner address', () => {
    const pubkey = Buffer.from('ff'.repeat(32), 'hex');
    const a = signerOwnerAddress(fakeSigner(pubkey));
    const b = signerOwnerAddress(fakeSigner(pubkey));
    expect(a).to.equal(b);
  });

  it('different pubkeys produce different owner addresses', () => {
    const a = signerOwnerAddress(
      fakeSigner(Buffer.from('00'.repeat(32), 'hex')),
    );
    const b = signerOwnerAddress(
      fakeSigner(Buffer.from('01'.repeat(32), 'hex')),
    );
    expect(a).to.not.equal(b);
  });
});
