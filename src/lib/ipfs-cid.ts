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
 * Trustlessly verify that `bytes` are the block named by `cidString`.
 *
 * The bytes MUST be the raw block the CID directly addresses — i.e. what an IPFS
 * trustless gateway returns for `?format=raw`. For a raw-codec CID that block is
 * the file itself; for a UnixFS/dag-pb CID it is the DAG's root block. In both
 * cases the CID's multihash is the hash of exactly those bytes, so a match proves
 * the gateway served the authentic block — no reference gateway required.
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

  if (cid.multihash.code !== sha256.code) {
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
