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
import { expect } from 'chai';
import { CID } from 'multiformats/cid';
import { sha256 } from 'multiformats/hashes/sha2';
import * as raw from 'multiformats/codecs/raw';

import { verifyBytesAgainstCid, isValidCid } from './ipfs-cid.js';

const DAG_PB_CODE = 0x70;

async function rawCidFor(bytes: Uint8Array): Promise<string> {
  const hash = await sha256.digest(bytes);
  return CID.create(1, raw.code, hash).toString();
}

describe('ipfs-cid', () => {
  describe('verifyBytesAgainstCid', () => {
    it('passes when bytes hash to a raw (single-block) CID', async () => {
      const bytes = new TextEncoder().encode('hello ar.io ipfs');
      const cid = await rawCidFor(bytes);
      expect(await verifyBytesAgainstCid(cid, bytes)).to.equal('pass');
    });

    it('passes for a dag-pb (UnixFS root) block — verification is codec-agnostic', async () => {
      // The CID of a dag-pb block is the hash of the block bytes themselves —
      // exactly what ?format=raw returns for a UnixFS root. We don't need to
      // parse the block; matching the multihash is the proof.
      const block = new Uint8Array([10, 20, 30, 40, 50]);
      const hash = await sha256.digest(block);
      const cid = CID.create(1, DAG_PB_CODE, hash).toString();
      expect(await verifyBytesAgainstCid(cid, block)).to.equal('pass');
    });

    it('fails when the bytes are tampered', async () => {
      const bytes = new TextEncoder().encode('original content');
      const cid = await rawCidFor(bytes);
      const tampered = new TextEncoder().encode('original contenX');
      expect(await verifyBytesAgainstCid(cid, tampered)).to.equal('fail');
    });

    it('fails when the CID names entirely different content', async () => {
      const cidA = await rawCidFor(new TextEncoder().encode('A'));
      const bytesB = new TextEncoder().encode('B');
      expect(await verifyBytesAgainstCid(cidA, bytesB)).to.equal('fail');
    });

    it('returns unsupported for a non-CID string (e.g. an Arweave tx id)', async () => {
      const arweaveId = 'zt6spBgLNvJ7cMxCVPtRbEnYr7A9zZ1YxtXmefGc7lk';
      expect(
        await verifyBytesAgainstCid(arweaveId, new Uint8Array([0])),
      ).to.equal('unsupported');
    });
  });

  describe('isValidCid', () => {
    it('accepts a v1 CID and rejects a non-CID', async () => {
      const cid = await rawCidFor(new TextEncoder().encode('x'));
      expect(isValidCid(cid)).to.equal(true);
      expect(isValidCid('not-a-cid')).to.equal(false);
    });
  });
});
