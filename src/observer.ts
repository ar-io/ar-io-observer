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
import log from './log.js';

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
    socket: 5000,
  },
});

export function customHashPRNG(seed: Buffer) {
  if (!Buffer.isBuffer(seed)) {
    throw new Error('Seed must be a Buffer.');
  }

  let currentHash = seed;

  return () => {
    // Create a new hash from the current hash
    const hash = crypto.createHash('sha256');
    hash.update(currentHash);
    currentHash = hash.digest();

    // Convert the hash to a floating-point number and return it
    const int = currentHash.readBigUInt64BE(0);
    return Number(int) / 2 ** 64;
  };
}

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

async function assessOwnership({
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
        return {
          expectedWallets,
          observedWallet: null,
          failureReason: `Wallet mismatch: expected one of ${expectedWallets.join(
            ', ',
          )} but found ${resp.wallet}`,
          pass: false,
        };
      } else {
        return {
          expectedWallets,
          observedWallet: resp.wallet,
          pass: true,
        };
      }
    }
    return {
      expectedWallets,
      observedWallet: null,
      failureReason: `No wallet found`,
      pass: false,
    };
  } catch (error: any) {
    return {
      expectedWallets,
      observedWallet: null,
      failureReason: error?.message as string,
      pass: false,
    };
  }
}

export class Observer {
  private observerAddress: string;
  private referenceGatewayHost: string;
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
    { weave_size: string; txIds: string[] }
  >({
    max: 2000, // Increased cache size - binary search benefits from more cached blocks
  });
  private transactionOffsetCache = new LRUCache<
    string,
    ArweaveTransactionOffset
  >({
    max: 2000, // 2x increase - small objects, high reuse across gateways
  });
  private transactionCache = new LRUCache<string, { data_root: string }>({
    max: 2000, // 4x increase - just data_root strings, highly reusable
  });

  constructor({
    observerAddress,
    prescribedNamesSource,
    epochSource,
    chosenNamesSource,
    referenceGatewayHost,
    observedGatewayHostList,
    gatewayAssessmentConcurrency,
    nameAssessmentConcurrency,
    nodeReleaseVersion,
    entropySource,
    heightSource,
  }: {
    observerAddress: string;
    referenceGatewayHost: string;
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
    this.referenceGatewayHost = referenceGatewayHost;
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
        timeout: { request: 5000 },
        responseType: 'json',
      });

      const block = response.body as ArweaveBlock;

      // Cache only the minimal data we need to reduce memory usage
      const lightweightBlock = {
        weave_size: block.weave_size,
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
        timeout: { request: 5000 },
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
        timeout: { request: 5000 },
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
    log.debug('Starting binary search for blocks', {
      targetHost,
      targetOffset,
      minHeight,
      maxHeight,
      range: maxHeight - minHeight,
    });

    let left = minHeight;
    let right = maxHeight;

    while (left <= right) {
      const mid = Math.floor((left + right) / 2);

      log.debug('Binary search iteration - checking block', {
        targetHost,
        targetOffset,
        currentHeight: mid,
        left,
        right,
      });

      try {
        // Use reference gateway for trusted block data
        const block = await this.getBlockByHeight(
          this.referenceGatewayHost,
          mid,
        );
        const weaveSizeNum = parseInt(block.weave_size, 10);

        // Check if this is the containing block
        if (targetOffset <= weaveSizeNum) {
          // Check if the previous block (if it exists) has a smaller weave_size
          if (mid === minHeight) {
            // This is the first block we're checking, it contains the offset
            log.debug('Found containing block (first in range)', {
              targetHost,
              targetOffset,
              blockHeight: mid,
              weaveSizeNum,
            });
            return mid;
          }

          // Check previous block
          try {
            // Use reference gateway for trusted block data
            const prevBlock = await this.getBlockByHeight(
              this.referenceGatewayHost,
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
              });
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
              },
            );
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
      `Could not find block containing offset ${targetOffset} in range ${minHeight}-${maxHeight}`,
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

    let left = 0;
    let right = txIds.length - 1;

    while (left <= right) {
      const mid = Math.floor((left + right) / 2);
      const txId = txIds[mid];

      log.debug('Binary search iteration - checking transaction', {
        targetHost,
        targetOffset,
        currentIndex: mid,
        txId: txId.slice(0, 12) + '...',
        left,
        right,
      });

      try {
        // Use reference gateway for trusted transaction data
        const txOffset = await this.getTransactionOffset(
          this.referenceGatewayHost,
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
      `Could not find transaction containing offset ${targetOffset} in ${txIds.length} transactions`,
    );
  }

  private async findTransactionForOffset(
    targetHost: string,
    targetOffset: number,
    maxSearchHeight: number,
  ): Promise<{
    txId: string;
    dataRoot: string;
    txStartOffset: number;
    txEndOffset: number;
  }> {
    log.debug('Starting transaction search for offset', {
      targetHost,
      targetOffset,
    });

    try {
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
      const containingBlockHeight = await this.binarySearchBlocks(
        targetHost,
        targetOffset,
        minHeight,
        maxHeight,
      );

      // Get the block data using reference gateway
      const block = await this.getBlockByHeight(
        this.referenceGatewayHost,
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

      // Get the transaction data to extract data_root and calculate boundaries using reference gateway
      const transaction = await this.getTransaction(
        this.referenceGatewayHost,
        txId,
      );

      if (
        transaction.data_root === undefined ||
        transaction.data_root === null
      ) {
        throw new Error(
          `Transaction ${txId} has no data_root - cannot validate chunks`,
        );
      }

      // Get the transaction offset to calculate boundaries using reference gateway
      const txOffset = await this.getTransactionOffset(
        this.referenceGatewayHost,
        txId,
      );
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

    try {
      // Fetch chunk data and proof from gateway

      const response = await this.gotClient.get(url, {
        timeout: { request: 5000 },
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

      // Check if reference gateway also has this chunk (for comparison)
      let referenceGatewayAvailable: boolean | undefined = undefined;
      try {
        const referenceUrl = `https://${this.referenceGatewayHost}/chunk/${offset}`;
        log.debug('Checking reference gateway chunk availability', {
          targetHost,
          referenceHost: this.referenceGatewayHost,
          offset,
          referenceUrl,
        });

        const referenceResponse = await this.gotClient.get(referenceUrl, {
          timeout: { request: 5000 },
          responseType: 'json',
        });

        // Consider it available if we get a successful response with valid structure
        const referenceChunkResponse = referenceResponse.body as {
          chunk?: string;
          data_path?: string;
        };

        referenceGatewayAvailable =
          referenceResponse.statusCode === 200 &&
          referenceChunkResponse.chunk !== undefined;

        log.debug('Reference gateway chunk check completed', {
          targetHost,
          referenceHost: this.referenceGatewayHost,
          offset,
          available: referenceGatewayAvailable,
          statusCode: referenceResponse.statusCode,
        });
      } catch (referenceError: any) {
        referenceGatewayAvailable = false;
        log.debug('Reference gateway chunk check failed', {
          targetHost,
          referenceHost: this.referenceGatewayHost,
          offset,
          error: referenceError?.message,
        });
      }

      // Get the data_root for validation using binary search
      let effectiveDataRoot: Uint8Array | undefined = undefined;
      let effectiveTxId: string | undefined = undefined;
      let txStartOffset: number | undefined = undefined;
      let txEndOffset: number | undefined = undefined;

      try {
        log.debug('Finding transaction for offset using binary search', {
          targetHost,
          offset,
        });

        const transactionInfo = await this.findTransactionForOffset(
          targetHost,
          offset,
          maxSearchHeight,
        );

        effectiveTxId = transactionInfo.txId;
        effectiveDataRoot = Buffer.from(transactionInfo.dataRoot, 'base64url');
        txStartOffset = transactionInfo.txStartOffset;
        txEndOffset = transactionInfo.txEndOffset;

        log.debug('Found transaction and data_root via binary search', {
          targetHost,
          offset,
          txId: effectiveTxId.slice(0, 12) + '...',
          dataRootLength: effectiveDataRoot.length,
          txStartOffset,
          txEndOffset,
        });
      } catch (searchError: any) {
        log.debug('Binary search for transaction failed', {
          targetHost,
          offset,
          error: searchError?.message,
        });
      }

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

    const gatewayResolution = await getArnsResolution({
      url: `https://${arnsName}.${host}/`,
      got: this.gotClient,
      referenceGatewayContentLength: referenceResolution.contentLength,
      entropy,
    });

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
        this.referenceGatewayHost,
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
      readThroughFunction: async (name: string) =>
        getArnsResolution({
          url: `https://${name}.${this.referenceGatewayHost}/`,
          got: this.gotClient,
          entropy,
        }),
    });

    await pMap(
      shuffledGatewayHosts,
      async (host) => {
        // Run all assessments in parallel for faster execution
        const [
          ownershipAssessment,
          [prescribedAssessments, chosenAssessments],
          offsetAssessments,
        ] = await Promise.all([
          // Ownership assessment
          assessOwnership({
            host: host.fqdn,
            expectedWallets: hostWallets[host.fqdn].sort(),
          }),

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
                  // Log the error but don't fail the assessment
                  log.warn('Offset sampling failed for gateway', {
                    targetHost: host.fqdn,
                    error: error?.message,
                    stack: error?.stack,
                  });

                  // Keep console.warn for backward compatibility
                  console.warn(
                    `Offset sampling failed for ${host.fqdn}:`,
                    error?.message,
                  );

                  return undefined;
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

        const nameCount = new Set([...prescribedNames, ...chosenNames]).size;
        const namePassCount = Object.values({
          ...prescribedAssessments,
          ...chosenAssessments,
        }).reduce(
          (count, assessment) => (assessment.pass ? count + 1 : count),
          0,
        );
        const namesPass = namePassCount >= nameCount * NAME_PASS_THRESHOLD;

        gatewayAssessments[host.fqdn] = {
          ownershipAssessment,
          arnsAssessments: {
            prescribedNames: prescribedAssessments,
            chosenNames: chosenAssessments,
            pass: namesPass,
          },
          ...(offsetAssessments !== undefined ? { offsetAssessments } : {}),
          pass: ownershipAssessment.pass && namesPass,
        };
      },
      { concurrency: this.gatewayAssessmentConcurrency },
    );

    return {
      formatVersion: REPORT_FORMAT_VERSION,
      observerAddress: this.observerAddress,
      epochIndex,
      epochStartTimestamp,
      epochStartHeight,
      epochEndTimestamp,
      generatedAt: +(Date.now() / 1000).toFixed(0),
      gatewayAssessments,
    };
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
