import { createPublicClient, http } from "viem";
import { sepolia } from "viem/chains";

import {
  PoolState,
  TickRange,
  SupportedNetwork,
  VolatilityData,
} from "../types/index.js";
import { logger } from "../utils/logger.js";

/**
 * Service for calculating optimal tick ranges for exit positions
 *
 * Uses historical volatility and current pool state to determine
 * the best tick range for a given timeframe and fill probability target.
 */
export class TickCalculatorService {
  private clients: Map<SupportedNetwork, ReturnType<typeof createPublicClient>>;

  constructor() {
    this.clients = new Map();

    // Initialize clients for each network
    this.clients.set(
      "sepolia",
      createPublicClient({
        chain: sepolia,
        transport: http(process.env.SEPOLIA_RPC_URL),
      })
    );

    // TODO: Add Base client when deploying to mainnet
  }

  /**
   * Calculate optimal tick range for an exit position
   */
  async calculateOptimalRange(params: {
    tokenSell: `0x${string}`;
    tokenBuy: `0x${string}`;
    amount: bigint;
    timeframeDays: number;
    network: SupportedNetwork;
  }): Promise<TickRange> {
    const { tokenSell, tokenBuy, timeframeDays, network } = params;

    logger.info("Calculating optimal tick range", {
      tokenSell,
      tokenBuy,
      timeframeDays,
      network,
    });

    // Get current pool state
    const poolState = await this.getPoolState(tokenSell, tokenBuy, network);

    // Calculate historical volatility (30-day lookback)
    const volatility = await this.calculateVolatility(poolState.poolId, 30);

    // Calculate expected price movement
    // Using simplified geometric Brownian motion: σ * √t * z
    // Where z = 1.5 for ~87% probability of reaching the upper bound
    const zScore = 1.5;
    const sqrtTime = Math.sqrt(timeframeDays / 365);
    const expectedMovePercent = volatility.dailyVolatility * sqrtTime * zScore;

    // Convert percentage move to ticks
    // tick = log(price) / log(1.0001)
    // For small moves: Δtick ≈ Δprice% / 0.01% = Δprice% * 10000
    const ticksToMove = Math.ceil(expectedMovePercent * 10000);

    // Determine direction and calculate ticks
    // For selling token0 (tokenSell < tokenBuy by address): position above current price
    const isSellToken0 = tokenSell.toLowerCase() < tokenBuy.toLowerCase();

    let tickLower: number;
    let tickUpper: number;

    if (isSellToken0) {
      // Selling token0: place liquidity above current price
      tickLower = this.alignToTickSpacing(
        poolState.currentTick + poolState.tickSpacing,
        poolState.tickSpacing
      );
      tickUpper = this.alignToTickSpacing(
        tickLower + ticksToMove,
        poolState.tickSpacing
      );
    } else {
      // Selling token1: place liquidity below current price
      tickUpper = this.alignToTickSpacing(
        poolState.currentTick - poolState.tickSpacing,
        poolState.tickSpacing
      );
      tickLower = this.alignToTickSpacing(
        tickUpper - ticksToMove,
        poolState.tickSpacing
      );
    }

    // Ensure minimum range width (at least 2 tick spacings)
    const minWidth = poolState.tickSpacing * 2;
    if (tickUpper - tickLower < minWidth) {
      if (isSellToken0) {
        tickUpper = tickLower + minWidth;
      } else {
        tickLower = tickUpper - minWidth;
      }
    }

    // Calculate estimated fill probability
    const fillProbability = this.calculateFillProbability(
      volatility.dailyVolatility,
      tickUpper - tickLower,
      timeframeDays
    );

    // Calculate average execution price
    const averagePrice = this.calculateAveragePrice(tickLower, tickUpper);

    logger.info("Calculated tick range", {
      tickLower,
      tickUpper,
      fillProbability,
      averagePrice: averagePrice.toString(),
    });

    return {
      tickLower,
      tickUpper,
      estimatedFillProbability: fillProbability,
      estimatedAveragePrice: averagePrice,
    };
  }

  /**
   * Get current pool state from on-chain
   */
  async getPoolState(
    token0: `0x${string}`,
    token1: `0x${string}`,
    network: SupportedNetwork
  ): Promise<PoolState> {
    // TODO: Implement actual pool state fetching from Uniswap V4
    // This requires:
    // 1. Finding the pool address from the PoolManager
    // 2. Calling getSlot0 to get current tick and sqrtPriceX96
    // 3. Getting liquidity from the pool

    logger.info("Fetching pool state", { token0, token1, network });

    // Placeholder implementation for development
    // Sort tokens by address (token0 < token1 convention)
    const [sortedToken0, sortedToken1] =
      token0.toLowerCase() < token1.toLowerCase()
        ? [token0, token1]
        : [token1, token0];

    return {
      poolId: `0x${"0".repeat(64)}` as `0x${string}`,
      token0: sortedToken0,
      token1: sortedToken1,
      fee: 3000, // 0.3% fee tier
      tickSpacing: 60,
      currentTick: 0,
      sqrtPriceX96: BigInt("79228162514264337593543950336"), // 1:1 price
      liquidity: BigInt("1000000000000000000000"),
    };
  }

  /**
   * Calculate historical volatility for a pool
   */
  async calculateVolatility(
    _poolId: `0x${string}`,
    _days: number
  ): Promise<VolatilityData> {
    // TODO: Implement actual volatility calculation
    // This would typically:
    // 1. Fetch historical price data from events or a subgraph
    // 2. Calculate daily returns
    // 3. Compute standard deviation

    // Placeholder: assume 5% daily volatility (typical for volatile tokens)
    return {
      dailyVolatility: 0.05,
      annualizedVolatility: 0.05 * Math.sqrt(365),
      dataPoints: 30,
    };
  }

  /**
   * Align a tick to the pool's tick spacing
   */
  private alignToTickSpacing(tick: number, tickSpacing: number): number {
    return Math.floor(tick / tickSpacing) * tickSpacing;
  }

  /**
   * Calculate probability of fill given volatility and range
   */
  private calculateFillProbability(
    dailyVolatility: number,
    tickRange: number,
    timeframeDays: number
  ): number {
    // Simplified calculation using normal distribution approximation
    // Higher volatility = higher fill probability
    // Wider range = higher fill probability
    // Longer timeframe = higher fill probability

    const expectedMove = dailyVolatility * Math.sqrt(timeframeDays) * 10000;
    const rangeRatio = tickRange / expectedMove;

    // Use cumulative normal distribution approximation
    // If range is about 1.5x expected move, probability is ~87%
    const probability = 1 - Math.exp(-rangeRatio * 0.8);

    return Math.min(0.99, Math.max(0.1, probability));
  }

  /**
   * Calculate average execution price for a tick range
   */
  private calculateAveragePrice(tickLower: number, tickUpper: number): bigint {
    // Price at tick = 1.0001^tick
    // Average price is geometric mean = sqrt(priceLower * priceUpper)
    // Which equals 1.0001^((tickLower + tickUpper) / 2)

    const avgTick = (tickLower + tickUpper) / 2;
    const price = Math.pow(1.0001, avgTick);

    // Return as fixed-point with 18 decimals
    return BigInt(Math.floor(price * 1e18));
  }
}
