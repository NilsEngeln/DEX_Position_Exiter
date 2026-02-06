import { type Address, decodeEventLog } from "viem";

import {
  CreateOrderResponse,
  OrderStatusResponse,
  TickRange,
  SupportedNetwork,
  SERVICE_FEE_DISPLAY,
} from "../types/index.js";
import { logger } from "../utils/logger.js";
import {
  getHookContract,
  getDeployedPoolKey,
  getPublicClient,
  getWalletClient,
  getDeployerAddress,
  ensureTokenApprovals,
} from "./contractClient.js";
import { PositionExiterHookABI } from "../abi/PositionExiterHook.js";
import { ANVIL_ADDRESSES } from "../abi/addresses.js";

// In-memory order storage (maps API orderId to on-chain bytes32 orderId)
interface StoredOrder {
  orderId: string; // API-facing orderId
  onChainOrderId: `0x${string}`; // bytes32 from contract
  owner: string;
  tokenSell: string;
  tokenBuy: string;
  amount: string;
  tickLower: number;
  tickUpper: number;
  liquidity: string;
  status: "pending" | "active" | "filled" | "expired" | "cancelled" | "failed";
  fillPercent: number;
  createdAt: Date;
  deadline: Date;
  closedAt?: Date;
  closeReason?: string;
  txHash?: string;
  network: SupportedNetwork;
}

/**
 * Service for managing exit orders via on-chain contract calls
 */
export class OrderService {
  private orders: Map<string, StoredOrder> = new Map();
  private orderCounter = 0;
  private approvalsEnsured = false;

  /**
   * Create a new exit order on-chain
   */
  async createOrder(params: {
    tokenSell: string;
    tokenBuy: string;
    amount: string;
    timeframeDays: number;
    recipient?: string;
    network: SupportedNetwork;
    tickRange: TickRange;
    owner: string;
  }): Promise<CreateOrderResponse> {
    const localOrderId = this.generateOrderId();
    const deadlineTimestamp = Math.floor(Date.now() / 1000) + params.timeframeDays * 24 * 60 * 60;
    const deadlineDate = new Date(deadlineTimestamp * 1000);

    logger.info("Creating order on-chain", { localOrderId, ...params });

    // Store initial order state
    const order: StoredOrder = {
      orderId: localOrderId,
      onChainOrderId: "0x" + "0".repeat(64) as `0x${string}`,
      owner: params.owner,
      tokenSell: params.tokenSell,
      tokenBuy: params.tokenBuy,
      amount: params.amount,
      tickLower: params.tickRange.tickLower,
      tickUpper: params.tickRange.tickUpper,
      liquidity: "0",
      status: "pending",
      fillPercent: 0,
      createdAt: new Date(),
      deadline: deadlineDate,
      network: params.network,
    };

    this.orders.set(localOrderId, order);

    try {
      // Ensure token approvals before first order
      if (!this.approvalsEnsured) {
        await ensureTokenApprovals();
        this.approvalsEnsured = true;
      }

      const wallet = getWalletClient();
      const publicClient = getPublicClient();
      const deployer = getDeployerAddress();
      const recipient = (params.recipient || params.owner || deployer) as Address;

      // Determine order direction based on token addresses
      const isSellToken0 = params.tokenSell.toLowerCase() < params.tokenBuy.toLowerCase();
      const direction = isSellToken0 ? 0 : 1; // 0 = SellToken0ForToken1, 1 = SellToken1ForToken0

      const poolKey = getDeployedPoolKey();

      // Build CreateOrderParams struct
      const createOrderParams = {
        poolKey,
        tickLower: params.tickRange.tickLower,
        tickUpper: params.tickRange.tickUpper,
        amountIn: BigInt(params.amount),
        direction,
        deadline: BigInt(deadlineTimestamp),
        recipient,
      };

      logger.info("Sending createOrder tx", {
        tickLower: createOrderParams.tickLower,
        tickUpper: createOrderParams.tickUpper,
        amountIn: createOrderParams.amountIn.toString(),
        direction,
        deadline: deadlineTimestamp,
      });

      // Send the transaction
      const txHash = await wallet.writeContract({
        address: ANVIL_ADDRESSES.hook as Address,
        abi: PositionExiterHookABI,
        functionName: "createOrder",
        args: [createOrderParams],
        account: wallet.account!,
        chain: wallet.chain,
      });

      logger.info("createOrder tx sent", { txHash });

      // Wait for receipt
      const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
      logger.info("createOrder tx confirmed", { status: receipt.status, blockNumber: receipt.blockNumber });

      // Extract OrderCreated event to get the on-chain orderId
      let onChainOrderId: `0x${string}` = "0x" + "0".repeat(64) as `0x${string}`;
      let liquidity = "0";

      for (const log of receipt.logs) {
        try {
          const decoded = decodeEventLog({
            abi: PositionExiterHookABI,
            data: log.data,
            topics: log.topics,
          });

          if (decoded.eventName === "OrderCreated") {
            const args = decoded.args as { orderId: `0x${string}`; liquidity: bigint };
            onChainOrderId = args.orderId;
            liquidity = args.liquidity.toString();
            logger.info("OrderCreated event", { onChainOrderId, liquidity });
          }
        } catch {
          // Not our event, skip
        }
      }

      // Update stored order
      order.onChainOrderId = onChainOrderId;
      order.status = "active";
      order.txHash = txHash;
      order.liquidity = liquidity;

      const gasEstimate = await this.estimateGasCost(params.network);

      return {
        orderId: localOrderId,
        status: "active",
        position: {
          tickLower: params.tickRange.tickLower,
          tickUpper: params.tickRange.tickUpper,
          liquidity: order.liquidity,
          estimatedFillPrice: params.tickRange.estimatedAveragePrice.toString(),
          estimatedFillProbability: params.tickRange.estimatedFillProbability,
        },
        costs: {
          serviceFee: SERVICE_FEE_DISPLAY,
          estimatedGas: gasEstimate.toString(),
          total: (BigInt(SERVICE_FEE_DISPLAY.replace(".", "")) + gasEstimate).toString(),
        },
        expiresAt: deadlineDate.toISOString(),
        txHash,
      };
    } catch (error: any) {
      logger.error("Failed to create order on-chain", { error: error.message || error });
      order.status = "failed";
      throw new Error(`On-chain order creation failed: ${error.shortMessage || error.message}`);
    }
  }

  /**
   * Get order status - reads from on-chain if possible
   */
  async getOrderStatus(orderId: string): Promise<OrderStatusResponse | null> {
    const order = this.orders.get(orderId);

    if (!order) {
      return null;
    }

    // Try to get fill status from chain
    if (order.onChainOrderId !== "0x" + "0".repeat(64) && order.status === "active") {
      try {
        const hook = getHookContract();
        const [fillPercent, currentToken0, currentToken1] = await hook.read.getOrderFillStatus([
          order.onChainOrderId,
        ]);

        order.fillPercent = Number(fillPercent);

        return {
          orderId: order.orderId,
          status: order.status,
          fillPercent: Number(fillPercent),
          currentToken0: currentToken0.toString(),
          currentToken1: currentToken1.toString(),
          createdAt: order.createdAt.toISOString(),
          deadline: order.deadline.toISOString(),
          closedAt: order.closedAt?.toISOString(),
          closeReason: order.closeReason,
          txHash: order.txHash,
        };
      } catch (error) {
        logger.warn("Failed to read fill status from chain", { orderId, error });
      }
    }

    // Fallback to stored data
    return {
      orderId: order.orderId,
      status: order.status,
      fillPercent: order.fillPercent,
      currentToken0: "0",
      currentToken1: "0",
      createdAt: order.createdAt.toISOString(),
      deadline: order.deadline.toISOString(),
      closedAt: order.closedAt?.toISOString(),
      closeReason: order.closeReason,
      txHash: order.txHash,
    };
  }

  /**
   * Cancel an order on-chain
   */
  async cancelOrder(
    orderId: string,
    _signature: string
  ): Promise<{ success: boolean; message: string; txHash?: string }> {
    const order = this.orders.get(orderId);

    if (!order) {
      return { success: false, message: "Order not found" };
    }

    if (order.status !== "active") {
      return { success: false, message: `Order is ${order.status}, cannot cancel` };
    }

    try {
      const wallet = getWalletClient();
      const publicClient = getPublicClient();

      const txHash = await wallet.writeContract({
        address: ANVIL_ADDRESSES.hook as Address,
        abi: PositionExiterHookABI,
        functionName: "cancelOrder",
        args: [order.onChainOrderId],
        account: wallet.account!,
        chain: wallet.chain,
      });

      logger.info("cancelOrder tx sent", { txHash, orderId });

      const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
      logger.info("cancelOrder tx confirmed", { status: receipt.status });

      order.status = "cancelled";
      order.closedAt = new Date();
      order.closeReason = "User cancelled";

      return {
        success: true,
        message: "Order cancelled on-chain successfully",
        txHash,
      };
    } catch (error: any) {
      logger.error("Failed to cancel order on-chain", { error: error.message || error });
      return {
        success: false,
        message: `Cancel failed: ${error.shortMessage || error.message}`,
      };
    }
  }

  /**
   * Get all orders for an owner
   */
  async getOrdersByOwner(
    owner: string,
    statusFilter?: string
  ): Promise<OrderStatusResponse[]> {
    const ownerOrders: OrderStatusResponse[] = [];

    for (const order of this.orders.values()) {
      if (order.owner.toLowerCase() !== owner.toLowerCase()) continue;
      if (statusFilter && order.status !== statusFilter) continue;

      ownerOrders.push({
        orderId: order.orderId,
        status: order.status,
        fillPercent: order.fillPercent,
        currentToken0: "0",
        currentToken1: "0",
        createdAt: order.createdAt.toISOString(),
        deadline: order.deadline.toISOString(),
        closedAt: order.closedAt?.toISOString(),
        closeReason: order.closeReason,
        txHash: order.txHash,
      });
    }

    return ownerOrders;
  }

  /**
   * Estimate gas cost for order creation and closing
   */
  async estimateGasCost(_network: SupportedNetwork): Promise<bigint> {
    // On Anvil, gas is free but we return a realistic estimate
    return BigInt("15000000000000000"); // 0.015 ETH
  }

  /**
   * Generate unique order ID
   */
  private generateOrderId(): string {
    this.orderCounter++;
    const timestamp = Date.now().toString(16);
    const counter = this.orderCounter.toString(16).padStart(8, "0");
    const random = Math.random().toString(16).slice(2, 10);
    return `0x${timestamp}${counter}${random}`;
  }

  /**
   * Process expired orders
   */
  async processExpiredOrders(): Promise<void> {
    const now = new Date();
    const wallet = getWalletClient();
    const publicClient = getPublicClient();

    for (const order of this.orders.values()) {
      if (order.status !== "active") continue;
      if (order.deadline > now) continue;
      if (order.onChainOrderId === "0x" + "0".repeat(64)) continue;

      logger.info("Processing expired order", { orderId: order.orderId });

      try {
        const txHash = await wallet.writeContract({
          address: ANVIL_ADDRESSES.hook as Address,
          abi: PositionExiterHookABI,
          functionName: "closeExpiredOrder",
          args: [order.onChainOrderId],
          account: wallet.account!,
          chain: wallet.chain,
        });

        await publicClient.waitForTransactionReceipt({ hash: txHash });

        order.status = "expired";
        order.closedAt = now;
        order.closeReason = "Deadline reached";
        logger.info("Expired order closed on-chain", { orderId: order.orderId, txHash });
      } catch (error: any) {
        logger.error("Failed to close expired order", { orderId: order.orderId, error: error.message });
      }
    }
  }
}
