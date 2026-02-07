import { z } from "zod";

// ═══════════════════════════════════════════════════════════════════════════
// NETWORK TYPES
// ═══════════════════════════════════════════════════════════════════════════

export const SupportedNetwork = z.enum(["sepolia", "base", "anvil"]);
export type SupportedNetwork = z.infer<typeof SupportedNetwork>;

export const NetworkConfig = z.object({
  chainId: z.number(),
  name: z.string(),
  rpcUrl: z.string(),
  poolManagerAddress: z.string(),
  hookAddress: z.string().optional(),
  blockExplorer: z.string(),
});
export type NetworkConfig = z.infer<typeof NetworkConfig>;

// ═══════════════════════════════════════════════════════════════════════════
// ORDER TYPES
// ═══════════════════════════════════════════════════════════════════════════

export const OrderDirection = z.enum([
  "SellToken0ForToken1",
  "SellToken1ForToken0",
]);
export type OrderDirection = z.infer<typeof OrderDirection>;

export const OrderStatus = z.enum([
  "pending",    // Payment received, awaiting on-chain creation
  "active",     // Position created, waiting for fill
  "filled",     // Position fully converted
  "expired",    // Deadline reached
  "cancelled",  // User cancelled
  "failed",     // Creation failed
]);
export type OrderStatus = z.infer<typeof OrderStatus>;

// ═══════════════════════════════════════════════════════════════════════════
// API REQUEST/RESPONSE TYPES
// ═══════════════════════════════════════════════════════════════════════════

export const CreateOrderRequest = z.object({
  tokenSell: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  tokenBuy: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  amount: z.string(), // BigInt as string
  timeframeDays: z.number().min(1).max(30),
  recipient: z.string().regex(/^0x[a-fA-F0-9]{40}$/).optional(),
  network: SupportedNetwork,
});
export type CreateOrderRequest = z.infer<typeof CreateOrderRequest>;

export const CreateOrderResponse = z.object({
  orderId: z.string(),
  status: OrderStatus,
  position: z.object({
    tickLower: z.number(),
    tickUpper: z.number(),
    liquidity: z.string(),
    estimatedFillPrice: z.string(),
    estimatedFillProbability: z.number(),
  }),
  costs: z.object({
    serviceFee: z.string(),
    estimatedGas: z.string(),
    total: z.string(),
  }),
  expiresAt: z.string().datetime(),
  txHash: z.string().optional(),
});
export type CreateOrderResponse = z.infer<typeof CreateOrderResponse>;

export const OrderStatusResponse = z.object({
  orderId: z.string(),
  status: OrderStatus,
  fillPercent: z.number(),
  currentToken0: z.string(),
  currentToken1: z.string(),
  createdAt: z.string().datetime(),
  deadline: z.string().datetime(),
  closedAt: z.string().datetime().optional(),
  closeReason: z.string().optional(),
  txHash: z.string().optional(),
});
export type OrderStatusResponse = z.infer<typeof OrderStatusResponse>;

export const EstimateRequest = z.object({
  tokenSell: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  tokenBuy: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  amount: z.string(),
  timeframeDays: z.number().min(1).max(30),
  network: SupportedNetwork,
});
export type EstimateRequest = z.infer<typeof EstimateRequest>;

export const EstimateResponse = z.object({
  tickRange: z.object({
    tickLower: z.number(),
    tickUpper: z.number(),
  }),
  estimatedFillProbability: z.number(),
  estimatedAveragePrice: z.string(),
  costs: z.object({
    serviceFee: z.string(),
    estimatedGas: z.string(),
    total: z.string(),
  }),
  poolInfo: z.object({
    poolAddress: z.string(),
    currentTick: z.number(),
    currentPrice: z.string(),
    liquidity: z.string(),
    fee: z.number(),
  }),
});
export type EstimateResponse = z.infer<typeof EstimateResponse>;

// ═══════════════════════════════════════════════════════════════════════════
// TICK CALCULATION TYPES
// ═══════════════════════════════════════════════════════════════════════════

export interface TickRange {
  tickLower: number;
  tickUpper: number;
  estimatedFillProbability: number;
  estimatedAveragePrice: bigint;
}

export interface PoolState {
  poolId: `0x${string}`;
  token0: `0x${string}`;
  token1: `0x${string}`;
  fee: number;
  tickSpacing: number;
  currentTick: number;
  sqrtPriceX96: bigint;
  liquidity: bigint;
}

export interface VolatilityData {
  dailyVolatility: number;
  annualizedVolatility: number;
  dataPoints: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// SERVICE FEE
// ═══════════════════════════════════════════════════════════════════════════

export const SERVICE_FEE_USD = 1_000_000n; // $1 in 6 decimal USDC
export const SERVICE_FEE_DISPLAY = "1.00"; // For display
