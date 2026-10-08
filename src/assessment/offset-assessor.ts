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
import { validatePath } from 'arweave/node/lib/merkle.js';
import { Got } from 'got';
import { LRUCache } from 'lru-cache';
import crypto from 'node:crypto';

import * as config from '../config.js';
import { BlockOffsetMapping } from '../lib/block-offset-mapping.js';
import {
  AnchoredChunkMetadata,
  ChainAnchorMismatchError,
  anchorChunkMetadata,
} from '../lib/chunk-metadata-anchor.js';
import { customHashPRNG } from '../lib/prng.js';
import {
  parseTxPath,
  safeBigIntToNumber,
  sortTxIdsByBinary,
} from '../lib/tx-path-parser.js';
import log from '../log.js';
import * as metrics from '../metrics.js';
import {
  ChunkHeaderMetadata,
  GatewayOffsetAssessments,
  OffsetFailureCategory,
  OffsetSamplingAssessment,
  ReferenceGatewaySource,
} from '../types.js';

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

/**
 * Categorise an error thrown while fetching `/chunk/<offset>` from the
 * gateway under assessment.
 */
export function classifyChunkFetchError(error: any): OffsetFailureCategory {
  if (error?.name === 'TimeoutError' || error?.code === 'ETIMEDOUT') {
    return 'timeout';
  }
  if (error?.name === 'ParseError') {
    // 2xx with a body that is not chunk JSON
    return 'invalid_chunk';
  }
  if (error?.response?.statusCode !== undefined) {
    return 'http_status';
  }
  return 'network';
}

/**
 * Deterministically choose which gateways get an offset (chunk-proof)
 * assessment this epoch.
 *
 * Picks `max(1, ceil(n * sampleRate))` gateways with a Fisher-Yates
 * partial shuffle driven by `entropy` + "offset-selection". The result
 * depends on the ORDER of `fqdns` as well as the entropy, so callers
 * that need independent observers to agree must pass a canonical order
 * (the continuous observer sorts). Returns an empty set when sampling is
 * disabled or the rate is zero.
 */
export function selectGatewaysForOffsetAssessment({
  fqdns,
  entropy,
  enabled,
  sampleRate,
}: {
  fqdns: string[];
  entropy: Buffer;
  enabled: boolean;
  sampleRate: number;
}): Set<string> {
  const selected = new Set<string>();
  if (!enabled || sampleRate <= 0 || fqdns.length === 0) {
    return selected;
  }

  const offsetObservationCount = Math.max(
    1, // Always test at least 1 gateway if sampling is enabled
    Math.ceil(fqdns.length * sampleRate),
  );

  // Create a deterministic seed by combining observation entropy with a constant
  const selectionSeed = Buffer.concat([
    entropy,
    Buffer.from('offset-selection'),
  ]);
  const prng = customHashPRNG(selectionSeed);

  // Copy so the caller's order is not modified
  const selection = [...fqdns];

  // Fisher-Yates shuffle with deterministic PRNG to select subset
  for (let i = 0; i < offsetObservationCount && i < selection.length; i++) {
    const randomIndex = Math.floor(prng() * (selection.length - i)) + i;
    const chosen = selection[randomIndex];

    // Swap selected gateway to position i
    selection[randomIndex] = selection[i];
    selection[i] = chosen;

    selected.add(chosen);
  }

  return selected;
}

/**
 * Whether a gateway's offset result lets it pass, under the rule the batch
 * observer has used since r54. Only a performed, failed assessment with
 * enforcement on can fail a gateway.
 */
export function offsetAssessmentPasses({
  offsetAssessments,
  enforcementEnabled,
}: {
  offsetAssessments: GatewayOffsetAssessments | undefined;
  enforcementEnabled: boolean;
}): boolean {
  return (
    !enforcementEnabled ||
    offsetAssessments === undefined ||
    offsetAssessments.pass
  );
}

/**
 * Count offset assessments in `offsetAssessmentsCounter`, as the batch
 * observer always has.
 */
export function recordOffsetAssessmentMetrics({
  sampled,
  offsetAssessments,
  enforcementEnabled,
}: {
  sampled: boolean;
  offsetAssessments: GatewayOffsetAssessments | undefined;
  enforcementEnabled: boolean;
}): void {
  if (!sampled) {
    // Offset assessment was skipped
    metrics.offsetAssessmentsCounter.inc({
      status: 'skipped',
      enforced: 'false',
    });
    return;
  }

  if (offsetAssessments !== undefined) {
    // Offset assessment was performed
    offsetAssessments.assessments.forEach((assessment) => {
      metrics.offsetAssessmentsCounter.inc({
        status: assessment.pass ? 'pass' : 'fail',
        enforced: enforcementEnabled.toString(),
      });
    });
  } else {
    // Offset assessment failed (returned undefined)
    metrics.offsetAssessmentsCounter.inc({
      status: 'fail',
      enforced: enforcementEnabled.toString(),
    });
  }
}

/**
 * Validates that a gateway serves chunks whose Merkle proofs check out
 * against the chain (PE-8524). Shared by the batch `Observer` and the
 * `ContinuousObserver`.
 *
 * For each sampled gateway it picks `offsetSampleCount` offsets
 * deterministically from (entropy, gateway FQDN), fetches
 * `/chunk/<offset>` from the gateway, and validates the `data_path`
 * proof with arweave-js `validatePath` against a data_root and tx bounds
 * taken from the chain (reference chunk headers anchored to the chain,
 * or a binary search over blocks). It stops at the first offset that
 * validates, so a gateway fails only when every planned offset fails.
 *
 * The caches are shared across gateways and observations because every
 * gateway draws offsets from the same stable weave range.
 */
export class OffsetAssessor {
  private readonly referenceGateway: ReferenceGatewaySource;
  private readonly arweaveBaseUrl: string;
  private readonly gotClient: Got;
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
  // Chain-anchored metadata per tx: caches the cross-check of reference-gateway
  // chunk headers against /tx/{id}/offset (+ optional /tx/{id}) so repeated
  // offsets inside the same tx pay zero additional node calls.
  private anchoredTxMetadataCache = new LRUCache<string, AnchoredChunkMetadata>(
    {
      max: 10000,
    },
  );
  private blockOffsetMapping?: BlockOffsetMapping;

  constructor({
    referenceGateway,
    arweaveUrl,
    gotClient,
  }: {
    referenceGateway: ReferenceGatewaySource;
    arweaveUrl: string;
    gotClient: Got;
  }) {
    this.referenceGateway = referenceGateway;
    this.arweaveBaseUrl = new URL(arweaveUrl).origin;
    this.gotClient = gotClient;

    // Initialize block offset mapping for optimized binary search
    if (config.BLOCK_OFFSET_MAPPING_ENABLED) {
      this.blockOffsetMapping = new BlockOffsetMapping({
        filePath: config.BLOCK_OFFSET_MAPPING_FILE,
      });
    }
  }

  /**
   * Weave size at `height` from the configured Arweave node: the upper
   * bound (exclusive) of offsets that are stable at that height.
   */
  async getWeaveSizeAtHeight(height: number): Promise<number> {
    const block = await this.getBlockByHeight(this.arweaveBaseUrl, height);
    return parseInt(block.weave_size, 10);
  }

  /**
   * Run the offset assessment for one sampled gateway, handling errors as
   * the batch observer always has: an unexpected error is a failed
   * assessment when enforcement is on, and "not assessed" (undefined)
   * when it is off.
   */
  async assessSampledGateway({
    targetHost,
    entropy,
    offsetSampleCount,
    maxStableOffset,
    maxSearchHeight,
    enforcementEnabled,
  }: {
    targetHost: string;
    entropy: Buffer;
    offsetSampleCount: number;
    maxStableOffset: number;
    maxSearchHeight: number;
    enforcementEnabled: boolean;
  }): Promise<GatewayOffsetAssessments | undefined> {
    log.debug('Offset validation enabled, starting assessment', {
      targetHost,
      offsetSampleCount,
    });

    try {
      const result = await this.assessGatewayOffsets({
        targetHost,
        entropy,
        offsetSampleCount,
        maxStableOffset,
        maxSearchHeight,
      });

      log.verbose(
        `Offset sampling completed for ${targetHost}: ${result.pass ? 'PASS' : 'FAIL'}`,
      );

      return result;
    } catch (error: any) {
      // Log the error but don't fail the assessment unless enforcement is enabled
      log.warn('Offset sampling failed for gateway', {
        targetHost,
        error: error?.message,
        stack: error?.stack,
        enforcementEnabled,
      });

      // Keep console.warn for backward compatibility
      console.warn(`Offset sampling failed for ${targetHost}:`, error?.message);

      // Return a failed assessment if enforcement is enabled, otherwise undefined
      return enforcementEnabled
        ? { plannedOffsets: [], assessments: [], pass: false }
        : undefined;
    }
  }

  async getBlockByHeight(
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

    const url = `${targetHost}/block/height/${height}`;

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

    const url = `${targetHost}/tx/${txId}/offset`;

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

    const url = `${targetHost}/tx/${txId}`;

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
        const block = await this.getBlockByHeight(this.arweaveBaseUrl, mid);
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
              this.arweaveBaseUrl,
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
          this.arweaveBaseUrl,
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
        this.arweaveBaseUrl,
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
      const transaction = await this.getTransaction(this.arweaveBaseUrl, txId);

      if (
        transaction.data_root === undefined ||
        transaction.data_root === null
      ) {
        throw new Error(
          `Transaction ${txId} has no data_root - cannot validate chunks`,
        );
      }

      // Get the transaction offset to calculate boundaries using arweave host
      const txOffset = await this.getTransactionOffset(
        this.arweaveBaseUrl,
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
        this.arweaveBaseUrl,
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
          this.arweaveBaseUrl,
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

  /**
   * Resolve the transaction containing `offset` to yield its data_root and
   * weave bounds, anchored against the chain.
   *
   * Fast path: HEAD the reference gateway's `/chunk/{offset}/data`, read
   * the `x-arweave-chunk-*` headers, and cross-check them against the
   * Arweave node via `/tx/{id}/offset` (plus `/tx/{id}` for data_root).
   * On success this costs one HEAD and one O(1) node lookup per unique
   * tx, versus ~20-30 node calls for the binary-search fallback.
   *
   * On any mismatch or when the reference gateway omits the headers the
   * method logs and returns null so the caller falls back to the
   * existing chain-search path. The reference gateway's headers are
   * never trusted over the chain.
   */
  private async resolveTxBoundsViaReferenceHeaders(
    offset: number,
    targetHost: string,
  ): Promise<{
    effectiveDataRoot: Uint8Array;
    txStartOffset: number;
    txEndOffset: number;
  } | null> {
    let metadata: ChunkHeaderMetadata | null;
    try {
      const result = await this.referenceGateway.getChunkMetadata({
        offset,
        excludeFqdns: [targetHost],
      });
      metadata = result.metadata;
    } catch (error: any) {
      log.debug('Reference chunk metadata fetch failed', {
        offset,
        error: error?.message,
      });
      metrics.chunkMetadataAnchorCounter.inc({ result: 'error' });
      return null;
    }

    if (metadata === null) {
      metrics.chunkMetadataAnchorCounter.inc({ result: 'metadata_missing' });
      return null;
    }

    const cached = this.anchoredTxMetadataCache.get(metadata.txId);
    if (cached !== undefined) {
      const cachedTxStartOffset = BigInt(cached.txStartOffset);
      const cachedTxDataSize =
        BigInt(cached.txEndOffset) - cachedTxStartOffset + 1n;
      if (
        offset < cached.txStartOffset ||
        offset > cached.txEndOffset ||
        metadata.txStartOffset !== cachedTxStartOffset ||
        metadata.txDataSize !== cachedTxDataSize ||
        cached.dataRoot.toString('base64url') !== metadata.dataRoot
      ) {
        log.warn('Cached anchored metadata inconsistent with new headers', {
          offset,
          txId: metadata.txId.slice(0, 12) + '...',
          headerTxStartOffset: metadata.txStartOffset.toString(),
          cachedTxStartOffset: cachedTxStartOffset.toString(),
          headerTxDataSize: metadata.txDataSize.toString(),
          cachedTxDataSize: cachedTxDataSize.toString(),
        });
        metrics.chunkMetadataAnchorCounter.inc({ result: 'mismatch' });
        return null;
      }
      metrics.chunkMetadataAnchorCounter.inc({ result: 'cache_hit' });
      return {
        effectiveDataRoot: cached.dataRoot,
        txStartOffset: cached.txStartOffset,
        txEndOffset: cached.txEndOffset,
      };
    }

    try {
      const anchored = await anchorChunkMetadata({
        headerMetadata: metadata,
        offset,
        fetchTxOffset: (txId) =>
          this.getTransactionOffset(this.arweaveBaseUrl, txId),
        fetchTransaction: async (txId) => {
          const tx = await this.getTransaction(this.arweaveBaseUrl, txId);
          return { data_root: tx.data_root };
        },
      });
      this.anchoredTxMetadataCache.set(metadata.txId, anchored);
      metrics.chunkMetadataAnchorCounter.inc({ result: 'hit' });
      return {
        effectiveDataRoot: anchored.dataRoot,
        txStartOffset: anchored.txStartOffset,
        txEndOffset: anchored.txEndOffset,
      };
    } catch (error: any) {
      if (error instanceof ChainAnchorMismatchError) {
        log.warn('Chain anchor mismatch; falling back to chain search', {
          offset,
          txId: metadata.txId.slice(0, 12) + '...',
          field: error.field,
          headerValue: error.headerValue,
          chainValue: error.chainValue,
        });
        metrics.chunkMetadataAnchorCounter.inc({ result: 'mismatch' });
      } else {
        log.debug('Chain anchor failed', {
          offset,
          error: error?.message,
        });
        metrics.chunkMetadataAnchorCounter.inc({ result: 'error' });
      }
      return null;
    }
  }

  /**
   * Locate tx bounds and data_root by walking the chain: block-height
   * binary search + (tx_path shortcut OR tx binary search). This is the
   * original implementation, preserved as a fallback when the reference
   * gateway can't supply chunk header metadata or disagrees with chain
   * state.
   */
  private async resolveTxBoundsViaChainSearch({
    targetHost,
    offset,
    maxSearchHeight,
    chunkResponse,
  }: {
    targetHost: string;
    offset: number;
    maxSearchHeight: number;
    chunkResponse: { tx_path?: string };
  }): Promise<{
    effectiveDataRoot?: Uint8Array;
    txStartOffset?: number;
    txEndOffset?: number;
  }> {
    try {
      // Step 1: Find the containing block (with offset mapping optimization)
      log.debug('Finding containing block for offset', { targetHost, offset });

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

        log.debug('TX path parsing failed, falling back to binary search', {
          targetHost,
          offset,
        });
      }

      // Step 3: Fall back to transaction binary search
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
  }

  /**
   * Entry point used by validateChunkAtOffset: try the reference-header
   * fast path and fall through to chain search if it doesn't pan out.
   */
  private async resolveTxBoundsForOffset(params: {
    targetHost: string;
    offset: number;
    maxSearchHeight: number;
    chunkResponse: { tx_path?: string };
  }): Promise<{
    effectiveDataRoot?: Uint8Array;
    txStartOffset?: number;
    txEndOffset?: number;
  }> {
    const headerResult = await this.resolveTxBoundsViaReferenceHeaders(
      params.offset,
      params.targetHost,
    );
    if (headerResult !== null) {
      return headerResult;
    }
    metrics.chunkMetadataAnchorCounter.inc({ result: 'fallback' });
    return this.resolveTxBoundsViaChainSearch(params);
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
    // Errors after the chunk arrives come from the observer's own chain
    // lookups, not from the gateway.
    let chunkFetched = false;

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
      chunkFetched = true;

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
          failureCategory: 'invalid_chunk',
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
                await this.referenceGateway.checkChunkAvailability({
                  offset,
                  excludeFqdns: [targetHost],
                });

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

          // Resolve tx boundaries + data_root: try reference-gateway headers
          // anchored against the chain first, then fall back to chain search.
          this.resolveTxBoundsForOffset({
            targetHost,
            offset,
            maxSearchHeight,
            chunkResponse,
          }),
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
              failureCategory: 'bad_proof',
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
            failureCategory: 'bad_proof',
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
          // The proof is checked by quick validation, so a missing component
          // here is a data_root or tx bounds the observer could not resolve.
          failureCategory:
            proof === null || proof.length === 0
              ? 'invalid_chunk'
              : 'unverifiable',
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
        failureCategory: chunkFetched
          ? 'unverifiable'
          : classifyChunkFetchError(error),
        referenceGatewayAvailable: undefined, // Can't check reference gateway if target fetch failed
      };
    }
  }

  async assessGatewayOffsets({
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
}
