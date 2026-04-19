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
import { safeBigIntToNumber } from './tx-path-parser.js';
import { ChunkHeaderMetadata } from '../types.js';

export interface AnchoredChunkMetadata {
  txId: string;
  dataRoot: Buffer;
  txStartOffset: number;
  txEndOffset: number;
}

export class ChainAnchorMismatchError extends Error {
  readonly field: string;
  readonly headerValue: string;
  readonly chainValue: string;

  constructor(params: {
    field: string;
    headerValue: string | bigint;
    chainValue: string | bigint;
  }) {
    super(
      `Chain anchor mismatch on ${params.field}: header=${params.headerValue} chain=${params.chainValue}`,
    );
    this.name = 'ChainAnchorMismatchError';
    this.field = params.field;
    this.headerValue = String(params.headerValue);
    this.chainValue = String(params.chainValue);
  }
}

/**
 * Verify reference-gateway chunk header metadata against the chain and
 * return the chain-anchored view the caller should use for merkle proof
 * validation.
 *
 * The function is pure: it delegates HTTP to the provided fetchers and
 * performs no I/O of its own. On any disagreement between the header
 * values and the chain it throws ChainAnchorMismatchError — never silently
 * trust the reference gateway over the node.
 */
export async function anchorChunkMetadata(params: {
  headerMetadata: ChunkHeaderMetadata;
  offset: number;
  fetchTxOffset: (txId: string) => Promise<{ size: string; offset: string }>;
  fetchTransaction?: (txId: string) => Promise<{ data_root: string }>;
  anchorDataRoot?: boolean;
}): Promise<AnchoredChunkMetadata> {
  const {
    headerMetadata,
    offset,
    fetchTxOffset,
    fetchTransaction,
    anchorDataRoot = true,
  } = params;

  const chainOffset = await fetchTxOffset(headerMetadata.txId);
  const chainSize = BigInt(chainOffset.size);
  const chainEnd = BigInt(chainOffset.offset);
  const chainStart = chainEnd - chainSize + 1n;

  if (chainSize !== headerMetadata.txDataSize) {
    throw new ChainAnchorMismatchError({
      field: 'txDataSize',
      headerValue: headerMetadata.txDataSize,
      chainValue: chainSize,
    });
  }

  if (chainStart !== headerMetadata.txStartOffset) {
    throw new ChainAnchorMismatchError({
      field: 'txStartOffset',
      headerValue: headerMetadata.txStartOffset,
      chainValue: chainStart,
    });
  }

  const offsetBig = BigInt(offset);
  if (offsetBig < chainStart || offsetBig > chainEnd) {
    throw new ChainAnchorMismatchError({
      field: 'offsetInRange',
      headerValue: offsetBig,
      chainValue: `[${chainStart}, ${chainEnd}]`,
    });
  }

  if (anchorDataRoot) {
    if (fetchTransaction === undefined) {
      throw new Error(
        'anchorDataRoot requested but no fetchTransaction provided',
      );
    }
    const tx = await fetchTransaction(headerMetadata.txId);
    if (tx.data_root !== headerMetadata.dataRoot) {
      throw new ChainAnchorMismatchError({
        field: 'dataRoot',
        headerValue: headerMetadata.dataRoot,
        chainValue: tx.data_root,
      });
    }
  }

  return {
    txId: headerMetadata.txId,
    dataRoot: Buffer.from(headerMetadata.dataRoot, 'base64url'),
    txStartOffset: safeBigIntToNumber(chainStart, 'txStartOffset'),
    txEndOffset: safeBigIntToNumber(chainEnd, 'txEndOffset'),
  };
}
