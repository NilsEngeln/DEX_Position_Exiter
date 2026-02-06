import {
  PoolState,
  TickRange,
  SupportedNetwork,
  VolatilityData,
} from "../types/index.js";
import { logger } from "../utils/logger.js";
import {
  getHookContract,
  getDeployedPoolId,
} from "./contractClient.js";
import { POOL_CONFIG } from "../abi/addresses.js";

/**
 * Service for calculating optimal tick ranges for exit positions
 *
 * Uses historical volatility and current pool state to determine
 * the best tick range for a given timeframe and fill probability target.
 */
export class TickCalculatorService {
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
    const { tokenSell, tokenBuy, timeframeDays } = params;

    logger.info("Calculating optimal tick range", {
      tokenSell,
      tokenBuy,
      timeframeDays,
    });

    // Get current pool state from on-chain
    const poolState = await this.getPoolState(tokenSell, tokenBuy, params.network);

    // Calculate historical volatility (30-day lookback)
    const volatility = await this.calculateVolatility(poolState.poolId, 30);

    // Calculate expected price movement
    // Using simplified geometric Brownian motion: σ * √t * z
    // Where z = 1.5 for ~87% probability of reaching the upper bound
    const zScore = 1.5;
    const sqrtTime = Math.sqrt(timeframeDays / 365);
    const expectedMovePercent = volatility.dailyVolatility * sqrtTime * zScore;

    // Convert percentage move to ticks
    const ticksToMove = Math.ceil(expectedMovePercent * 10000);

    // Determine direction and calculate ticks
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

    const fillProbability = this.calculateFillProbability(
      volatility.dailyVolatility,
      tickUpper - tickLower,
      timeframeDays
    );

    const averagePrice = this.calculateAveragePrice(tickLower, tickUpper);

    logger.info("Calculated tick range", {
      tickLower,
      tickUpper,
      fillProbability,
      currentTick: poolState.currentTick,
    });

    return {
      tickLower,
      tickUpper,
      estimatedFillProbability: fillProbability,
      estimatedAveragePrice: averagePrice,
    };
  }

  /**
   * Get current pool state from on-chain via the hook's lastTicks
   */
  async getPoolState(
    token0: `0x${string}`,
    token1: `0x${string}`,
    _network: SupportedNetwork
  ): Promise<PoolState> {
    logger.info("Fetching pool state from chain", { token0, token1 });

    // Sort tokens by address (token0 < token1 convention)
    const [sortedToken0, sortedToken1] =
      token0.toLowerCase() < token1.toLowerCase()
        ? [token0, token1]
        : [token1, token0];

    try {
      const hook = getHookContract();
      const poolId = getDeployedPoolId();

      // Read the last recorded tick from the hook (updated on every swap via afterSwap)
      const currentTick = await hook.read.lastTicks([poolId]);

      // Compute sqrtPriceX96 from tick
      const sqrtPriceX96 = this.tickToSqrtPriceX96(Number(currentTick));

      return {
        poolId,
        token0: sortedToken0,
        token1: sortedToken1,
        fee: POOL_CONFIG.fee,
        tickSpacing: POOL_CONFIG.tickSpacing,
        currentTick: Number(currentTick),
        sqrtPriceX96,
        liquidity: BigInt("1000000000000000000000"),
      };
    } catch (error) {
      logger.warn("Failed to read pool state from chain, using defaults", { error });
      return {
        poolId: getDeployedPoolId(),
        token0: sortedToken0,
        token1: sortedToken1,
        fee: POOL_CONFIG.fee,
        tickSpacing: POOL_CONFIG.tickSpacing,
        currentTick: 0,
        sqrtPriceX96: POOL_CONFIG.sqrtPriceX96_1_1,
        liquidity: BigInt("1000000000000000000000"),
      };
    }
  }

  /**
   * Calculate historical volatility for a pool
   */
  async calculateVolatility(
    _poolId: `0x${string}`,
    _days: number
  ): Promise<VolatilityData> {
    // TODO: Implement actual volatility calculation using on-chain swap events
    // For POC, assume 5% daily volatility
    return {
      dailyVolatility: 0.05,
      annualizedVolatility: 0.05 * Math.sqrt(365),
      dataPoints: 30,
    };
  }

  /**
   * Convert tick to sqrtPriceX96
   */
  private tickToSqrtPriceX96(tick: number): bigint {
    const sqrtPrice = Math.pow(1.0001, tick / 2);
    const Q96 = BigInt(2) ** BigInt(96);
    return BigInt(Math.floor(sqrtPrice * Number(Q96)));
  }

  private alignToTickSpacing(tick: number, tickSpacing: number): number {
    return Math.floor(tick / tickSpacing) * tickSpacing;
  }

  private calculateFillProbability(
    dailyVolatility: number,
    tickRange: number,
    timeframeDays: number
  ): number {
    const expectedMove = dailyVolatility * Math.sqrt(timeframeDays) * 10000;
    const rangeRatio = tickRange / expectedMove;
    const probability = 1 - Math.exp(-rangeRatio * 0.8);
    return Math.min(0.99, Math.max(0.1, probability));
  }

  private calculateAveragePrice(tickLower: number, tickUpper: number): bigint {
    const avgTick = (tickLower + tickUpper) / 2;
    const price = Math.pow(1.0001, avgTick);
    return BigInt(Math.floor(price * 1e18));
  }
}
