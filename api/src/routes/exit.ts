import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";

import {
  CreateOrderRequest,
  EstimateRequest,
  SERVICE_FEE_DISPLAY,
} from "../types/index.js";
import { TickCalculatorService } from "../services/tickCalculator.js";
import { OrderService } from "../services/orderService.js";
import { x402Middleware } from "../middleware/x402.js";
import { logger } from "../utils/logger.js";

export const exitRoutes = Router();

const tickCalculator = new TickCalculatorService();
export const orderService = new OrderService();

// ═══════════════════════════════════════════════════════════════════════════
// POST /exit - Create exit order (x402 payment-gated)
// ═══════════════════════════════════════════════════════════════════════════

exitRoutes.post(
  "/exit",
  x402Middleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      // Validate request body
      const validatedBody = CreateOrderRequest.parse(req.body);

      logger.info(`Creating exit order for ${validatedBody.tokenSell} -> ${validatedBody.tokenBuy}`);

      // Calculate optimal tick range
      const tickRange = await tickCalculator.calculateOptimalRange({
        tokenSell: validatedBody.tokenSell as `0x${string}`,
        tokenBuy: validatedBody.tokenBuy as `0x${string}`,
        amount: BigInt(validatedBody.amount),
        timeframeDays: validatedBody.timeframeDays,
        network: validatedBody.network,
      });

      // Create the order
      const order = await orderService.createOrder({
        ...validatedBody,
        tickRange,
        owner: req.body.payerAddress, // From x402 middleware
      });

      res.status(201).json(order);
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({
          error: "Validation Error",
          details: error.errors,
        });
        return;
      }
      next(error);
    }
  }
);

// ═══════════════════════════════════════════════════════════════════════════
// GET /status/:orderId - Get order status
// ═══════════════════════════════════════════════════════════════════════════

exitRoutes.get(
  "/status/:orderId",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { orderId } = req.params;

      const status = await orderService.getOrderStatus(orderId);

      if (!status) {
        res.status(404).json({
          error: "Not Found",
          message: "Order not found",
        });
        return;
      }

      res.json(status);
    } catch (error) {
      next(error);
    }
  }
);

// ═══════════════════════════════════════════════════════════════════════════
// POST /cancel/:orderId - Cancel an active order
// ═══════════════════════════════════════════════════════════════════════════

exitRoutes.post(
  "/cancel/:orderId",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { orderId } = req.params;
      const { signature } = req.body;

      // TODO: Verify signature matches order owner

      const result = await orderService.cancelOrder(orderId, signature);

      if (!result.success) {
        res.status(400).json({
          error: "Cancel Failed",
          message: result.message,
        });
        return;
      }

      res.json(result);
    } catch (error) {
      next(error);
    }
  }
);

// ═══════════════════════════════════════════════════════════════════════════
// POST /estimate - Get cost estimate without creating order
// ═══════════════════════════════════════════════════════════════════════════

exitRoutes.post(
  "/estimate",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      // Validate request body
      const validatedBody = EstimateRequest.parse(req.body);

      logger.info(`Estimating exit for ${validatedBody.tokenSell} -> ${validatedBody.tokenBuy}`);

      // Get pool info
      const poolState = await tickCalculator.getPoolState(
        validatedBody.tokenSell as `0x${string}`,
        validatedBody.tokenBuy as `0x${string}`,
        validatedBody.network
      );

      // Calculate optimal tick range
      const tickRange = await tickCalculator.calculateOptimalRange({
        tokenSell: validatedBody.tokenSell as `0x${string}`,
        tokenBuy: validatedBody.tokenBuy as `0x${string}`,
        amount: BigInt(validatedBody.amount),
        timeframeDays: validatedBody.timeframeDays,
        network: validatedBody.network,
      });

      // Estimate gas costs
      const gasEstimate = await orderService.estimateGasCost(validatedBody.network);

      res.json({
        tickRange: {
          tickLower: tickRange.tickLower,
          tickUpper: tickRange.tickUpper,
        },
        estimatedFillProbability: tickRange.estimatedFillProbability,
        estimatedAveragePrice: tickRange.estimatedAveragePrice.toString(),
        costs: {
          serviceFee: SERVICE_FEE_DISPLAY,
          estimatedGas: gasEstimate.toString(),
          total: (BigInt(SERVICE_FEE_DISPLAY.replace(".", "")) + gasEstimate).toString(),
        },
        poolInfo: {
          poolAddress: poolState.poolId,
          currentTick: poolState.currentTick,
          currentPrice: poolState.sqrtPriceX96.toString(),
          liquidity: poolState.liquidity.toString(),
          fee: poolState.fee,
        },
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({
          error: "Validation Error",
          details: error.errors,
        });
        return;
      }
      next(error);
    }
  }
);

// ═══════════════════════════════════════════════════════════════════════════
// GET /orders/:owner - Get all orders for an owner
// ═══════════════════════════════════════════════════════════════════════════

exitRoutes.get(
  "/orders/:owner",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { owner } = req.params;
      const { status } = req.query;

      const orders = await orderService.getOrdersByOwner(
        owner,
        status as string | undefined
      );

      res.json({ orders });
    } catch (error) {
      next(error);
    }
  }
);
