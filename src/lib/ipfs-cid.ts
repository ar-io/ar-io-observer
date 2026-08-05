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
import { CID } from 'multiformats/cid';
import { sha256 } from 'multiformats/hashes/sha2';

export type CidVerification = 'pass' | 'fail' | 'unsupported';

/**
 * Trustlessly verify that `bytes` are the block the CID directly addresses — i.e.
 * what an IPFS trustless gateway returns for `?format=raw`. The CID's multihash is
 * the hash of exactly those bytes, so a match proves the gateway holds and served
 * the authentic addressed block, with no reference-gateway trust.
 *
 * SCOPE (important): this proves possession of the ADDRESSED BLOCK only.
 *  - raw-codec CID (0x55): the block IS the whole content — verification is
 *    complete.
 *  - dag-pb/UnixFS CID (0x70): the block is the DAG ROOT only. A match proves the
 *    gateway holds the authentic root manifest, but NOT that it holds/serves the
 *    leaf blocks, nor that its assembled (`GET /`) response returns the same
 *    bytes. Full-DAG / leaf verification and the assembled-path check are the
 *    deferred Phase 3 (IPFS block sampling, the analog of Arweave offset proofs).
 *
 * Returns:
 *  - 'pass'        the bytes hash to the CID's multihash
 *  - 'fail'        the bytes do NOT hash to the CID's multihash
 *  - 'unsupported' `cidString` is not a CID, or uses a multihash we can't verify
 *                  (only sha2-256 is supported today — it covers ~all IPFS content)
 */
export async function verifyBytesAgainstCid(
  cidString: string,
  bytes: Uint8Array,
): Promise<CidVerification> {
  let cid: CID;
  try {
    cid = CID.parse(cidString);
  } catch {
    // Not a CID (e.g. an Arweave transaction id) — nothing to verify here.
    return 'unsupported';
  }

  // Require a full sha2-256 multihash (code + 32-byte digest). A truncated or
  // otherwise malformed digest is 'unsupported' (-> neutral), not 'fail', so an
  // honest gateway serving the correct block is never failed on our inability to
  // verify the CID.
  if (
    cid.multihash.code !== sha256.code ||
    cid.multihash.digest.length !== 32
  ) {
    return 'unsupported';
  }

  const computed = await sha256.digest(bytes);
  return equalBytes(computed.digest, cid.multihash.digest) ? 'pass' : 'fail';
}

/** True if `cidString` parses as a valid CID. */
export function isValidCid(cidString: string): boolean {
  try {
    CID.parse(cidString);
    return true;
  } catch {
    return false;
  }
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
