import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";

import {
  CreateOrderRequest,
  CreateOrderResponse,
  OrderStatusResponse,
  TickRange,
  SupportedNetwork,
  SERVICE_FEE_DISPLAY,
} from "../types/index.js";
import { logger } from "../utils/logger.js";

// In-memory order storage (replace with database in production)
interface StoredOrder {
  orderId: string;
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
 * Service for managing exit orders
 *
 * Handles order creation, status tracking, and lifecycle management.
 */
export class OrderService {
  private orders: Map<string, StoredOrder> = new Map();
  private orderCounter = 0;

  /**
   * Create a new exit order
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
    const orderId = this.generateOrderId();
    const deadline = new Date(Date.now() + params.timeframeDays * 24 * 60 * 60 * 1000);

    logger.info("Creating order", { orderId, ...params });

    // Store order
    const order: StoredOrder = {
      orderId,
      owner: params.owner,
      tokenSell: params.tokenSell,
      tokenBuy: params.tokenBuy,
      amount: params.amount,
      tickLower: params.tickRange.tickLower,
      tickUpper: params.tickRange.tickUpper,
      liquidity: "0", // Will be set after on-chain creation
      status: "pending",
      fillPercent: 0,
      createdAt: new Date(),
      deadline,
      network: params.network,
    };

    this.orders.set(orderId, order);

    // TODO: Create on-chain position
    // This would:
    // 1. Call the PositionExiterHook.createOrder() function
    // 2. Wait for transaction confirmation
    // 3. Update order with txHash and liquidity amount

    // For now, simulate successful creation
    order.status = "active";
    order.txHash = `0x${"0".repeat(64)}`;
    order.liquidity = params.amount;

    const gasEstimate = await this.estimateGasCost(params.network);

    return {
      orderId,
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
      expiresAt: deadline.toISOString(),
      txHash: order.txHash,
    };
  }

  /**
   * Get order status
   */
  async getOrderStatus(orderId: string): Promise<OrderStatusResponse | null> {
    const order = this.orders.get(orderId);

    if (!order) {
      return null;
    }

    // TODO: Fetch current fill status from on-chain
    // This would call getOrderFillStatus() on the hook contract

    return {
      orderId: order.orderId,
      status: order.status,
      fillPercent: order.fillPercent,
      currentToken0: "0", // TODO: From on-chain
      currentToken1: "0", // TODO: From on-chain
      createdAt: order.createdAt.toISOString(),
      deadline: order.deadline.toISOString(),
      closedAt: order.closedAt?.toISOString(),
      closeReason: order.closeReason,
      txHash: order.txHash,
    };
  }

  /**
   * Cancel an order
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

    // TODO: Call cancelOrder() on-chain
    // This would:
    // 1. Verify signature matches order owner
    // 2. Call PositionExiterHook.cancelOrder()
    // 3. Wait for confirmation

    // For now, simulate successful cancellation
    order.status = "cancelled";
    order.closedAt = new Date();
    order.closeReason = "User cancelled";

    logger.info("Order cancelled", { orderId });

    return {
      success: true,
      message: "Order cancelled successfully",
      txHash: `0x${"0".repeat(64)}`,
    };
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
  async estimateGasCost(network: SupportedNetwork): Promise<bigint> {
    // TODO: Implement actual gas estimation
    // This would:
    // 1. Estimate gas for createOrder()
    // 2. Estimate gas for closePosition()
    // 3. Get current gas price
    // 4. Add buffer for price fluctuation

    // Placeholder: ~500k gas at 30 gwei = 0.015 ETH
    // For Sepolia/Base, gas is much cheaper

    if (network === "sepolia") {
      return BigInt("15000000000000000"); // 0.015 ETH
    }

    // Base has lower gas costs
    return BigInt("1000000000000000"); // 0.001 ETH
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
   * Process expired orders (called by background job)
   */
  async processExpiredOrders(): Promise<void> {
    const now = new Date();

    for (const order of this.orders.values()) {
      if (order.status !== "active") continue;
      if (order.deadline > now) continue;

      logger.info("Processing expired order", { orderId: order.orderId });

      // TODO: Call closeExpiredOrder() on-chain

      order.status = "expired";
      order.closedAt = now;
      order.closeReason = "Deadline reached";
    }
  }
}
