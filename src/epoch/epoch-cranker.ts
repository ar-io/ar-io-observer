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
import type { Address, Rpc, SolanaRpcApi, TransactionSigner } from '@solana/kit';
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
    const { contract, log, batchSize, closeEpochs } = this.config;
    const ario = contract as any; // SDK methods may not be on the interface type

    // 1. Read epoch settings
    let settings;
    try {
      settings = await this.config.getEpochSettings();
    } catch (err) {
      // Route through error classifier — most failures here are transient
      // RPC issues (fetch failed, blockhash not found) that should NOT count
      // as real errors.
      this.handleError(err, 'read_epoch_settings');
      return;
    }

    if (!settings.enabled) {
      log.debug('Epochs are disabled');
      return;
    }

    const currentIndex = settings.currentEpochIndex;
    const targetEpochIndex = currentIndex > 0 ? currentIndex - 1 : 0;
    const now = Math.floor(Date.now() / 1000);
    const nextEpochStart = settings.genesisTimestamp + currentIndex * settings.epochDuration;

    // 2. Bootstrap: no epochs exist yet, create epoch 0 if genesis time passed
    if (currentIndex === 0) {
      if (now >= nextEpochStart) {
        log.verbose('Creating epoch', { epochIndex: 0 });
        try {
          const result = await ario.createEpoch();
          log.info('Epoch created', { epochIndex: 0, tx: result.id });
        } catch (err) {
          this.handleError(err, 'create_epoch');
        }
      }
      return;
    }

    // 3. Read current epoch state
    // IMPORTANT: Always complete the previous epoch's lifecycle
    // (tally → prescribe → wait → distribute → close) BEFORE creating a new
    // epoch. Otherwise rewards for the previous epoch never get distributed.
    const epoch = await ario.getEpochRaw(targetEpochIndex);
    if (!epoch) {
      log.debug('No epoch account found', { epochIndex: targetEpochIndex });
      return;
    }

    // 4. Tally weights
    // Edge case: when activeGatewayCount === 0, we still must call
    // tallyWeights once with empty remaining_accounts so the contract sets
    // weights_tallied=1, otherwise we loop forever.
    if (epoch.weightsTallied === 0) {
      log.verbose('Tallying weights', {
        epochIndex: targetEpochIndex,
        progress: `${epoch.tallyIndex}/${epoch.activeGatewayCount}`,
      });
      try {
        const gatewayPDAs = epoch.activeGatewayCount > 0
          ? await ario.getRegistryGatewayPDAs(epoch.tallyIndex, batchSize)
          : [];
        await ario.tallyWeights({ epochIndex: targetEpochIndex, gatewayAccounts: gatewayPDAs });
      } catch (err) {
        this.handleError(err, 'tally_weights');
      }
      return;
    }

    // 5. Prescribe epoch
    if (epoch.prescriptionsDone === 0) {
      log.verbose('Prescribing epoch', { epochIndex: targetEpochIndex });
      try {
        const allGatewayPDAs = await ario.getAllRegistryGatewayPDAs();
        await ario.prescribeEpoch({
          epochIndex: targetEpochIndex,
          gatewayAccounts: allGatewayPDAs,
          nameRegistryAccount: this.config.nameRegistryAccount,
        });
        log.info('Epoch prescribed', { epochIndex: targetEpochIndex });
      } catch (err) {
        this.handleError(err, 'prescribe_epoch');
      }
      return;
    }

    // 6. Wait for epoch end
    if (now < epoch.endTimestamp) {
      return; // Observers submit observations during this time
    }

    // 7. Distribute rewards
    // Edge case: when activeGatewayCount === 0, call distributeEpoch with an
    // empty array so the contract sets rewards_distributed=1.
    if (epoch.rewardsDistributed === 0) {
      log.verbose('Distributing epoch', {
        epochIndex: targetEpochIndex,
        progress: `${epoch.distributionIndex}/${epoch.activeGatewayCount}`,
      });
      try {
        const gatewayPDAs = epoch.activeGatewayCount > 0
          ? await ario.getRegistryGatewayPDAs(epoch.distributionIndex, batchSize)
          : [];
        await ario.distributeEpoch({ epochIndex: targetEpochIndex, gatewayAccounts: gatewayPDAs });
      } catch (err) {
        this.handleError(err, 'distribute_epoch');
      }
      return;
    }

    // 8. Close old epochs (GAR-006 retention)
    const retention = this.config.epochRetention ?? 7;
    if (closeEpochs && targetEpochIndex >= retention) {
      const closeTarget = targetEpochIndex - retention;
      try {
        const oldEpoch = await ario.getEpochRaw(closeTarget);
        if (oldEpoch && oldEpoch.rewardsDistributed === 1) {
          await ario.closeEpoch({ epochIndex: closeTarget });
          log.info('Old epoch closed', { epochIndex: closeTarget });
        }
      } catch (err) {
        // close_epoch has stricter preconditions than other steps — errors here
        // are expected during normal operation and counted via handleError.
        this.handleError(err, 'close_epoch');
      }
    }

    // 9. Current epoch fully processed. Create the next epoch if due.
    // MUST come after distribute above, otherwise rewards for the current
    // epoch would be skipped (the cranker would create the next epoch first
    // and lose track of the previous one).
    if (now >= nextEpochStart) {
      log.verbose('Creating epoch', { epochIndex: currentIndex });
      try {
        const result = await ario.createEpoch();
        log.info('Epoch created', { epochIndex: currentIndex, tx: result.id });
      } catch (err) {
        this.handleError(err, 'create_epoch');
      }
    }

    // 10. Permissionless prune / cleanup (best-effort, throttled).
    // Runs only after the pipeline reaches its quiescent tail; never blocks
    // an epoch step. Errors here are isolated — handleError logs but the
    // outer tick() exits cleanly.
    if (this.config.enableCleanup !== false) {
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
            const batch = expired.splice(0, batchSize).map((r: any) => r.pubkey);
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

    // Phase 2: ArNS expired returned names — gated on `next_returned_names_prune_timestamp`.
    if (budget.remaining > 0) {
      try {
        const cfg = await ario.getArnsConfigRaw();
        if (cfg && Number(cfg.nextReturnedNamesPruneTimestamp) <= now) {
          const expired = await ario.getExpiredReturnedNames(now);
          while (expired.length > 0 && budget.remaining > 0) {
            const batch = expired.splice(0, batchSize).map((r: any) => r.pubkey);
            try {
              await ario.pruneReturnedNames({
                maxNames: batch.length,
                returnedNames: batch,
              });
              budget.remaining--;
              log.info('Pruned expired ReturnedNames', { count: batch.length });
            } catch (err) {
              this.handleError(err, 'prune_returned_names');
              break;
            }
          }
        }
      } catch (err) {
        this.handleError(err, 'cleanup_returned_names_scan');
      }
    }

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
        const gone = await ario.getGoneGateways();
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
    const retention = this.config.epochRetention ?? 7;
    if (budget.remaining > 0 && currentEpochIndex >= retention + 1) {
      try {
        const observerAddrs = await ario.getRegistryGatewayAddresses?.();
        // Walk the prior `retention` window (older epochs are candidates,
        // newer ones may still be referenced). One epoch per cycle keeps the
        // search bounded.
        const closeTarget = currentEpochIndex - retention - 1;
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
