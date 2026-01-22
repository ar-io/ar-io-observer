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
import { ReadThroughPromiseCache } from '@ardrive/ardrive-promise-cache';
import { Timings } from '@szmarczak/http-timer';
import { validatePath } from 'arweave/node/lib/merkle.js';
import got, { Got, RequestError, Response } from 'got';
import { LRUCache } from 'lru-cache';
import crypto from 'node:crypto';
import pMap from 'p-map';

import { MAX_FORK_DEPTH } from './arweave.js';
import * as config from './config.js';
import { BlockOffsetMapping } from './lib/block-offset-mapping.js';
import { customHashPRNG } from './lib/prng.js';
import {
  parseTxPath,
  safeBigIntToNumber,
  sortTxIdsByBinary,
} from './lib/tx-path-parser.js';
import log from './log.js';
import * as metrics from './metrics.js';

import {
  ArnsNameAssessment,
  ArnsNameAssessments,
  ArnsNamesSource,
  EntropySource,
  EpochTimestampSource,
  GatewayAssessments,
  GatewayHost,
  GatewayHostsSource,
  GatewayOffsetAssessments,
  HeightSource,
  ObserverReport,
  OffsetSamplingAssessment,
  OwnershipAssessment,
  ReferenceGatewaySource,
} from './types.js';

export const REPORT_FORMAT_VERSION = 2;

const NAME_PASS_THRESHOLD = 0.8;

interface ArnsResolution {
  statusCode: number;
  resolvedId: string | null;
  ttlSeconds: string | null;
  contentLength: string | null;
  contentType: string | null;
  dataHashDigest: string | null;
  timings: Timings | null;
}

interface ArweaveBlock {
  height: number;
  weave_size: string;
  tx_root?: string;
  txs: string[];
}

interface ArweaveTransactionOffset {
  size: string;
  offset: string;
}

interface ArweaveTransaction {
  id: string;
  data_root: string;
  data_size: string;
}

const client = got.extend({
  timeout: {
    lookup: 5000,
    connect: 5000,
    secureConnect: 2000,
    socket: 7000,
  },
});

export function generateRandomRanges({
  contentSize,
  rangeSize,
  rangeQuantity,
  rng,
}: {
  contentSize: number;
  rangeSize: number;
  rangeQuantity: number;
  rng: () => number;
}): string[] {
  const ranges: string[] = [];

  for (let i = 0; i < rangeQuantity; i++) {
    const maxStart = contentSize - rangeSize;
    const start = Math.floor(rng() * maxStart);
    const end = start + rangeSize - 1;
    ranges.push(`${start}-${end}`);
  }

  return ranges;
}

// TODO consider moving this into a resolver class
export async function getArnsResolution({
  url,
  got,
  referenceGatewayContentLength = null,
  entropy,
}: {
  url: string;
  got: Got;
  referenceGatewayContentLength?: string | null;
  entropy: Buffer;
}): Promise<ArnsResolution> {
  const MAX_BYTES_TO_PROCESS = 1048576; // 1MiB

  const arnsResolution = (response: Response, dataHashDigest?: string) => ({
    statusCode: response.statusCode,
    resolvedId:
      (response.headers['x-arns-resolved-id'] as string | undefined) ?? null,
    ttlSeconds:
      (response.headers['x-arns-ttl-seconds'] as string | undefined) ?? null,
    contentType:
      response.statusCode === 404
        ? null
        : ((response.headers['content-type'] as string | undefined) ?? null),
    contentLength:
      response.statusCode === 404
        ? null
        : (response.headers['content-length'] ?? null),
    dataHashDigest: dataHashDigest ?? null,
    timings: response.timings,
  });

  const dataHash = crypto.createHash('sha256');

  const getHashWithinFirstMiB = () => {
    return new Promise<ArnsResolution>((resolve, reject) => {
      const stream = got.stream.get(url, {
        headers: { 'Accept-Encoding': 'identity' },
      });
      let response: any;
      let streamBytesProcessed = 0;

      stream.on('error', (error: RequestError) => {
        if (error.response !== undefined && error.response.statusCode === 404) {
          resolve(arnsResolution(error.response));
        } else {
          reject(error);
        }
      });

      stream.on('response', (resp) => {
        response = resp;
      });

      stream.on('data', (data) => {
        const bytesToProcess = Math.min(
          data.length,
          MAX_BYTES_TO_PROCESS - streamBytesProcessed,
        );

        if (bytesToProcess > 0) {
          dataHash.update(data.slice(0, bytesToProcess));
          streamBytesProcessed += bytesToProcess;
        }

        if (streamBytesProcessed >= MAX_BYTES_TO_PROCESS) {
          stream.on('close', () => {
            resolve(arnsResolution(response, dataHash.digest('base64url')));
          });

          stream.destroy();
        }
      });

      stream.on('end', () => {
        resolve(arnsResolution(response, dataHash.digest('base64url')));
      });
    });
  };

  const getHashWithRangeRequests = () => {
    return new Promise<ArnsResolution>((resolve, reject) => {
      const rng = customHashPRNG(entropy);
      const ranges = generateRandomRanges({
        contentSize: +contentLength,
        rangeSize: 200,
        rangeQuantity: 5,
        rng,
      });

      Promise.all(
        ranges.map((range) =>
          got.get(url, {
            responseType: 'buffer',
            headers: {
              Range: `bytes=${range}`,
              'Accept-Encoding': 'identity',
            },
          }),
        ),
      )
        .then((rangeResponses) => {
          rangeResponses.forEach((response: Response<Buffer>) => {
            dataHash.update(response.body);
          });

          resolve(arnsResolution(headResponse, dataHash.digest('base64url')));
        })
        .catch((error) => {
          if ((error as any)?.response?.statusCode === 404) {
            resolve(arnsResolution(headResponse));
          } else {
            reject(error);
          }
        });
    });
  };

  let headResponse: Response;
  try {
    headResponse = await got.head(url);
  } catch (error: any) {
    if ((error as any)?.response?.statusCode === 404) {
      return arnsResolution(error.response);
    }

    throw error;
  }

  let contentLength: string;
  if (referenceGatewayContentLength !== null) {
    contentLength = referenceGatewayContentLength;
  } else {
    if (headResponse.headers['content-length'] !== undefined) {
      contentLength = headResponse.headers['content-length'];
    } else {
      return getHashWithinFirstMiB();
    }
  }

  if (+contentLength > MAX_BYTES_TO_PROCESS) {
    return getHashWithRangeRequests();
  }

  return getHashWithinFirstMiB();
}

export async function assessOwnership({
  host,
  expectedWallets,
}: {
  host: string;
  expectedWallets: string[];
}): Promise<OwnershipAssessment> {
  try {
    const url = `https://${host}/ar-io/info`;
    const resp = await client.get(url).json<any>();
    if (resp?.wallet) {
      if (!expectedWallets.includes(resp.wallet)) {
        const result = {
          expectedWallets,
          observedWallet: resp.wallet,
          failureReason: `Wallet mismatch: expected one of ${expectedWallets.join(
            ', ',
          )} but found ${resp.wallet}`,
          pass: false,
        };
        metrics.ownershipAssessmentsCounter.inc({
          status: 'fail',
          enforced: 'true',
        });
        return result;
      } else {
        const result = {
          expectedWallets,
          observedWallet: resp.wallet,
          pass: true,
        };
        metrics.ownershipAssessmentsCounter.inc({
          status: 'pass',
          enforced: 'true',
        });
        return result;
      }
    }
    const result = {
      expectedWallets,
      observedWallet: null,
      failureReason: `No wallet found`,
      pass: false,
    };
    metrics.ownershipAssessmentsCounter.inc({
      status: 'fail',
      enforced: 'true',
    });
    return result;
  } catch (error: any) {
    const result = {
      expectedWallets,
      observedWallet: null,
      failureReason: error?.message as string,
      pass: false,
    };
    metrics.ownershipAssessmentsCounter.inc({
      status: 'fail',
      enforced: 'true',
    });
    return result;
  }
}

export class Observer {
  private observerAddress: string;
  private referenceGateway: ReferenceGatewaySource;
  private arweaveHost: string;
  private epochSource: EpochTimestampSource;
  private observedGatewayHostList: GatewayHostsSource;
  private prescribedNamesSource: ArnsNamesSource;
  private chosenNamesSource: ArnsNamesSource;
  private gatewayAssessmentConcurrency: number;
  private nameAssessmentConcurrency: number;
  private nodeReleaseVersion: string;
  private entropySource: EntropySource;
  private heightSource: HeightSource;
  private gotClient: Got;
  private referenceGatewayResolutionCache?: ReadThroughPromiseCache<
    string,
    ArnsResolution
  >;
  // Caches for binary search data to avoid repeated API calls
  // LRU caches to prevent memory issues - store minimal data only
  // Optimized sizes: since we use the same maxStableOffset across all gateways,
  // cache efficiency is much higher due to shared search space
  private blockCache = new LRUCache<
    string,
    { weave_size: string; tx_root?: string; txIds: string[] }
  >({
    max: 2000, // Base cache size: blocks accessed during binary search, larger memory per entry
  });
  private transactionOffsetCache = new LRUCache<
    string,
    ArweaveTransactionOffset
  >({
    max: 10000, // 5x blocks: tiny objects, accessed frequently during transaction binary search, high reuse across gateways
  });
  private transactionCache = new LRUCache<string, { data_root: string }>({
    max: 10000, // 5x blocks: minimal memory per entry, same transactions accessed repeatedly for offset validation
  });
  private blockOffsetMapping?: BlockOffsetMapping;

  constructor({
    observerAddress,
    prescribedNamesSource,
    epochSource,
    chosenNamesSource,
    referenceGateway,
    arweaveUrl,
    observedGatewayHostList,
    gatewayAssessmentConcurrency,
    nameAssessmentConcurrency,
    nodeReleaseVersion,
    entropySource,
    heightSource,
  }: {
    observerAddress: string;
    referenceGateway: ReferenceGatewaySource;
    arweaveUrl: string;
    epochSource: EpochTimestampSource;
    observedGatewayHostList: GatewayHostsSource;
    prescribedNamesSource: ArnsNamesSource;
    chosenNamesSource: ArnsNamesSource;
    gatewayAssessmentConcurrency: number;
    nameAssessmentConcurrency: number;
    nodeReleaseVersion: string;
    entropySource: EntropySource;
    heightSource: HeightSource;
  }) {
    this.observerAddress = observerAddress;
    this.referenceGateway = referenceGateway;
    this.arweaveHost = new URL(arweaveUrl).host;
    this.epochSource = epochSource;
    this.observedGatewayHostList = observedGatewayHostList;
    this.prescribedNamesSource = prescribedNamesSource;
    this.chosenNamesSource = chosenNamesSource;
    this.gatewayAssessmentConcurrency = gatewayAssessmentConcurrency;
    this.nameAssessmentConcurrency = nameAssessmentConcurrency;
    this.nodeReleaseVersion = nodeReleaseVersion;
    this.entropySource = entropySource;
    this.heightSource = heightSource;
    this.gotClient = client.extend({
      headers: { 'X-AR-IO-Node-Release': this.nodeReleaseVersion },
    });

    // Initialize block offset mapping for optimized binary search
    if (config.BLOCK_OFFSET_MAPPING_ENABLED) {
      this.blockOffsetMapping = new BlockOffsetMapping({
        filePath: config.BLOCK_OFFSET_MAPPING_FILE,
      });
    }
  }

  private async getBlockByHeight(
    targetHost: string,
    height: number,
  ): Promise<ArweaveBlock> {
    const cacheKey = `${targetHost}:${height}`;

    // Check cache first
    const cachedBlock = this.blockCache.get(cacheKey);
    if (cachedBlock !== undefined) {
      const weaveOffset = parseInt(cachedBlock.weave_size, 10);

      log.debug('Block data retrieved from cache', {
        targetHost,
        height,
        cacheHit: true,
        weaveSizeStr: cachedBlock.weave_size,
        weaveOffset,
        txCount: cachedBlock.txIds.length,
      });

      // Return a minimal ArweaveBlock object with only the fields we need
      return {
        height,
        weave_size: cachedBlock.weave_size,
        tx_root: cachedBlock.tx_root,
        txs: cachedBlock.txIds,
      };
    }

    const url = `https://${targetHost}/block/height/${height}`;

    log.debug('Fetching block data', {
      targetHost,
      height,
      cacheHit: false,
      url,
    });

    try {
      const response = await this.gotClient.get(url, {
        timeout: { request: 7000 },
        responseType: 'json',
      });

      const block = response.body as ArweaveBlock;

      // Cache only the minimal data we need to reduce memory usage
      const lightweightBlock = {
        weave_size: block.weave_size,
        tx_root: block.tx_root,
        txIds: block.txs, // txs is already string[] according to our interface
      };
      this.blockCache.set(cacheKey, lightweightBlock);

      const weaveOffset = parseInt(block.weave_size, 10);

      log.debug('Block data fetched and cached successfully', {
        targetHost,
        height,
        weaveSizeStr: block.weave_size,
        weaveOffset,
        txCount: block.txs.length,
      });

      return block;
    } catch (error: any) {
      const failureReason = error?.message?.slice(0, 512) || 'Unknown error';

      log.debug('Block fetch failed', {
        targetHost,
        height,
        error: failureReason,
        statusCode: error?.response?.statusCode,
      });

      throw new Error(`Failed to fetch block ${height}: ${failureReason}`);
    }
  }

  private async getTransactionOffset(
    targetHost: string,
    txId: string,
  ): Promise<ArweaveTransactionOffset> {
    const cacheKey = `${targetHost}:${txId}`;

    // Check cache first
    const cachedOffset = this.transactionOffsetCache.get(cacheKey);
    if (cachedOffset !== undefined) {
      log.debug('Transaction offset retrieved from cache', {
        targetHost,
        txId: txId.slice(0, 12) + '...',
        cacheHit: true,
        offset: cachedOffset.offset,
        size: cachedOffset.size,
      });
      return cachedOffset;
    }

    const url = `https://${targetHost}/tx/${txId}/offset`;

    log.debug('Fetching transaction offset', {
      targetHost,
      txId: txId.slice(0, 12) + '...',
      cacheHit: false,
      url,
    });

    try {
      const response = await this.gotClient.get(url, {
        timeout: { request: 7000 },
        responseType: 'json',
      });

      const offset = response.body as ArweaveTransactionOffset;

      // Cache the result
      this.transactionOffsetCache.set(cacheKey, offset);

      log.debug('Transaction offset fetched and cached successfully', {
        targetHost,
        txId: txId.slice(0, 12) + '...',
        offset: offset.offset,
        size: offset.size,
      });

      return offset;
    } catch (error: any) {
      const failureReason = error?.message?.slice(0, 512) || 'Unknown error';

      log.debug('Transaction offset fetch failed', {
        targetHost,
        txId: txId.slice(0, 12) + '...',
        error: failureReason,
        statusCode: error?.response?.statusCode,
      });

      throw new Error(
        `Failed to fetch transaction offset for ${txId}: ${failureReason}`,
      );
    }
  }

  private async getTransaction(
    targetHost: string,
    txId: string,
  ): Promise<ArweaveTransaction> {
    const cacheKey = `${targetHost}:${txId}`;

    // Check cache first
    const cachedTransaction = this.transactionCache.get(cacheKey);
    if (cachedTransaction !== undefined) {
      log.debug('Transaction data retrieved from cache', {
        targetHost,
        txId: txId.slice(0, 12) + '...',
        cacheHit: true,
        hasDataRoot: cachedTransaction.data_root !== undefined,
      });

      // Return a minimal ArweaveTransaction object with only the fields we need
      return {
        data_root: cachedTransaction.data_root,
      } as ArweaveTransaction;
    }

    const url = `https://${targetHost}/tx/${txId}`;

    log.debug('Fetching transaction data', {
      targetHost,
      txId: txId.slice(0, 12) + '...',
      cacheHit: false,
      url,
    });

    try {
      const response = await this.gotClient.get(url, {
        timeout: { request: 7000 },
        responseType: 'json',
      });

      const transaction = response.body as ArweaveTransaction;

      // Cache only the data we need to reduce memory usage
      const lightweightTransaction = {
        data_root: transaction.data_root,
      };
      this.transactionCache.set(cacheKey, lightweightTransaction);

      log.debug('Transaction data fetched and cached successfully', {
        targetHost,
        txId: txId.slice(0, 12) + '...',
        hasDataRoot: transaction.data_root !== undefined,
        dataSize: transaction.data_size,
      });

      return transaction;
    } catch (error: any) {
      const failureReason = error?.message?.slice(0, 512) || 'Unknown error';

      log.debug('Transaction fetch failed', {
        targetHost,
        txId: txId.slice(0, 12) + '...',
        error: failureReason,
        statusCode: error?.response?.statusCode,
      });

      throw new Error(`Failed to fetch transaction ${txId}: ${failureReason}`);
    }
  }

  private async binarySearchBlocks(
    targetHost: string,
    targetOffset: number,
    minHeight: number,
    maxHeight: number,
  ): Promise<number> {
    // Use offset mapping to narrow search bounds if available
    let effectiveMinHeight = minHeight;
    let effectiveMaxHeight = maxHeight;

    if (this.blockOffsetMapping?.isLoaded()) {
      const bounds = this.blockOffsetMapping.getSearchBounds(
        targetOffset,
        maxHeight,
      );
      if (bounds) {
        effectiveMinHeight = Math.max(minHeight, bounds.lowHeight);
        effectiveMaxHeight = Math.min(maxHeight, bounds.highHeight);

        const originalRange = maxHeight - minHeight;
        const reductionPercent =
          originalRange > 0
            ? (
                (1 -
                  (effectiveMaxHeight - effectiveMinHeight) / originalRange) *
                100
              ).toFixed(1)
            : '0.0';

        log.debug('Using narrowed search bounds from offset mapping', {
          targetOffset,
          originalRange: `${minHeight}-${maxHeight}`,
          narrowedRange: `${effectiveMinHeight}-${effectiveMaxHeight}`,
          reductionPercent,
        });
      }
    }

    log.debug('Starting binary search for blocks', {
      targetHost,
      targetOffset,
      minHeight: effectiveMinHeight,
      maxHeight: effectiveMaxHeight,
      range: effectiveMaxHeight - effectiveMinHeight,
    });

    let left = effectiveMinHeight;
    let right = effectiveMaxHeight;
    let iterations = 0;

    while (left <= right) {
      iterations++;
      const mid = Math.floor((left + right) / 2);

      log.debug('Binary search iteration - checking block', {
        targetHost,
        targetOffset,
        currentHeight: mid,
        left,
        right,
        iteration: iterations,
      });

      try {
        // Use arweave host for trusted block data
        const block = await this.getBlockByHeight(this.arweaveHost, mid);
        const weaveSizeNum = parseInt(block.weave_size, 10);

        // Check if this is the containing block
        if (targetOffset <= weaveSizeNum) {
          // Check if the previous block (if it exists) has a smaller weave_size
          if (mid === effectiveMinHeight) {
            // This is the first block we're checking, it contains the offset
            log.debug('Found containing block (first in range)', {
              targetHost,
              targetOffset,
              blockHeight: mid,
              weaveSizeNum,
              iterations,
            });
            metrics.blockSearchIterationsHistogram.observe(iterations);
            return mid;
          }

          // Check previous block
          try {
            // Use arweave host for trusted block data
            const prevBlock = await this.getBlockByHeight(
              this.arweaveHost,
              mid - 1,
            );
            const prevWeaveSizeNum = parseInt(prevBlock.weave_size, 10);

            if (targetOffset > prevWeaveSizeNum) {
              // Target offset is between previous and current block
              log.debug('Found containing block', {
                targetHost,
                targetOffset,
                blockHeight: mid,
                weaveSizeNum,
                prevWeaveSizeNum,
                iterations,
              });
              metrics.blockSearchIterationsHistogram.observe(iterations);
              return mid;
            } else {
              // Target offset is in an earlier block
              right = mid - 1;
            }
          } catch (prevBlockError) {
            // If we can't fetch the previous block, assume current block contains it
            log.debug(
              'Cannot fetch previous block, assuming current contains offset',
              {
                targetHost,
                targetOffset,
                blockHeight: mid,
                weaveSizeNum,
                prevBlockError: (prevBlockError as any)?.message,
                iterations,
              },
            );
            metrics.blockSearchIterationsHistogram.observe(iterations);
            return mid;
          }
        } else {
          // Target offset is beyond this block's weave_size, search higher
          left = mid + 1;
        }
      } catch (blockError: any) {
        log.debug('Failed to fetch block during binary search', {
          targetHost,
          targetOffset,
          blockHeight: mid,
          error: blockError?.message,
        });
        // Skip this block and continue searching
        if (targetOffset > 0) {
          left = mid + 1;
        } else {
          right = mid - 1;
        }
      }
    }

    throw new Error(
      `Could not find block containing offset ${targetOffset} in range ${effectiveMinHeight}-${effectiveMaxHeight}`,
    );
  }

  private async binarySearchTransactions(
    targetHost: string,
    targetOffset: number,
    txIds: string[],
  ): Promise<string> {
    log.debug('Starting binary search for transactions', {
      targetHost,
      targetOffset,
      txCount: txIds.length,
    });

    // Sort transaction IDs by their binary representation (same as Arweave does)
    const sortedTxIds = sortTxIdsByBinary(txIds);

    log.debug('Transaction IDs sorted for binary search', {
      targetHost,
      targetOffset,
      originalOrder: txIds.slice(0, 3),
      sortedOrder: sortedTxIds.slice(0, 3),
      sortingNeeded: JSON.stringify(txIds) !== JSON.stringify(sortedTxIds),
    });

    let left = 0;
    let right = sortedTxIds.length - 1;

    while (left <= right) {
      const mid = Math.floor((left + right) / 2);
      const txId = sortedTxIds[mid]; // Uses sorted order

      log.debug('Binary search iteration - checking transaction', {
        targetHost,
        targetOffset,
        currentIndex: mid,
        txId: txId.slice(0, 12) + '...',
        left,
        right,
      });

      try {
        // Use arweave host for trusted transaction data
        const txOffset = await this.getTransactionOffset(
          this.arweaveHost,
          txId,
        );
        const txEndOffset = parseInt(txOffset.offset, 10);
        const txSize = parseInt(txOffset.size, 10);
        const txStartOffset = txEndOffset - txSize + 1;

        log.debug('Transaction boundaries calculated', {
          targetHost,
          targetOffset,
          txId: txId.slice(0, 12) + '...',
          txStartOffset,
          txEndOffset,
          txSize,
        });

        if (targetOffset >= txStartOffset && targetOffset <= txEndOffset) {
          // Found the containing transaction
          log.debug('Found containing transaction', {
            targetHost,
            targetOffset,
            txId: txId.slice(0, 12) + '...',
            txStartOffset,
            txEndOffset,
          });
          return txId;
        } else if (targetOffset < txStartOffset) {
          // Target offset is before this transaction, search left half
          right = mid - 1;
        } else {
          // Target offset is after this transaction, search right half
          left = mid + 1;
        }
      } catch (txError: any) {
        log.debug('Failed to fetch transaction offset during binary search', {
          targetHost,
          targetOffset,
          txId: txId.slice(0, 12) + '...',
          error: txError?.message,
        });
        // Skip this transaction and continue searching
        left = mid + 1;
      }
    }

    throw new Error(
      `Could not find transaction containing offset ${targetOffset} in ${sortedTxIds.length} transactions`,
    );
  }

  private async findTransactionForOffset(
    targetHost: string,
    targetOffset: number,
    maxSearchHeight: number,
    preFoundBlockHeight?: number,
  ): Promise<{
    txId: string;
    dataRoot: string;
    txStartOffset: number;
    txEndOffset: number;
  }> {
    log.debug('Starting transaction search for offset', {
      targetHost,
      targetOffset,
      preFoundBlockHeight,
    });

    try {
      // Use pre-found block height if available, otherwise binary search
      let containingBlockHeight: number;

      if (preFoundBlockHeight !== undefined) {
        containingBlockHeight = preFoundBlockHeight;
        log.debug('Using pre-found block height, skipping block search', {
          targetHost,
          targetOffset,
          containingBlockHeight,
        });
      } else {
        // Use pre-calculated stable search range for consistency and cache efficiency
        const minHeight = 1;
        const maxHeight = maxSearchHeight;

        log.debug('Using pre-calculated block search range', {
          targetHost,
          targetOffset,
          minHeight,
          maxHeight,
          searchRange: maxHeight - minHeight,
        });

        // Binary search for the containing block
        containingBlockHeight = await this.binarySearchBlocks(
          targetHost,
          targetOffset,
          minHeight,
          maxHeight,
        );
      }

      // Get the block data using arweave host
      const block = await this.getBlockByHeight(
        this.arweaveHost,
        containingBlockHeight,
      );

      log.debug('Found containing block, searching transactions', {
        targetHost,
        targetOffset,
        blockHeight: containingBlockHeight,
        txCount: block.txs.length,
      });

      // Binary search for the containing transaction within the block
      const txId = await this.binarySearchTransactions(
        targetHost,
        targetOffset,
        block.txs,
      );

      // Get the transaction data to extract data_root and calculate boundaries using arweave host
      const transaction = await this.getTransaction(this.arweaveHost, txId);

      if (
        transaction.data_root === undefined ||
        transaction.data_root === null
      ) {
        throw new Error(
          `Transaction ${txId} has no data_root - cannot validate chunks`,
        );
      }

      // Get the transaction offset to calculate boundaries using arweave host
      const txOffset = await this.getTransactionOffset(this.arweaveHost, txId);
      const txEndOffset = parseInt(txOffset.offset, 10);
      const txSize = parseInt(txOffset.size, 10);
      const txStartOffset = txEndOffset - txSize + 1;

      log.debug('Successfully found transaction and data_root', {
        targetHost,
        targetOffset,
        txId: txId.slice(0, 12) + '...',
        blockHeight: containingBlockHeight,
        hasDataRoot: true,
        txStartOffset,
        txEndOffset,
        txSize,
      });

      return {
        txId,
        dataRoot: transaction.data_root,
        txStartOffset,
        txEndOffset,
      };
    } catch (error: any) {
      log.debug('Failed to find transaction for offset', {
        targetHost,
        targetOffset,
        error: error?.message,
        stack: error?.stack,
      });
      throw error;
    }
  }

  /**
   * Attempts to parse the tx_path Merkle proof to extract transaction boundaries
   * and data_root without expensive binary search through transactions.
   *
   * Returns null if parsing fails, allowing fallback to binary search.
   */
  private async tryParseTxPath(params: {
    txPath: string;
    targetOffset: number;
    containingBlockHeight: number;
  }): Promise<{
    dataRoot: Buffer;
    txStartOffset: number;
    txEndOffset: number;
  } | null> {
    const { txPath, targetOffset, containingBlockHeight } = params;

    if (!config.TX_PATH_PARSING_ENABLED) {
      metrics.txPathParsingCounter.inc({ status: 'skipped' });
      return null;
    }

    try {
      // Get current block for tx_root and weave_size using arweave host
      const block = await this.getBlockByHeight(
        this.arweaveHost,
        containingBlockHeight,
      );

      if (
        block.tx_root === undefined ||
        block.tx_root === null ||
        block.tx_root.length === 0
      ) {
        log.debug('TX path parsing skipped: block has no tx_root', {
          blockHeight: containingBlockHeight,
        });
        metrics.txPathParsingCounter.inc({ status: 'skipped' });
        return null;
      }

      // Get previous block weave_size for relative offset calculation using arweave host
      let prevBlockWeaveSize = BigInt(0);
      if (containingBlockHeight > 0) {
        const prevBlock = await this.getBlockByHeight(
          this.arweaveHost,
          containingBlockHeight - 1,
        );
        prevBlockWeaveSize = BigInt(prevBlock.weave_size);
      }

      const txPathBuffer = Buffer.from(txPath, 'base64url');
      const txRootBuffer = Buffer.from(block.tx_root, 'base64url');

      const { result, rejectionReason } = await parseTxPath({
        txRoot: txRootBuffer,
        txPath: txPathBuffer,
        targetOffset: BigInt(targetOffset),
        blockWeaveSize: BigInt(block.weave_size),
        prevBlockWeaveSize,
      });

      if (result === null) {
        log.debug('TX path parsing failed', {
          targetOffset,
          blockHeight: containingBlockHeight,
          rejectionReason,
        });
        metrics.txPathParsingCounter.inc({ status: 'failure' });
        return null;
      }

      log.debug('TX path parsing succeeded', {
        targetOffset,
        blockHeight: containingBlockHeight,
        txStartOffset: result.txStartOffset.toString(),
        txEndOffset: result.txEndOffset.toString(),
        txSize: result.txSize.toString(),
      });

      metrics.txPathParsingCounter.inc({ status: 'success' });

      return {
        dataRoot: result.dataRoot,
        txStartOffset: safeBigIntToNumber(
          result.txStartOffset,
          'txStartOffset',
        ),
        txEndOffset: safeBigIntToNumber(result.txEndOffset, 'txEndOffset'),
      };
    } catch (error: any) {
      log.debug('TX path parsing threw error', {
        targetOffset,
        blockHeight: containingBlockHeight,
        error: error?.message,
      });
      metrics.txPathParsingCounter.inc({ status: 'failure' });
      return null;
    }
  }

  private performQuickChunkValidation({
    chunkResponse,
    chunkData,
    targetHost,
    offset,
  }: {
    chunkResponse: {
      chunk: string;
      data_path: string;
      tx_path?: string;
      packing?: string;
    };
    chunkData: Buffer;
    targetHost: string;
    offset: number;
  }): { isValid: boolean; failureReason?: string } {
    // Check if chunk data is empty
    if (chunkData.length === 0) {
      log.debug('Quick validation failed: empty chunk data', {
        targetHost,
        offset,
      });
      return {
        isValid: false,
        failureReason: 'Chunk data is empty',
      };
    }

    // Check if chunk data is suspiciously large (>1MB chunks are unusual)
    if (chunkData.length > 1024 * 1024) {
      log.debug('Quick validation failed: chunk data too large', {
        targetHost,
        offset,
        chunkSize: chunkData.length,
      });
      return {
        isValid: false,
        failureReason: `Chunk data too large: ${chunkData.length} bytes`,
      };
    }

    // Check if data_path exists and is not empty
    if (!chunkResponse.data_path || chunkResponse.data_path.length === 0) {
      log.debug('Quick validation failed: missing data_path', {
        targetHost,
        offset,
        hasDataPath: !!chunkResponse.data_path,
        dataPathLength: chunkResponse.data_path?.length || 0,
      });
      return {
        isValid: false,
        failureReason: 'Missing or empty data_path',
      };
    }

    // Try to parse data_path as base64url to ensure it's valid
    try {
      const proof = Buffer.from(chunkResponse.data_path, 'base64url');
      if (proof.length === 0) {
        log.debug('Quick validation failed: empty proof after decoding', {
          targetHost,
          offset,
          dataPathLength: chunkResponse.data_path.length,
        });
        return {
          isValid: false,
          failureReason: 'data_path decodes to empty proof',
        };
      }
    } catch (proofError: any) {
      log.debug('Quick validation failed: invalid data_path encoding', {
        targetHost,
        offset,
        dataPath: chunkResponse.data_path.slice(0, 50) + '...',
        error: proofError?.message,
      });
      return {
        isValid: false,
        failureReason: `Invalid data_path encoding: ${proofError?.message}`,
      };
    }

    log.debug('Quick chunk validation passed', {
      targetHost,
      offset,
      chunkSize: chunkData.length,
      proofLength: chunkResponse.data_path.length,
    });

    return { isValid: true };
  }

  private async validateChunkAtOffset({
    targetHost,
    offset,
    maxSearchHeight,
  }: {
    targetHost: string;
    offset: number;
    maxSearchHeight: number;
  }): Promise<OffsetSamplingAssessment> {
    const assessedAt = +(Date.now() / 1000).toFixed(0);

    const url = `https://${targetHost}/chunk/${offset}`;

    log.debug('Starting chunk validation', {
      targetHost,
      offset,
      url,
    });

    const startTime = Date.now();
    const offsetValidationTimer =
      metrics.offsetValidationHistogram.startTimer();

    try {
      // Fetch chunk data and proof from gateway

      const response = await this.gotClient.get(url, {
        timeout: { request: 7000 },
        responseType: 'json',
      });

      const chunkResponse = response.body as {
        chunk: string;
        data_path: string;
        tx_path?: string;
        packing?: string;
      };

      const chunkData = Buffer.from(chunkResponse.chunk, 'base64url');
      const chunkHash = crypto
        .createHash('sha256')
        .update(chunkData)
        .digest('base64url');

      const duration = Date.now() - startTime;
      const sizeKB = Math.round(chunkData.length / 1024);

      log.debug('Chunk fetched successfully', {
        targetHost,
        offset,
        url,
        chunkHash,
        sizeKB,
        durationMs: duration,
        statusCode: response.statusCode,
      });

      // Quick validation checks before expensive binary search
      const quickValidationResult = this.performQuickChunkValidation({
        chunkResponse,
        chunkData,
        targetHost,
        offset,
      });

      if (!quickValidationResult.isValid) {
        offsetValidationTimer();
        return {
          assessedAt,
          offset,
          pass: false,
          failureReason: quickValidationResult.failureReason,
          referenceGatewayAvailable: undefined, // Skip reference check for invalid chunks
        };
      }

      // Run reference gateway check and binary search in parallel for efficiency
      const [referenceGatewayAvailable, transactionSearchResult] =
        await Promise.all([
          // Check if reference gateway also has this chunk (for comparison)
          (async (): Promise<boolean | undefined> => {
            try {
              log.debug('Checking reference gateway chunk availability', {
                targetHost,
                offset,
              });

              const { host: referenceHost, available } =
                await this.referenceGateway.checkChunkAvailability({ offset });

              log.debug('Reference gateway chunk check completed', {
                targetHost,
                referenceHost,
                offset,
                available,
              });

              return available;
            } catch (referenceError: any) {
              log.debug('Reference gateway chunk check failed', {
                targetHost,
                offset,
                error: referenceError?.message,
              });
              return false;
            }
          })(),

          // Get the data_root for validation - try TX path parsing first, then binary search
          (async (): Promise<{
            effectiveDataRoot?: Uint8Array;
            txStartOffset?: number;
            txEndOffset?: number;
          }> => {
            try {
              // Step 1: Find the containing block (with offset mapping optimization)
              log.debug('Finding containing block for offset', {
                targetHost,
                offset,
              });

              const containingBlockHeight = await this.binarySearchBlocks(
                targetHost,
                offset,
                1,
                maxSearchHeight,
              );

              // Step 2: Try TX path parsing if tx_path is present
              if (
                chunkResponse.tx_path !== undefined &&
                chunkResponse.tx_path.length > 0
              ) {
                const txPathResult = await this.tryParseTxPath({
                  txPath: chunkResponse.tx_path,
                  targetOffset: offset,
                  containingBlockHeight,
                });

                if (txPathResult) {
                  log.debug(
                    'TX path parsing succeeded, skipping transaction binary search',
                    {
                      targetHost,
                      offset,
                      txStartOffset: txPathResult.txStartOffset,
                      txEndOffset: txPathResult.txEndOffset,
                    },
                  );

                  return {
                    effectiveDataRoot: txPathResult.dataRoot,
                    txStartOffset: txPathResult.txStartOffset,
                    txEndOffset: txPathResult.txEndOffset,
                  };
                }

                log.debug(
                  'TX path parsing failed, falling back to binary search',
                  {
                    targetHost,
                    offset,
                  },
                );
              }

              // Step 3: Fall back to transaction binary search (reuse block we already found)
              log.debug('Finding transaction for offset using binary search', {
                targetHost,
                offset,
                containingBlockHeight,
              });

              const transactionInfo = await this.findTransactionForOffset(
                targetHost,
                offset,
                maxSearchHeight,
                containingBlockHeight,
              );

              const effectiveDataRoot = Buffer.from(
                transactionInfo.dataRoot,
                'base64url',
              );

              log.debug('Found transaction and data_root via binary search', {
                targetHost,
                offset,
                txId: transactionInfo.txId.slice(0, 12) + '...',
                dataRootLength: effectiveDataRoot.length,
                txStartOffset: transactionInfo.txStartOffset,
                txEndOffset: transactionInfo.txEndOffset,
              });

              return {
                effectiveDataRoot,
                txStartOffset: transactionInfo.txStartOffset,
                txEndOffset: transactionInfo.txEndOffset,
              };
            } catch (searchError: any) {
              log.debug('Transaction search failed', {
                targetHost,
                offset,
                error: searchError?.message,
              });
              return {};
            }
          })(),
        ]);

      // Extract results from parallel operations
      const { effectiveDataRoot, txStartOffset, txEndOffset } =
        transactionSearchResult;

      // Get chunk proof from the data_path field in the response
      let proof: Uint8Array | null = null;

      if (chunkResponse.data_path && chunkResponse.data_path.length > 0) {
        try {
          proof = Buffer.from(chunkResponse.data_path, 'base64url');
          log.debug('Found chunk proof in response data_path', {
            targetHost,
            offset,
            proofLength: proof.length,
          });
        } catch (proofError: any) {
          log.debug('Failed to parse proof from data_path', {
            targetHost,
            offset,
            dataPath: chunkResponse.data_path.slice(0, 50) + '...',
            error: proofError?.message,
          });
        }
      } else {
        log.debug('No data_path found in chunk response', {
          targetHost,
          offset,
          responseKeys: Object.keys(chunkResponse),
        });
      }

      // Attempt validation if we have all required components
      if (
        effectiveDataRoot &&
        proof &&
        proof.length > 0 &&
        txStartOffset !== undefined &&
        txEndOffset !== undefined
      ) {
        try {
          // Calculate relative offset within the transaction and transaction size
          const relativeOffset = offset - txStartOffset;
          const txSize = txEndOffset - txStartOffset + 1;

          // Use ar-io-node pattern: relativeOffset with bounds [0, txSize]
          const result = await validatePath(
            effectiveDataRoot,
            relativeOffset,
            0,
            txSize,
            proof,
          );

          if (result !== false) {
            log.debug('Chunk validation succeeded', {
              targetHost,
              offset,
              relativeOffset,
              txSize,
              txStartOffset,
              txEndOffset,
              validationResult: result,
            });

            log.verbose(
              `Chunk validation PASSED for ${targetHost} at offset ${offset}` +
                (referenceGatewayAvailable !== undefined
                  ? ` (reference gateway: ${referenceGatewayAvailable ? 'available' : 'unavailable'})`
                  : ''),
            );

            offsetValidationTimer();
            return {
              assessedAt,
              offset,
              pass: true,
              referenceGatewayAvailable,
            };
          } else {
            log.debug('Chunk validation failed - validatePath returned false', {
              targetHost,
              offset,
              relativeOffset,
              txSize,
              txStartOffset,
              txEndOffset,
              dataRootLength: effectiveDataRoot.length,
              proofLength: proof.length,
            });

            log.verbose(
              `Chunk validation FAILED for ${targetHost} at offset ${offset}` +
                (referenceGatewayAvailable !== undefined
                  ? ` (reference gateway: ${referenceGatewayAvailable ? 'available' : 'unavailable'})`
                  : ''),
            );

            offsetValidationTimer();
            return {
              assessedAt,
              offset,
              pass: false,
              failureReason: 'Merkle proof validation failed',
              referenceGatewayAvailable,
            };
          }
        } catch (validationError: any) {
          log.debug('Chunk validation threw error', {
            targetHost,
            offset,
            error: validationError?.message,
            stack: validationError?.stack,
          });

          offsetValidationTimer();
          return {
            assessedAt,
            offset,
            pass: false,
            failureReason: `Validation error: ${validationError?.message}`,
            referenceGatewayAvailable,
          };
        }
      } else {
        // Missing required validation components
        const missing: string[] = [];
        if (!effectiveDataRoot) missing.push('data_root');
        if (proof === null || proof.length === 0) missing.push('proof');
        if (txStartOffset === undefined || txEndOffset === undefined)
          missing.push('transaction_bounds');

        log.debug('Cannot validate chunk - missing required components', {
          targetHost,
          offset,
          missing,
          hasDataRoot: !!effectiveDataRoot,
          hasProof: proof !== null,
          proofLength: proof !== null ? proof.length : 0,
          hasTxBounds: txStartOffset !== undefined && txEndOffset !== undefined,
        });

        offsetValidationTimer();
        return {
          assessedAt,
          offset,
          pass: false,
          failureReason: `Missing validation components: ${missing.join(', ')}`,
          referenceGatewayAvailable,
        };
      }
    } catch (error: any) {
      const duration = Date.now() - startTime;
      const failureReason = error?.message?.slice(0, 512) || 'Unknown error';

      log.debug('Chunk validation failed with error', {
        targetHost,
        offset,
        url,
        error: failureReason,
        statusCode: error?.response?.statusCode,
        durationMs: duration,
      });

      log.verbose(
        `Chunk fetch failed from ${url}: ${error?.response?.statusCode || 'network error'}`,
      );

      offsetValidationTimer();
      return {
        assessedAt,
        offset,
        pass: false,
        failureReason: `Network error: ${failureReason}`,
        referenceGatewayAvailable: undefined, // Can't check reference gateway if target fetch failed
      };
    }
  }

  private async assessGatewayOffsets({
    targetHost,
    entropy,
    offsetSampleCount,
    maxStableOffset,
    maxSearchHeight,
  }: {
    targetHost: string;
    entropy: Buffer;
    offsetSampleCount: number;
    maxStableOffset: number;
    maxSearchHeight: number;
  }): Promise<GatewayOffsetAssessments> {
    log.verbose(`Starting offset validation for gateway: ${targetHost}`);

    log.debug('Gateway offset assessment parameters', {
      targetHost,
      offsetSampleCount,
      entropyLength: entropy.length,
    });

    try {
      log.debug('Using pre-calculated max stable offset', {
        targetHost,
        maxStableOffset,
      });

      if (maxStableOffset <= 0) {
        log.debug(
          'Max stable offset is zero or negative, skipping assessment',
          {
            targetHost,
            maxStableOffset,
          },
        );

        return {
          plannedOffsets: [],
          assessments: [],
          pass: false,
        };
      }

      // Generate random offsets using deterministic PRNG
      const offsetSeed = Buffer.concat([entropy, Buffer.from(targetHost)]);
      const rng = customHashPRNG(offsetSeed);

      const plannedOffsets: number[] = [];
      for (let i = 0; i < offsetSampleCount; i++) {
        const randomOffset = Math.floor(rng() * maxStableOffset);
        plannedOffsets.push(randomOffset);
      }

      log.debug('Random offsets selected deterministically', {
        targetHost,
        plannedOffsets,
        maxStableOffset,
        offsetSampleCount,
        seedLength: offsetSeed.length,
      });

      // Validate each offset with early stopping
      const startTime = Date.now();
      const assessments: OffsetSamplingAssessment[] = [];
      let validatedOffset: number | undefined;

      for (const offset of plannedOffsets) {
        log.debug('Validating offset', {
          targetHost,
          offset,
          attemptNumber: assessments.length + 1,
          totalPlanned: plannedOffsets.length,
        });

        const assessment = await this.validateChunkAtOffset({
          targetHost,
          offset,
          maxSearchHeight,
        });

        assessments.push(assessment);

        // Early stopping: if validation passes, we're done
        if (assessment.pass) {
          validatedOffset = offset;

          log.debug('Chunk validated successfully - early stopping', {
            targetHost,
            validatedOffset,
            attemptNumber: assessments.length,
            totalPlanned: plannedOffsets.length,
          });

          break;
        }

        log.debug('Chunk validation failed, trying next offset', {
          targetHost,
          failedOffset: offset,
          failureReason: assessment.failureReason,
          remainingOffsets: plannedOffsets.length - assessments.length,
        });
      }

      const totalDuration = Date.now() - startTime;
      const pass = validatedOffset !== undefined;

      log.debug('Offset validation completed', {
        targetHost,
        plannedOffsets: plannedOffsets.length,
        actualAssessments: assessments.length,
        validatedOffset,
        pass,
        totalDurationMs: totalDuration,
      });

      log.verbose(
        `Offset validation completed for ${targetHost}: ${pass ? 'PASS' : 'FAIL'}` +
          (validatedOffset !== undefined
            ? ` (validated offset: ${validatedOffset})`
            : '') +
          ` (${assessments.length}/${plannedOffsets.length} offsets checked)`,
      );

      return {
        plannedOffsets,
        assessments,
        validatedOffset,
        pass,
      };
    } catch (error: any) {
      log.debug('Gateway offset assessment failed with error', {
        targetHost,
        error: error?.message,
        stack: error?.stack,
      });

      return {
        plannedOffsets: [],
        assessments: [],
        pass: false,
      };
    }
  }

  async assessArnsName({
    host,
    arnsName,
    entropy,
  }: {
    host: string;
    arnsName: string;
    entropy: Buffer;
  }): Promise<ArnsNameAssessment> {
    // TODO instantiate cache in constructor
    // Currently not possible because we only have access to epochStartHeight in generateReport
    if (this.referenceGatewayResolutionCache === undefined) {
      throw new Error('Reference gateway resolution cache not set');
    }

    const referenceResolution =
      await this.referenceGatewayResolutionCache.get(arnsName);

    const arnsResolutionTimer = metrics.arnsResolutionHistogram.startTimer();
    const gatewayResolution = await getArnsResolution({
      url: `https://${arnsName}.${host}/`,
      got: this.gotClient,
      referenceGatewayContentLength: referenceResolution.contentLength,
      entropy,
    });
    arnsResolutionTimer();

    let pass = true;
    let failureReason: string | undefined = undefined;

    const checkedProperties: Array<keyof ArnsResolution> = [
      'resolvedId',
      'ttlSeconds',
      'contentType',
      'dataHashDigest',
    ];
    for (const property of checkedProperties) {
      if (referenceResolution[property] !== gatewayResolution[property]) {
        pass = false;
        failureReason =
          (failureReason !== undefined ? failureReason + ', ' : '') +
          `${property} mismatch`;
      }
    }

    return {
      assessedAt: +(Date.now() / 1000).toFixed(0),
      expectedStatusCode: referenceResolution.statusCode,
      resolvedStatusCode: gatewayResolution.statusCode,
      expectedId: referenceResolution.resolvedId ?? null,
      resolvedId: gatewayResolution.resolvedId ?? null,
      expectedDataHash: referenceResolution.dataHashDigest ?? null,
      resolvedDataHash: gatewayResolution.dataHashDigest ?? null,
      failureReason,
      pass,
      timings: gatewayResolution?.timings?.phases,
    };
  }

  // TODO add port
  async assessArnsNames({
    host,
    names,
    entropy,
  }: {
    host: string;
    names: string[];
    entropy: Buffer;
  }): Promise<ArnsNameAssessments> {
    return pMap(
      names,
      async (name) => {
        try {
          return await this.assessArnsName({
            host,
            arnsName: name,
            entropy,
          });
        } catch (err) {
          const errorMessage =
            typeof err === 'object' &&
            err !== null &&
            'message' in err &&
            typeof err.message === 'string'
              ? err.message
              : undefined;
          return {
            assessedAt: +(Date.now() / 1000).toFixed(0),
            expectedId: null,
            resolvedId: null,
            expectedDataHash: null,
            resolvedDataHash: null,
            failureReason: errorMessage?.slice(0, 512),
            pass: false,
          };
        }
      },
      { concurrency: this.nameAssessmentConcurrency },
    ).then((results) => {
      return results.reduce((assessments, assessment, index) => {
        assessments[names[index]] = assessment;
        return assessments;
      }, {} as ArnsNameAssessments);
    });
  }

  private async runSingleObservation(
    epochStartTimestamp: number,
    epochEndTimestamp: number,
    epochStartHeight: number,
    epochIndex: number,
    prescribedNames: string[],
    chosenNames: string[],
    gatewayHosts: GatewayHost[],
    hostWallets: { [key: string]: string[] },
    entropy: Buffer,
  ): Promise<ObserverReport> {
    const gatewayAssessments: GatewayAssessments = {};

    // Calculate stable search parameters once for the entire observation
    // All gateways will use the same search space for consistency and cache efficiency
    let maxStableOffset = 0;
    let maxSearchHeight = 1;

    if (config.OFFSET_OBSERVATION_ENABLED) {
      const currentHeight = await this.heightSource.getHeight();
      maxSearchHeight = Math.max(1, currentHeight - MAX_FORK_DEPTH);

      // Get the weave size at the stable height to determine max stable offset
      const stableBlock = await this.getBlockByHeight(
        this.arweaveHost,
        maxSearchHeight,
      );
      maxStableOffset = parseInt(stableBlock.weave_size, 10);

      log.debug('Stable search parameters calculated for observation', {
        currentHeight,
        maxSearchHeight,
        maxStableOffset,
      });
    }

    // Shuffle the gateway hosts for this observation
    const shuffledGatewayHosts = [...gatewayHosts].sort(
      () => Math.random() - 0.5,
    );

    // Deterministically select gateways for offset observations based on sample rate
    const selectedGatewaysForOffset = new Set<string>();
    if (
      config.OFFSET_OBSERVATION_ENABLED &&
      config.OFFSET_OBSERVATION_SAMPLE_RATE > 0
    ) {
      const gatewayCount = shuffledGatewayHosts.length;
      const offsetObservationCount = Math.max(
        1, // Always test at least 1 gateway if sampling is enabled
        Math.ceil(gatewayCount * config.OFFSET_OBSERVATION_SAMPLE_RATE),
      );

      // Use entropy to deterministically select gateways
      // Create a deterministic seed by combining observation entropy with a constant
      const selectionSeed = Buffer.concat([
        entropy,
        Buffer.from('offset-selection'),
      ]);
      const prng = customHashPRNG(selectionSeed);

      // Create a copy of gateway hosts for selection (don't modify the original shuffle)
      const gatewaySelection = [...shuffledGatewayHosts];

      // Fisher-Yates shuffle with deterministic PRNG to select subset
      for (
        let i = 0;
        i < offsetObservationCount && i < gatewaySelection.length;
        i++
      ) {
        const randomIndex =
          Math.floor(prng() * (gatewaySelection.length - i)) + i;
        const selected = gatewaySelection[randomIndex];

        // Swap selected gateway to position i
        gatewaySelection[randomIndex] = gatewaySelection[i];
        gatewaySelection[i] = selected;

        selectedGatewaysForOffset.add(selected.fqdn);
      }

      log.debug('Selected gateways for offset observations', {
        totalGateways: gatewayCount,
        sampleRate: config.OFFSET_OBSERVATION_SAMPLE_RATE,
        selectedCount: selectedGatewaysForOffset.size,
        selectedGateways: Array.from(selectedGatewaysForOffset).sort(),
      });
    }

    this.referenceGatewayResolutionCache = new ReadThroughPromiseCache<
      string,
      ArnsResolution
    >({
      cacheParams: {
        cacheCapacity: prescribedNames.length + chosenNames.length,
        cacheTTL: 5 * 60_000, // 5 minutes
      },
      readThroughFunction: async (name: string) => {
        const { resolution } = await this.referenceGateway.getArnsResolution({
          arnsName: name,
          entropy,
        });
        return resolution;
      },
    });

    await pMap(
      shuffledGatewayHosts,
      async (host) => {
        // Run ownership assessment first, then other assessments in parallel
        const ownershipAssessment = await assessOwnership({
          host: host.fqdn,
          expectedWallets: hostWallets[host.fqdn].sort(),
        });

        const [[prescribedAssessments, chosenAssessments], offsetAssessments] =
          await Promise.all([
            // ArNS name assessments (prescribed and chosen in parallel)
            Promise.all([
              this.assessArnsNames({
                host: host.fqdn,
                names: prescribedNames,
                entropy,
              }),
              this.assessArnsNames({
                host: host.fqdn,
                names: chosenNames,
                entropy,
              }),
            ]),

            // Offset sampling (if enabled and gateway is selected)
            config.OFFSET_OBSERVATION_ENABLED &&
            selectedGatewaysForOffset.has(host.fqdn)
              ? (async () => {
                  log.debug('Offset validation enabled, starting assessment', {
                    targetHost: host.fqdn,
                    offsetSampleCount: config.OFFSET_SAMPLE_COUNT,
                  });

                  try {
                    const result = await this.assessGatewayOffsets({
                      targetHost: host.fqdn,
                      entropy,
                      offsetSampleCount: config.OFFSET_SAMPLE_COUNT,
                      maxStableOffset,
                      maxSearchHeight,
                    });

                    log.verbose(
                      `Offset sampling completed for ${host.fqdn}: ${result.pass ? 'PASS' : 'FAIL'}`,
                    );

                    return result;
                  } catch (error: any) {
                    // Log the error but don't fail the assessment unless enforcement is enabled
                    log.warn('Offset sampling failed for gateway', {
                      targetHost: host.fqdn,
                      error: error?.message,
                      stack: error?.stack,
                      enforcementEnabled:
                        config.OFFSET_OBSERVATION_ENFORCEMENT_ENABLED,
                    });

                    // Keep console.warn for backward compatibility
                    console.warn(
                      `Offset sampling failed for ${host.fqdn}:`,
                      error?.message,
                    );

                    // Return a failed assessment if enforcement is enabled, otherwise undefined
                    return config.OFFSET_OBSERVATION_ENFORCEMENT_ENABLED
                      ? { plannedOffsets: [], assessments: [], pass: false }
                      : undefined;
                  }
                })()
              : (async () => {
                  const reason = !config.OFFSET_OBSERVATION_ENABLED
                    ? 'disabled'
                    : 'not selected for sampling';
                  log.verbose(
                    `Offset sampling ${reason}, skipping for ${host.fqdn}`,
                  );
                  return undefined;
                })(),
          ]);

        // Track ArNS assessment metrics
        Object.values(prescribedAssessments).forEach((assessment) => {
          metrics.arnsAssessmentsCounter.inc({
            type: 'prescribed',
            status: assessment.pass ? 'pass' : 'fail',
            enforced: 'true',
          });
        });

        Object.values(chosenAssessments).forEach((assessment) => {
          metrics.arnsAssessmentsCounter.inc({
            type: 'chosen',
            status: assessment.pass ? 'pass' : 'fail',
            enforced: 'true',
          });
        });

        // Track offset assessment metrics
        if (
          config.OFFSET_OBSERVATION_ENABLED &&
          selectedGatewaysForOffset.has(host.fqdn)
        ) {
          if (offsetAssessments !== undefined) {
            // Offset assessment was performed
            offsetAssessments.assessments.forEach((assessment) => {
              metrics.offsetAssessmentsCounter.inc({
                status: assessment.pass ? 'pass' : 'fail',
                enforced:
                  config.OFFSET_OBSERVATION_ENFORCEMENT_ENABLED.toString(),
              });
            });
          } else {
            // Offset assessment failed (returned undefined)
            metrics.offsetAssessmentsCounter.inc({
              status: 'fail',
              enforced:
                config.OFFSET_OBSERVATION_ENFORCEMENT_ENABLED.toString(),
            });
          }
        } else {
          // Offset assessment was skipped
          metrics.offsetAssessmentsCounter.inc({
            status: 'skipped',
            enforced: 'false',
          });
        }

        const nameCount = new Set([...prescribedNames, ...chosenNames]).size;
        const namePassCount = Object.values({
          ...prescribedAssessments,
          ...chosenAssessments,
        }).reduce(
          (count, assessment) => (assessment.pass ? count + 1 : count),
          0,
        );
        const namesPass = namePassCount >= nameCount * NAME_PASS_THRESHOLD;

        // Check if offset observation enforcement should affect pass status
        const offsetPass =
          !config.OFFSET_OBSERVATION_ENFORCEMENT_ENABLED ||
          offsetAssessments === undefined ||
          offsetAssessments.pass;

        const gatewayPass = ownershipAssessment.pass && namesPass && offsetPass;

        gatewayAssessments[host.fqdn] = {
          ownershipAssessment,
          arnsAssessments: {
            prescribedNames: prescribedAssessments,
            chosenNames: chosenAssessments,
            pass: namesPass,
          },
          ...(offsetAssessments !== undefined ? { offsetAssessments } : {}),
          pass: gatewayPass,
        };

        // Track gateway assessment metrics
        metrics.gatewayAssessmentsCounter.inc({
          status: gatewayPass ? 'pass' : 'fail',
        });
      },
      { concurrency: this.gatewayAssessmentConcurrency },
    );

    const report = {
      formatVersion: REPORT_FORMAT_VERSION,
      observerAddress: this.observerAddress,
      epochIndex,
      epochStartTimestamp,
      epochStartHeight,
      epochEndTimestamp,
      generatedAt: +(Date.now() / 1000).toFixed(0),
      gatewayAssessments,
    };

    // Track report generation metrics
    metrics.reportsGeneratedCounter.inc({ status: 'success' });

    // Update gauge metrics with latest report data
    const gatewayCount = Object.keys(gatewayAssessments).length;
    const failureRate = this.calculateFailureRate(report);

    metrics.lastReportGatewayCountGauge.set(gatewayCount);
    metrics.lastReportFailureRateGauge.set(failureRate);
    metrics.lastReportTimestampGauge.set(report.generatedAt);

    return report;
  }

  private calculateFailureRate(report: ObserverReport): number {
    let totalAssessments = 0;
    let failedAssessments = 0;

    Object.values(report.gatewayAssessments).forEach((gatewayAssessment) => {
      // Count ownership assessment
      totalAssessments++;
      if (!gatewayAssessment.ownershipAssessment.pass) {
        failedAssessments++;
      }

      // Count prescribed name assessments
      Object.values(gatewayAssessment.arnsAssessments.prescribedNames).forEach(
        (assessment) => {
          totalAssessments++;
          if (!assessment.pass) {
            failedAssessments++;
          }
        },
      );

      // Count chosen name assessments
      Object.values(gatewayAssessment.arnsAssessments.chosenNames).forEach(
        (assessment) => {
          totalAssessments++;
          if (!assessment.pass) {
            failedAssessments++;
          }
        },
      );
    });

    return totalAssessments > 0 ? failedAssessments / totalAssessments : 0;
  }

  async generateReport(): Promise<ObserverReport> {
    const epochStartTimestamp = await this.epochSource.getEpochStartTimestamp();
    const epochEndTimestamp = await this.epochSource.getEpochEndTimestamp();
    const epochStartHeight = await this.epochSource.getEpochStartHeight();
    const epochIndex = await this.epochSource.getEpochIndex();
    const prescribedNames = await this.prescribedNamesSource.getNames({
      epochIndex: epochIndex,
    });
    // observer will choose names based on the epoch start height
    const chosenNames = await this.chosenNamesSource.getNames({
      height: epochStartHeight,
    });

    // Assess gateway
    const gatewayHosts = await this.observedGatewayHostList.getHosts();

    // Create map of FQDN => hosts to handle duplicates
    const hostWallets: { [key: string]: string[] } = {};
    gatewayHosts.forEach((host) => {
      (hostWallets[host.fqdn] ||= []).push(host.wallet);
    });

    // use the epoch start height to compute entropy for
    const entropy = await this.entropySource.getEntropy({
      height: epochStartHeight,
    });

    // Run 2 observations serially
    const observations: ObserverReport[] = [];

    for (let i = 0; i < 2; i++) {
      const observation = await this.runSingleObservation(
        epochStartTimestamp,
        epochEndTimestamp,
        epochStartHeight,
        epochIndex,
        prescribedNames,
        chosenNames,
        gatewayHosts,
        hostWallets,
        entropy,
      );
      observations.push(observation);
    }

    // Calculate failure rates and select the observation with the lowest rate
    let bestObservation = observations[0];
    let lowestFailureRate = this.calculateFailureRate(observations[0]);

    for (let i = 1; i < observations.length; i++) {
      const failureRate = this.calculateFailureRate(observations[i]);
      if (failureRate < lowestFailureRate) {
        lowestFailureRate = failureRate;
        bestObservation = observations[i];
      }
    }

    return bestObservation;
  }
}
