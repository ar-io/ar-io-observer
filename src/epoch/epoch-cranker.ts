/**
 * AR.IO Observer — Epoch Cranker Module
 *
 * Opt-in epoch lifecycle automation for gateway operators.
 * Reuses the observer's existing Solana RPC client and signer.
 *
 * Enable via: ENABLE_EPOCH_CRANKING=true
 *
 * Zero overhead when disabled — this module is dynamically imported only
 * when the config flag is set.
 *
 * IMPORTANT: This file mirrors the standalone cranker at
 * `cranker/src/state-machine.ts` in the solana-ar-io monorepo. Keep the
 * pipeline ordering, error handling, and edge-case behavior in sync.
 */
import type {
  Address,
  Rpc,
  SolanaRpcApi,
  TransactionSigner,
} from '@solana/kit';
import type { SolanaARIOWriteable } from '@ar.io/sdk';
import { classifyError, type ErrorCategory } from './errors.js';

const LAMPORTS_PER_SOL = 1_000_000_000;

export interface EpochCrankerConfig {
  contract: SolanaARIOWriteable;
  rpc: Rpc<SolanaRpcApi>;
  signer: TransactionSigner;
  pollIntervalMs: number;
  batchSize: number;
  closeEpochs: boolean;
  /** Number of epochs behind current to close. Default 7. */
  epochRetention?: number;
  /** Warn at this SOL balance (default 0.3). Set 0 to disable. */
  warnBalanceSol?: number;
  /** Critical threshold — log error each tick (default 0.1). Set 0 to disable. */
  criticalBalanceSol?: number;
  /**
   * Run permissionless prune / cleanup ix after the epoch pipeline
   * (default: true). Disable to keep the cranker scoped to the 6-step
   * pipeline only — useful when you want a separate cleanup operator
   * to isolate fee payment / failure modes. Env: ENABLE_CLEANUP.
   */
  enableCleanup?: boolean;
  /**
   * Per-tx batch size for `pruneExpiredNames` / `pruneReturnedNames`
   * (u8, max 255). Default: 15. Env: CLEANUP_BATCH_SIZE.
   */
  cleanupBatchSize?: number;
  /**
   * Hard cap on cleanup transactions submitted per cleanup cycle. Prevents
   * runaway gas spend if discovery returns thousands of stale accounts.
   * Default: 50. Env: MAX_CLEANUP_TXS_PER_CYCLE.
   */
  maxCleanupTxsPerCycle?: number;
  /**
   * Threshold for `prune_gateway` (failed_consecutive >= N). Mirrors
   * `EpochSettings.max_consecutive_failures` (default 30).
   */
  cleanupFailureThreshold?: number;
  /**
   * Recent signatures to scan when reclaiming leaked prescribe Address Lookup
   * Tables (Phase 7). The ALT program can't be enumerated via
   * getProgramAccounts, so discovery walks the signer's tx history.
   * Default: 200. Env: ALT_RECLAIM_SCAN_LIMIT. Set 0 to disable.
   */
  altReclaimScanLimit?: number;
  /**
   * Skip cleanup if it last ran within this many ms (default: 300_000ms /
   * 5min). Prevents per-tick scanning of getProgramAccounts when the
   * pipeline is in a quiescent state.
   */
  cleanupMinIntervalMs?: number;
  log: {
    debug(msg: string, meta?: Record<string, unknown>): void;
    info(msg: string, meta?: Record<string, unknown>): void;
    warn(msg: string, meta?: Record<string, unknown>): void;
    error(msg: string, meta?: Record<string, unknown>): void;
    verbose(msg: string, meta?: Record<string, unknown>): void;
  };
  getEpochSettings: () => Promise<{
    currentEpochIndex: number;
    genesisTimestamp: number;
    epochDuration: number;
    enabled: boolean;
  }>;
  /** NameRegistry PDA — pass to enable name prescription during prescribeEpoch */
  nameRegistryAccount?: Address;
}

export class EpochCranker {
  private config: EpochCrankerConfig;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private _busy = false;
  private balanceCheckTickCount = 0;
  /**
   * Last successful runCleanup() start time (ms epoch). Used to throttle
   * cleanup scans so we don't `getProgramAccounts` every poll cycle —
   * which can be every few seconds. Cleanup catches stale state on a
   * minutes-to-hours timescale, polling more often is wasted RPC.
   */
  private lastCleanupRunMs = 0;
  /**
   * Lowest epoch index that has ever existed on-chain (the AO→Solana
   * continuity floor). Epochs below this were NEVER created on Solana:
   * at enablement `admin_set_current_epoch_index` jumped the counter
   * straight to the AO-continuity value (~454) and the SDK cold start
   * created `epoch[currentIndex]` — epochs 0..currentIndex-1 have no
   * account on-chain. Discovered lazily by `runCleanup` (probe the
   * close-observation target with `getEpochRaw`) and cached so we never
   * walk the registry firing `close_observation` at epochs that can't
   * hold any Observation PDA — every such call is a guaranteed
   * AccountOwnedByWrongProgram (3007) miss (the never-created PDA is still
   * SystemProgram-owned), and at registry scale that's
   * hundreds of wasted RPC tx-simulations per cycle (the 3007 noise
   * floor that trips RPC 429s). `null` = not yet discovered.
   */
  private firstExistingEpochIndex: number | null = null;

  constructor(config: EpochCrankerConfig) {
    this.config = config;
  }

  isBusy(): boolean {
    return this._busy;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.config.log.verbose('Epoch cranker started', {
      pollIntervalMs: this.config.pollIntervalMs,
      batchSize: this.config.batchSize,
      epochRetention: this.config.epochRetention ?? 7,
    });
    void this.tick();
    this.timer = setInterval(() => {
      void this.tick();
    }, this.config.pollIntervalMs);
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.config.log.verbose('Epoch cranker stopped');
  }

  private async tick(): Promise<void> {
    if (this._busy) return;
    this._busy = true;

    try {
      // Random jitter to reduce collision with other crankers
      const jitter = Math.floor(Math.random() * 4000) + 1000;
      await sleep(jitter);

      // Check if stopped during jitter sleep
      if (!this.running) return;

      // Check wallet balance every ~30 ticks (don't spam getBalance every cycle)
      this.balanceCheckTickCount++;
      if (this.balanceCheckTickCount % 30 === 1) {
        await this.checkWalletBalance();
      }

      await this.runCycle();
    } catch (err) {
      this.handleError(err, 'tick');
    } finally {
      this._busy = false;
    }
  }

  private async runCycle(): Promise<void> {
    const { contract, log } = this.config;
    // SDK methods may not be on the published interface type yet.
    const ario = contract as any;

    // 1. Read epoch settings (enabled gate + cleanup target). crankEpochStep
    //    reads settings again internally to drive the lifecycle.
    let settings;
    try {
      settings = await this.config.getEpochSettings();
    } catch (err) {
      // Transient RPC issues classify as not_ready, not real errors.
      this.handleError(err, 'read_epoch_settings');
      return;
    }

    if (!settings.enabled) {
      log.debug('Epochs are disabled');
      return;
    }

    const currentIndex = settings.currentEpochIndex;

    // 2. Advance the epoch lifecycle by ONE step. crankEpochStep (in @ar.io/sdk)
    //    owns create → tally → prescribe → distribute → close, including the
    //    size-safe prescribe prediction (≤50 Gateway PDAs, never the whole
    //    registry — the MAX_TX_ACCOUNT_LOCKS fix) and the InvalidGatewayAccount
    //    re-predict-and-retry. We only log + classify any thrown error.
    let action: string | undefined;
    try {
      const result = await ario.crankEpochStep({
        batchSize: this.config.batchSize,
        enableClose: this.config.closeEpochs,
        epochRetention: this.config.epochRetention ?? 7,
        nameRegistryAccount: this.config.nameRegistryAccount,
        // Returned-name pruning is folded into the epoch step (solana.36+):
        // tie it to the same cleanup config the runCleanup phases use.
        enablePrune: this.config.enableCleanup !== false,
        pruneBatchSize: this.config.cleanupBatchSize,
        pruneScanIntervalMs: this.config.cleanupMinIntervalMs,
      });
      action = result.action;
      if (result.action === 'idle') {
        log.debug('Epoch idle', { reason: result.reason });
      } else {
        log.info(`Epoch ${result.action}`, {
          epochIndex: result.epochIndex,
          tx: result.txId,
          progress: result.progress,
        });
      }
    } catch (err) {
      this.handleError(err, 'crank_epoch');
    }

    // 3. Permissionless prune / cleanup (best-effort, throttled). Gated on the
    //    quiescent tail (action === 'idle') so it never competes with a pending
    //    lifecycle step. Errors here are isolated — the outer tick() exits clean.
    if (action === 'idle' && this.config.enableCleanup !== false) {
      const minInterval = this.config.cleanupMinIntervalMs ?? 300_000;
      const elapsed = Date.now() - this.lastCleanupRunMs;
      if (elapsed >= minInterval) {
        this.lastCleanupRunMs = Date.now();
        try {
          await this.runCleanup(currentIndex);
        } catch (err) {
          this.handleError(err, 'cleanup');
        }
      }
    }
  }

  /**
   * Permissionless prune / cleanup pass. See `docs/CRANKER_PRUNING_PLAN.md`.
   *
   * All sub-steps are best-effort. We accumulate a per-cycle tx counter
   * across the 6 phases and bail when it hits `maxCleanupTxsPerCycle` so a
   * pathologically large discovery doesn't burn fees on a single cycle.
   */
  private async runCleanup(currentEpochIndex: number): Promise<void> {
    const { contract, log } = this.config;
    const ario = contract as any;
    const batchSize = this.config.cleanupBatchSize ?? 15;
    const maxTxs = this.config.maxCleanupTxsPerCycle ?? 50;
    const failureThreshold = this.config.cleanupFailureThreshold ?? 30;
    const now = Math.floor(Date.now() / 1000);

    // Mutable budget — every successful submission decrements; sub-steps
    // exit early when it hits 0.
    const budget = { remaining: maxTxs };

    log.verbose('Cleanup cycle starting', {
      maxTxs,
      batchSize,
      failureThreshold,
    });

    // Phase 1: ArNS expired records — gated on `next_records_prune_timestamp`.
    if (budget.remaining > 0) {
      try {
        const cfg = await ario.getArnsConfigRaw();
        if (cfg && Number(cfg.nextRecordsPruneTimestamp) <= now) {
          const expired = await ario.getExpiredArnsRecords(now);
          while (expired.length > 0 && budget.remaining > 0) {
            const batch = expired
              .splice(0, batchSize)
              .map((r: any) => r.pubkey);
            try {
              await ario.pruneExpiredNames({
                maxNames: batch.length,
                arnsRecords: batch,
              });
              budget.remaining--;
              log.info('Pruned expired ArnsRecords', { count: batch.length });
            } catch (err) {
              this.handleError(err, 'prune_expired_names');
              break;
            }
          }
        }
      } catch (err) {
        this.handleError(err, 'cleanup_arns_records_scan');
      }
    }

    // Phase 2: ArNS expired returned names — now owned by `crankEpochStep`
    // (@ar.io/sdk ≥ solana.36). It scans the ReturnedName PDAs directly in the
    // epoch step's idle exits, WITHOUT the stale `next_returned_names_prune_timestamp`
    // gate that stranded imported returned names. Removed from runCleanup so
    // there's a single source of truth — see the crankEpochStep call in runCycle.

    // Phase 3: Deficient gateways → prune_gateway, plus Gone gateways → finalize_gone.
    if (budget.remaining > 0) {
      try {
        const deficient = await ario.getDeficientGateways(failureThreshold);
        for (const g of deficient) {
          if (budget.remaining <= 0) break;
          try {
            await ario.pruneGateway({ gateway: g.operator });
            budget.remaining--;
            log.info('Pruned deficient gateway', {
              operator: g.operator,
              failedConsecutive: g.failedConsecutive,
            });
          } catch (err) {
            this.handleError(err, 'prune_gateway');
          }
        }
      } catch (err) {
        this.handleError(err, 'cleanup_deficient_gateways_scan');
      }
    }
    if (budget.remaining > 0) {
      try {
        // Only gateways whose leave window has elapsed AND have no remaining
        // delegated stake are actually finalize_gone-able. getGoneGateways()
        // over-returns every Leaving gateway, so finalizing per result reverts
        // (LeaveWindowNotExpired / 6079) on every not-yet-eligible one each
        // cycle — pure noise. getFinalizableGoneGateways(now) pre-filters to the
        // on-chain eligibility conditions. Requires @ar.io/sdk with
        // ar-io/ar-io-sdk#685.
        const gone = await ario.getFinalizableGoneGateways(now);
        for (const g of gone) {
          if (budget.remaining <= 0) break;
          try {
            await ario.finalizeGone({ gateway: g.operator });
            budget.remaining--;
            log.info('Finalized gone gateway', { operator: g.operator });
          } catch (err) {
            this.handleError(err, 'finalize_gone');
          }
        }
      } catch (err) {
        this.handleError(err, 'cleanup_gone_gateways_scan');
      }
    }

    // Phase 4: Old observations from epochs older than `currentEpochIndex - retention`.
    // The Observation PDA seed is `(epochIndex, observer)`. We need the
    // observer addresses — easiest source is the active GatewayRegistry.
    // Anyone NOT in the current registry won't be found, but observers are
    // gateways so coverage should be reasonable. closeObservation no-ops on
    // missing PDAs (Anchor returns AccountNotInitialized).
    //
    // CONTINUITY FLOOR: after the AO→Solana cutover, `current_epoch_index`
    // jumped straight to ~454 with NO epochs 0..453 on-chain. closeTarget
    // (`currentEpochIndex - retention - 1`) lands in that never-existed range
    // for a long time, so firing `close_observation` at it for every registry
    // observer is N guaranteed AccountOwnedByWrongProgram (3007) misses per cycle —
    // the noise floor that trips RPC 429s. We floor closeTarget to the lowest
    // epoch that actually exists: skip the whole loop (no RPC) when closeTarget
    // is below a discovered floor, and discover that floor with ONE cheap
    // `getEpochRaw` read (replacing N wasted closeObservation tx-simulations).
    const retention = this.config.epochRetention ?? 7;
    if (budget.remaining > 0 && currentEpochIndex >= retention + 1) {
      try {
        // Walk the prior `retention` window (older epochs are candidates,
        // newer ones may still be referenced). One epoch per cycle keeps the
        // search bounded.
        const closeTarget = currentEpochIndex - retention - 1;

        // Floor check 1 (no RPC): a previously-discovered floor already tells
        // us closeTarget never existed on-chain. Skip without touching the RPC.
        if (
          this.firstExistingEpochIndex !== null &&
          closeTarget < this.firstExistingEpochIndex
        ) {
          log.debug('Skipping close_observation below continuity floor', {
            closeTarget,
            firstExistingEpochIndex: this.firstExistingEpochIndex,
          });
        } else {
          // Floor check 2 (one cheap account read): does the close-target
          // epoch account even exist? `getEpochRaw` returns null for epochs
          // that were never created (the continuity gap). No epoch account ⇒
          // no Observation PDAs keyed on it ⇒ nothing to close. Record the
          // floor so subsequent cycles short-circuit at check 1 above.
          const targetEpoch = await ario.getEpochRaw?.(closeTarget);
          if (targetEpoch === null || targetEpoch === undefined) {
            // closeTarget never existed. The real floor is somewhere above it;
            // remember closeTarget+1 as a conservative lower bound so we stop
            // re-probing this index every cycle while currentEpochIndex creeps
            // up. (Once enough epochs accrue that closeTarget >= the genuine
            // first epoch, this read will succeed and we proceed below.)
            this.firstExistingEpochIndex = Math.max(
              this.firstExistingEpochIndex ?? 0,
              closeTarget + 1,
            );
            log.debug(
              'close_observation target epoch never existed; skipping',
              {
                closeTarget,
                firstExistingEpochIndex: this.firstExistingEpochIndex,
              },
            );
          } else {
            // closeTarget exists → it's at or above the continuity floor.
            // Pin the floor here so we never probe below it again.
            if (
              this.firstExistingEpochIndex === null ||
              closeTarget < this.firstExistingEpochIndex
            ) {
              this.firstExistingEpochIndex = closeTarget;
            }
            const observerAddrs = await ario.getRegistryGatewayAddresses?.();
            if (Array.isArray(observerAddrs)) {
              for (const observer of observerAddrs) {
                if (budget.remaining <= 0) break;
                try {
                  await ario.closeObservation({
                    epochIndex: closeTarget,
                    observer,
                  });
                  budget.remaining--;
                } catch (err) {
                  // Most calls miss (no obs PDA for that observer/epoch). Don't spam.
                  const cat = this.handleError(err, 'close_observation');
                  if (cat === 'real') break;
                }
              }
            }
          }
        }
      } catch (err) {
        this.handleError(err, 'cleanup_observations_scan');
      }
    }

    // Phase 5: Dust accounts — empty Delegations + drained Withdrawals.
    if (budget.remaining > 0) {
      try {
        const empty = await ario.getEmptyDelegations();
        for (const d of empty) {
          if (budget.remaining <= 0) break;
          try {
            await ario.closeEmptyDelegation({
              gateway: d.gateway,
              delegator: d.delegator,
            });
            budget.remaining--;
          } catch (err) {
            this.handleError(err, 'close_empty_delegation');
          }
        }
      } catch (err) {
        this.handleError(err, 'cleanup_empty_delegations_scan');
      }
    }
    if (budget.remaining > 0) {
      try {
        const drained = await ario.getDrainedWithdrawals();
        for (const w of drained) {
          if (budget.remaining <= 0) break;
          try {
            await ario.closeDrainedWithdrawal({
              owner: w.owner,
              withdrawalId: w.withdrawalId,
            });
            budget.remaining--;
          } catch (err) {
            this.handleError(err, 'close_drained_withdrawal');
          }
        }
      } catch (err) {
        this.handleError(err, 'cleanup_drained_withdrawals_scan');
      }
    }

    // Phase 6: Expired primary-name requests.
    // (Skipping `releaseVault` — it requires owner: Signer, so the cranker
    // can only release its own vaults. Users have a strong incentive to
    // call release_vault themselves — it returns their tokens.)
    if (budget.remaining > 0) {
      try {
        const expired = await ario.getExpiredPrimaryNameRequests(now);
        for (const r of expired) {
          if (budget.remaining <= 0) break;
          try {
            await ario.closeExpiredRequest({ initiator: r.initiator });
            budget.remaining--;
          } catch (err) {
            this.handleError(err, 'close_expired_request');
          }
        }
      } catch (err) {
        this.handleError(err, 'cleanup_expired_requests_scan');
      }
    }

    // Phase 7: Reclaim leaked prescribe Address Lookup Tables. Each
    // prescribe_epoch via the ephemeral-ALT path leaves a single-use table
    // allocated (~0.0126 SOL rent); reclaiming needs deactivate → ~513-slot
    // cooldown → close, so it lives here rather than inline. Discovery walks the
    // signer's tx history (the ALT program can't be enumerated via
    // getProgramAccounts) and only touches tables whose entries are all
    // GAR/ArNS-owned (the prescribe fingerprint). Each deactivate/close is one
    // submission, charged to the same budget.
    const altScanLimit = this.config.altReclaimScanLimit ?? 200;
    if (budget.remaining > 0 && altScanLimit > 0) {
      try {
        // Optional-chained: older @ar.io/sdk builds lack this method (added
        // alongside the ephemeral-ALT prescribe path). Absent → no-op, no error.
        const r = await ario.reclaimLookupTableRent?.({
          maxTables: budget.remaining,
          scanLimit: altScanLimit,
        });
        const submitted = (r?.deactivated ?? 0) + (r?.closed ?? 0);
        budget.remaining -= submitted;
        if (submitted > 0) {
          log.info('Reclaimed prescribe ALTs', {
            deactivated: r.deactivated,
            closed: r.closed,
            candidates: r.candidates,
          });
        }
      } catch (err) {
        this.handleError(err, 'cleanup_reclaim_lookup_tables');
      }
    }

    log.verbose('Cleanup cycle complete', {
      txsSubmitted: maxTxs - budget.remaining,
      remainingBudget: budget.remaining,
    });
  }

  private async checkWalletBalance(): Promise<void> {
    const warnThreshold = this.config.warnBalanceSol ?? 0.3;
    const criticalThreshold = this.config.criticalBalanceSol ?? 0.1;
    if (warnThreshold <= 0 && criticalThreshold <= 0) return;

    try {
      const { value: balance } = await this.config.rpc
        .getBalance(this.config.signer.address)
        .send();
      const sol = Number(balance) / LAMPORTS_PER_SOL;

      if (criticalThreshold > 0 && sol < criticalThreshold) {
        this.config.log.error('Cranker wallet balance CRITICAL', {
          balanceSol: sol.toFixed(4),
          critical: criticalThreshold,
          address: this.config.signer.address,
        });
      } else if (warnThreshold > 0 && sol < warnThreshold) {
        this.config.log.warn('Cranker wallet balance low — top up soon', {
          balanceSol: sol.toFixed(4),
          warn: warnThreshold,
          address: this.config.signer.address,
        });
      }
    } catch {
      // Non-critical — don't fail the cycle
    }
  }

  private handleError(error: unknown, context: string): ErrorCategory {
    const category = classifyError(error);
    const msg = error instanceof Error ? error.message : String(error);

    switch (category) {
      case 'already_done':
        this.config.log.debug(`[crank:${context}] Already done: ${msg}`);
        break;
      case 'not_ready':
        this.config.log.debug(`[crank:${context}] Not ready: ${msg}`);
        break;
      case 'real':
        this.config.log.error(`[crank:${context}] Error: ${msg}`);
        break;
    }

    return category;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
