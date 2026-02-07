import { type Address } from "viem";

import { logger } from "../utils/logger.js";
import {
  getHookContract,
  getWalletClient,
  getPublicClient,
} from "./contractClient.js";
import { PositionExiterHookABI } from "../abi/PositionExiterHook.js";
import { ADDRESSES } from "../abi/addresses.js";
import { OrderService } from "./orderService.js";

const FILL_THRESHOLD = 95; // Consider >=95% as "fully filled"

/**
 * Keeper service that polls active orders and auto-settles them.
 *
 * Checks each active order for:
 * 1. Expiry — deadline passed → calls closeExpiredOrder()
 * 2. Full fill — fillPercent >= threshold → calls closeExpiredOrder()
 *    (closeExpiredOrder works for any closeable order, not just expired ones)
 *
 * Uses the on-chain canClose() view to confirm before sending tx.
 */
export class KeeperService {
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private isRunning = false;
  private pollIntervalMs: number;
  private orderService: OrderService;
  private settledCount = 0;
  private pollCount = 0;

  constructor(orderService: OrderService, pollIntervalMs = 30_000) {
    this.orderService = orderService;
    this.pollIntervalMs = pollIntervalMs;
  }

  /**
   * Start the keeper loop
   */
  start(): void {
    if (this.intervalId) {
      logger.warn("Keeper already running");
      return;
    }

    logger.info("Keeper service started", {
      pollIntervalMs: this.pollIntervalMs,
      fillThreshold: FILL_THRESHOLD,
    });

    // Run immediately on start, then on interval
    this.poll();
    this.intervalId = setInterval(() => this.poll(), this.pollIntervalMs);
  }

  /**
   * Stop the keeper loop
   */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      logger.info("Keeper service stopped", {
        totalPolls: this.pollCount,
        totalSettled: this.settledCount,
      });
    }
  }

  /**
   * Get keeper stats for health endpoint
   */
  getStats() {
    return {
      running: !!this.intervalId,
      pollIntervalMs: this.pollIntervalMs,
      pollCount: this.pollCount,
      settledCount: this.settledCount,
    };
  }

  /**
   * Single poll iteration — check all active orders
   */
  private async poll(): Promise<void> {
    if (this.isRunning) {
      logger.debug("Keeper poll skipped — previous poll still running");
      return;
    }

    this.isRunning = true;
    this.pollCount++;

    try {
      const activeOrders = this.orderService.getActiveOnChainOrders();

      if (activeOrders.length === 0) {
        return;
      }

      logger.debug("Keeper polling active orders", { count: activeOrders.length });

      for (const order of activeOrders) {
        await this.checkAndSettle(order.orderId, order.onChainOrderId);
      }
    } catch (error: any) {
      logger.error("Keeper poll error", { error: error.message });
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Check a single order and settle if ready
   */
  private async checkAndSettle(
    localOrderId: string,
    onChainOrderId: `0x${string}`
  ): Promise<void> {
    try {
      const hook = getHookContract();

      // Check if the order can be closed on-chain
      const [closeable, reason] = await hook.read.canClose([onChainOrderId]);

      if (!closeable) {
        // Also check fill status for monitoring
        const [fillPercent] = await hook.read.getOrderFillStatus([onChainOrderId]);

        if (Number(fillPercent) >= FILL_THRESHOLD) {
          logger.info("Order highly filled but not yet closeable", {
            localOrderId,
            fillPercent: Number(fillPercent),
            reason,
          });
        }
        return;
      }

      logger.info("Settling order", { localOrderId, onChainOrderId, reason });

      // Send the close transaction
      const wallet = getWalletClient();
      const publicClient = getPublicClient();

      const txHash = await wallet.writeContract({
        address: ADDRESSES.hook as Address,
        abi: PositionExiterHookABI,
        functionName: "closeExpiredOrder",
        args: [onChainOrderId],
        account: wallet.account!,
        chain: wallet.chain,
      });

      logger.info("Keeper settlement tx sent", { localOrderId, txHash });

      const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });

      if (receipt.status === "success") {
        // Update the in-memory order
        this.orderService.markOrderSettled(localOrderId, reason, txHash);
        this.settledCount++;

        logger.info("Order settled successfully", {
          localOrderId,
          onChainOrderId,
          reason,
          txHash,
          blockNumber: Number(receipt.blockNumber),
        });
      } else {
        logger.error("Settlement tx reverted", { localOrderId, txHash });
      }
    } catch (error: any) {
      logger.error("Failed to settle order", {
        localOrderId,
        error: error.shortMessage || error.message,
      });
    }
  }
}
