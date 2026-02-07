# Technical Specification - DEX Position Exiter

## Smart Contract Interfaces

### 1. PositionExiterHook.sol

The core Uniswap V4 hook that manages exit positions.

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {BaseHook} from "@uniswap/v4-periphery/contracts/BaseHook.sol";
import {IPoolManager} from "@uniswap/v4-core/contracts/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/contracts/types/PoolKey.sol";
import {BalanceDelta} from "@uniswap/v4-core/contracts/types/BalanceDelta.sol";
import {Currency} from "@uniswap/v4-core/contracts/types/Currency.sol";

interface IPositionExiterHook {
    // ═══════════════════════════════════════════════════════════════════
    // ENUMS & STRUCTS
    // ═══════════════════════════════════════════════════════════════════

    enum OrderStatus {
        Active,      // Position is live, waiting for price to move through range
        Filled,      // Position fully converted to target token
        Expired,     // Deadline reached, position closed with current mix
        Cancelled,   // User cancelled before fill
        Liquidated   // Emergency close by admin
    }

    enum OrderDirection {
        SellToken0ForToken1,  // Placing liquidity above current price
        SellToken1ForToken0   // Placing liquidity below current price
    }

    struct ExitOrder {
        // Owner info
        address owner;
        address recipient;  // Where to send tokens on close (can differ from owner)

        // Pool identification
        PoolKey poolKey;

        // Position parameters
        int24 tickLower;
        int24 tickUpper;
        uint128 liquidity;
        OrderDirection direction;

        // Tracking
        uint256 createdAt;
        uint256 deadline;
        uint256 gasEscrowed;
        OrderStatus status;

        // Original amounts for accounting
        uint256 token0Deposited;
        uint256 token1Deposited;
    }

    struct CreateOrderParams {
        PoolKey poolKey;
        int24 tickLower;
        int24 tickUpper;
        uint256 amountIn;
        OrderDirection direction;
        uint256 deadline;
        address recipient;
    }

    struct CloseResult {
        uint256 token0Out;
        uint256 token1Out;
        uint256 feesEarned0;
        uint256 feesEarned1;
        uint256 gasRefund;
        OrderStatus finalStatus;
    }

    // ═══════════════════════════════════════════════════════════════════
    // EVENTS
    // ═══════════════════════════════════════════════════════════════════

    event OrderCreated(
        bytes32 indexed orderId,
        address indexed owner,
        PoolKey poolKey,
        int24 tickLower,
        int24 tickUpper,
        uint128 liquidity,
        OrderDirection direction,
        uint256 deadline
    );

    event OrderFilled(
        bytes32 indexed orderId,
        address indexed owner,
        uint256 amountOut,
        uint256 feesEarned
    );

    event OrderExpired(
        bytes32 indexed orderId,
        address indexed owner,
        uint256 token0Out,
        uint256 token1Out
    );

    event OrderCancelled(
        bytes32 indexed orderId,
        address indexed owner,
        uint256 token0Returned,
        uint256 token1Returned
    );

    event GasRefunded(
        bytes32 indexed orderId,
        address indexed recipient,
        uint256 amount
    );

    // ═══════════════════════════════════════════════════════════════════
    // EXTERNAL FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Create a new exit order
    /// @dev Caller must have approved tokens to TokenAllowanceGuard
    /// @param params Order creation parameters
    /// @return orderId Unique identifier for the order
    function createOrder(CreateOrderParams calldata params)
        external
        payable  // For gas escrow
        returns (bytes32 orderId);

    /// @notice Cancel an active order
    /// @dev Only callable by order owner
    /// @param orderId The order to cancel
    /// @return result The tokens and gas returned
    function cancelOrder(bytes32 orderId)
        external
        returns (CloseResult memory result);

    /// @notice Close an order that has reached its deadline
    /// @dev Can be called by anyone (keeper incentive via gas payment)
    /// @param orderId The order to close
    /// @return result The final state and amounts
    function closeExpiredOrder(bytes32 orderId)
        external
        returns (CloseResult memory result);

    /// @notice Emergency close by admin
    /// @param orderId The order to close
    function emergencyClose(bytes32 orderId) external;

    // ═══════════════════════════════════════════════════════════════════
    // VIEW FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Get order details
    function getOrder(bytes32 orderId) external view returns (ExitOrder memory);

    /// @notice Get current fill status of an order
    /// @return fillPercent 0-100 representing how much has converted
    /// @return currentToken0 Current token0 amount in position
    /// @return currentToken1 Current token1 amount in position
    function getOrderFillStatus(bytes32 orderId)
        external
        view
        returns (
            uint8 fillPercent,
            uint256 currentToken0,
            uint256 currentToken1
        );

    /// @notice Get all active orders for an owner
    function getActiveOrders(address owner)
        external
        view
        returns (bytes32[] memory orderIds);

    /// @notice Check if an order can be closed (filled or expired)
    function canClose(bytes32 orderId)
        external
        view
        returns (bool closeable, string memory reason);
}
```

### 2. TokenAllowanceGuard.sol

Scoped approval system for enhanced security.

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

interface ITokenAllowanceGuard {
    // ═══════════════════════════════════════════════════════════════════
    // STRUCTS
    // ═══════════════════════════════════════════════════════════════════

    struct Allowance {
        address token;
        uint256 amount;
        uint256 amountUsed;
        bytes32 orderId;       // Ties allowance to specific order
        uint256 expiresAt;
        bool revoked;
    }

    // ═══════════════════════════════════════════════════════════════════
    // EVENTS
    // ═══════════════════════════════════════════════════════════════════

    event AllowanceCreated(
        bytes32 indexed allowanceId,
        address indexed owner,
        address indexed token,
        uint256 amount,
        bytes32 orderId,
        uint256 expiresAt
    );

    event AllowanceUsed(
        bytes32 indexed allowanceId,
        uint256 amount,
        uint256 remaining
    );

    event AllowanceRevoked(
        bytes32 indexed allowanceId
    );

    event AllowanceExpired(
        bytes32 indexed allowanceId
    );

    // ═══════════════════════════════════════════════════════════════════
    // EXTERNAL FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Create a scoped approval for a specific order
    /// @dev User must first approve this contract for the token
    /// @param token The token to allow
    /// @param amount Maximum amount that can be transferred
    /// @param orderId The order this allowance is for
    /// @param duration How long the allowance is valid (seconds)
    /// @return allowanceId Unique identifier for this allowance
    function createAllowance(
        address token,
        uint256 amount,
        bytes32 orderId,
        uint256 duration
    ) external returns (bytes32 allowanceId);

    /// @notice Transfer tokens using a scoped allowance
    /// @dev Only callable by authorized contracts (PositionExiterHook)
    /// @param allowanceId The allowance to use
    /// @param from Token owner
    /// @param to Recipient
    /// @param amount Amount to transfer
    function transferWithAllowance(
        bytes32 allowanceId,
        address from,
        address to,
        uint256 amount
    ) external;

    /// @notice Revoke an allowance
    /// @dev Only callable by allowance owner or on order close
    /// @param allowanceId The allowance to revoke
    function revokeAllowance(bytes32 allowanceId) external;

    /// @notice Get allowance details
    function getAllowance(bytes32 allowanceId)
        external
        view
        returns (Allowance memory);

    /// @notice Check remaining allowance
    function remainingAllowance(bytes32 allowanceId)
        external
        view
        returns (uint256);
}
```

### 3. GasEscrow.sol

Manages prepaid gas for position closing.

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

interface IGasEscrow {
    // ═══════════════════════════════════════════════════════════════════
    // STRUCTS
    // ═══════════════════════════════════════════════════════════════════

    struct Escrow {
        address owner;
        bytes32 orderId;
        uint256 amount;
        uint256 deposited;
        uint256 used;
        uint256 refunded;
        bool closed;
    }

    // ═══════════════════════════════════════════════════════════════════
    // EVENTS
    // ═══════════════════════════════════════════════════════════════════

    event EscrowCreated(
        bytes32 indexed escrowId,
        address indexed owner,
        bytes32 indexed orderId,
        uint256 amount
    );

    event GasUsed(
        bytes32 indexed escrowId,
        address indexed executor,
        uint256 amount
    );

    event GasRefunded(
        bytes32 indexed escrowId,
        address indexed recipient,
        uint256 amount
    );

    event EscrowClosed(
        bytes32 indexed escrowId,
        uint256 totalUsed,
        uint256 totalRefunded
    );

    // ═══════════════════════════════════════════════════════════════════
    // EXTERNAL FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Create a new gas escrow for an order
    /// @dev Called by PositionExiterHook during order creation
    function createEscrow(
        bytes32 orderId,
        address owner
    ) external payable returns (bytes32 escrowId);

    /// @notice Pay gas to an executor for closing a position
    /// @dev Only callable by PositionExiterHook
    function payExecutor(
        bytes32 escrowId,
        address executor,
        uint256 amount
    ) external;

    /// @notice Refund remaining gas to order owner
    /// @dev Only callable by PositionExiterHook
    function refundRemaining(bytes32 escrowId) external;

    /// @notice Get escrow details
    function getEscrow(bytes32 escrowId)
        external
        view
        returns (Escrow memory);

    /// @notice Calculate expected gas cost for closing
    function estimateCloseCost(bytes32 orderId)
        external
        view
        returns (uint256);
}
```

## API Server Design

### Middleware Stack

```typescript
// x402 payment middleware configuration
interface PaymentConfig {
  routes: {
    [path: string]: {
      method: "GET" | "POST" | "PUT" | "DELETE";
      accepts: NetworkScheme[];
      priceCalculator: (req: Request) => Promise<PaymentAmount>;
      description: string;
    };
  };
  facilitator: FacilitatorConfig;
  refundPolicy: RefundPolicy;
}

// Example configuration
const paymentConfig: PaymentConfig = {
  routes: {
    "POST /exit": {
      method: "POST",
      accepts: [
        { network: "base", scheme: "exact" },
        { network: "arbitrum", scheme: "exact" },
      ],
      priceCalculator: async (req) => {
        const { tokenSell, tokenBuy, amount, timeframeDays, network } = req.body;

        // Calculate costs
        const gasEstimate = await estimateGasCosts(network, "createAndClose");
        const serviceFee = calculateServiceFee(amount);
        const buffer = gasEstimate * 0.2; // 20% buffer

        return {
          amount: gasEstimate + serviceFee + buffer,
          currency: "USDC",
          network: network,
        };
      },
      description: "Create token exit order",
    },
  },
  // ...
};
```

### Core Services

```typescript
// ═══════════════════════════════════════════════════════════════════════
// TICK CALCULATOR SERVICE
// ═══════════════════════════════════════════════════════════════════════

interface TickCalculatorService {
  /**
   * Calculate optimal tick range for exit order
   */
  calculateOptimalRange(params: {
    tokenSell: Address;
    tokenBuy: Address;
    amount: bigint;
    timeframeDays: number;
    network: SupportedNetwork;
  }): Promise<{
    tickLower: number;
    tickUpper: number;
    estimatedFillProbability: number;
    estimatedAveragePrice: number;
    volatilityUsed: number;
    liquidityDepth: LiquiditySnapshot;
  }>;

  /**
   * Get current pool state
   */
  getPoolState(
    token0: Address,
    token1: Address,
    network: SupportedNetwork
  ): Promise<PoolState>;

  /**
   * Calculate historical volatility
   */
  calculateVolatility(
    poolId: PoolId,
    days: number
  ): Promise<{
    dailyVolatility: number;
    annualizedVolatility: number;
    dataPoints: number;
  }>;
}

// ═══════════════════════════════════════════════════════════════════════
// ORDER MANAGER SERVICE
// ═══════════════════════════════════════════════════════════════════════

interface OrderManagerService {
  /**
   * Create a new exit order after payment confirmed
   */
  createOrder(params: {
    owner: Address;
    tokenSell: Address;
    tokenBuy: Address;
    amount: bigint;
    tickLower: number;
    tickUpper: number;
    deadline: Date;
    gasEscrowed: bigint;
    network: SupportedNetwork;
    paymentTxHash: TxHash;
  }): Promise<{
    orderId: Bytes32;
    txHash: TxHash;
    position: PositionInfo;
  }>;

  /**
   * Get order status
   */
  getOrderStatus(orderId: Bytes32): Promise<OrderStatus>;

  /**
   * Cancel an order
   */
  cancelOrder(orderId: Bytes32, signature: Signature): Promise<CancelResult>;

  /**
   * Process expired orders (called by keeper)
   */
  processExpiredOrders(): Promise<ProcessingResult[]>;
}

// ═══════════════════════════════════════════════════════════════════════
// ANALYTICS SERVICE
// ═══════════════════════════════════════════════════════════════════════

interface AnalyticsService {
  /**
   * Get historical fill rates by tick range width
   */
  getFillRateAnalytics(
    poolId: PoolId,
    timeframeDays: number
  ): Promise<FillRateData>;

  /**
   * Estimate probability of fill
   */
  estimateFillProbability(params: {
    poolId: PoolId;
    tickLower: number;
    tickUpper: number;
    timeframeDays: number;
  }): Promise<number>;

  /**
   * Get optimal tick range recommendations
   */
  getRecommendations(params: {
    poolId: PoolId;
    targetFillProbability: number;
    timeframeDays: number;
  }): Promise<TickRangeRecommendation[]>;
}
```

### Database Schema

```sql
-- Orders table
CREATE TABLE orders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id BYTES32 UNIQUE NOT NULL,  -- On-chain order ID
    owner_address VARCHAR(42) NOT NULL,
    recipient_address VARCHAR(42) NOT NULL,

    -- Token info
    token_sell VARCHAR(42) NOT NULL,
    token_buy VARCHAR(42) NOT NULL,
    amount_in NUMERIC(78) NOT NULL,

    -- Position info
    pool_id BYTES32 NOT NULL,
    tick_lower INTEGER NOT NULL,
    tick_upper INTEGER NOT NULL,
    liquidity NUMERIC(78) NOT NULL,
    direction VARCHAR(20) NOT NULL,

    -- Timing
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    deadline TIMESTAMP WITH TIME ZONE NOT NULL,
    closed_at TIMESTAMP WITH TIME ZONE,

    -- Status
    status VARCHAR(20) NOT NULL DEFAULT 'active',
    fill_percent INTEGER DEFAULT 0,

    -- Financial
    gas_escrowed NUMERIC(78) NOT NULL,
    gas_used NUMERIC(78) DEFAULT 0,
    gas_refunded NUMERIC(78) DEFAULT 0,
    fees_earned_0 NUMERIC(78) DEFAULT 0,
    fees_earned_1 NUMERIC(78) DEFAULT 0,

    -- Payment
    payment_tx_hash VARCHAR(66) NOT NULL,
    payment_amount NUMERIC(78) NOT NULL,
    payment_network VARCHAR(20) NOT NULL,

    -- Close info
    close_tx_hash VARCHAR(66),
    token_0_out NUMERIC(78),
    token_1_out NUMERIC(78),

    -- Network
    network VARCHAR(20) NOT NULL,

    -- Indexes
    INDEX idx_owner (owner_address),
    INDEX idx_status (status),
    INDEX idx_deadline (deadline),
    INDEX idx_network_status (network, status)
);

-- Order events for tracking
CREATE TABLE order_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id BYTES32 NOT NULL REFERENCES orders(order_id),
    event_type VARCHAR(50) NOT NULL,
    event_data JSONB,
    tx_hash VARCHAR(66),
    block_number BIGINT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

    INDEX idx_order_events (order_id, created_at)
);

-- Analytics snapshots
CREATE TABLE pool_snapshots (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    pool_id BYTES32 NOT NULL,
    network VARCHAR(20) NOT NULL,
    current_tick INTEGER NOT NULL,
    sqrt_price_x96 NUMERIC(78) NOT NULL,
    liquidity NUMERIC(78) NOT NULL,
    fee_growth_global_0 NUMERIC(78),
    fee_growth_global_1 NUMERIC(78),
    captured_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

    INDEX idx_pool_time (pool_id, captured_at DESC)
);
```

## Tick Range Calculation Algorithm

```typescript
/**
 * Calculate optimal tick range for a sell order
 *
 * The goal is to find a tick range that:
 * 1. Starts just above current price (for sells)
 * 2. Has high probability of being filled within timeframe
 * 3. Provides reasonable execution price
 * 4. Minimizes impact on existing liquidity
 */
async function calculateOptimalTickRange(params: {
  poolState: PoolState;
  amountToSell: bigint;
  timeframeDays: number;
  confidenceLevel: number; // 0.5 = 50% probability of fill
}): Promise<TickRange> {
  const { poolState, amountToSell, timeframeDays, confidenceLevel } = params;
  const { currentTick, tickSpacing, sqrtPriceX96 } = poolState;

  // Step 1: Calculate historical volatility
  const volatility = await calculateHistoricalVolatility(poolState.poolId, 30);

  // Step 2: Calculate expected price movement
  // Using geometric Brownian motion assumption
  // Expected move = volatility * sqrt(time) * z-score
  const zScore = getZScoreForConfidence(confidenceLevel);
  const sqrtTime = Math.sqrt(timeframeDays / 365);
  const expectedMovePercent = volatility * sqrtTime * zScore;

  // Step 3: Convert price move to ticks
  // tick = log(price) / log(1.0001)
  // For small moves: deltaTick ≈ deltaPrice / (price * 0.0001)
  const currentPrice = sqrtPriceX96ToPrice(sqrtPriceX96);
  const upperPrice = currentPrice * (1 + expectedMovePercent);
  const ticksToMove = priceToTick(upperPrice) - currentTick;

  // Step 4: Align to tick spacing
  const tickLower = alignToTickSpacing(currentTick + tickSpacing, tickSpacing);
  const tickUpper = alignToTickSpacing(tickLower + ticksToMove, tickSpacing);

  // Step 5: Validate range makes sense
  const minTicks = tickSpacing * 2; // At least 2 tick spacings wide
  const maxTicks = tickSpacing * 100; // Cap at 100 tick spacings

  const finalTickUpper = Math.max(
    tickLower + minTicks,
    Math.min(tickUpper, tickLower + maxTicks)
  );

  // Step 6: Calculate liquidity needed for the amount
  const liquidity = calculateLiquidityForAmount(
    tickLower,
    finalTickUpper,
    amountToSell,
    poolState.token0Decimals
  );

  return {
    tickLower,
    tickUpper: finalTickUpper,
    liquidity,
    estimatedFillProbability: confidenceLevel,
    estimatedAveragePrice: calculateAveragePrice(tickLower, finalTickUpper),
  };
}

/**
 * Helper: Calculate liquidity from token amount and tick range
 *
 * For a single-sided position (all token0, no token1):
 * liquidity = amount * sqrt(P_lower) * sqrt(P_upper) / (sqrt(P_upper) - sqrt(P_lower))
 */
function calculateLiquidityForAmount(
  tickLower: number,
  tickUpper: number,
  amount: bigint,
  decimals: number
): bigint {
  const sqrtPriceLower = tickToSqrtPriceX96(tickLower);
  const sqrtPriceUpper = tickToSqrtPriceX96(tickUpper);

  // L = amount * sqrtPriceLower * sqrtPriceUpper / (sqrtPriceUpper - sqrtPriceLower)
  const numerator = amount * sqrtPriceLower * sqrtPriceUpper;
  const denominator = sqrtPriceUpper - sqrtPriceLower;

  return numerator / denominator;
}
```

## Hook Implementation Details

### afterSwap Callback Logic

```solidity
/**
 * @notice Called after every swap in pools using this hook
 * @dev Checks if any orders have been filled and processes them
 */
function afterSwap(
    address sender,
    PoolKey calldata key,
    IPoolManager.SwapParams calldata params,
    BalanceDelta delta,
    bytes calldata hookData
) external override onlyPoolManager returns (bytes4, int128) {
    PoolId poolId = key.toId();

    // Get tick before and after swap
    int24 tickBefore = tickLasts[poolId];
    (, int24 tickAfter, , ) = poolManager.getSlot0(poolId);

    // Update stored tick
    tickLasts[poolId] = tickAfter;

    // Check if tick moved (in either direction)
    if (tickBefore != tickAfter) {
        _processTickCross(poolId, tickBefore, tickAfter, key);
    }

    return (this.afterSwap.selector, 0);
}

/**
 * @dev Process any orders that were crossed by the tick movement
 */
function _processTickCross(
    PoolId poolId,
    int24 tickBefore,
    int24 tickAfter,
    PoolKey memory key
) internal {
    // Determine direction
    bool tickIncreased = tickAfter > tickBefore;

    // Get orders in the crossed range
    bytes32[] memory crossedOrders = _getOrdersInRange(
        poolId,
        tickIncreased ? tickBefore : tickAfter,
        tickIncreased ? tickAfter : tickBefore
    );

    for (uint256 i = 0; i < crossedOrders.length; i++) {
        ExitOrder storage order = orders[crossedOrders[i]];

        // Check if order is fully filled
        // For a sell order (SellToken0ForToken1), it's filled when
        // price moves above tickUpper
        bool isFilled = _checkIfFilled(order, tickAfter);

        if (isFilled) {
            _markOrderFilled(crossedOrders[i]);
            emit OrderFilled(
                crossedOrders[i],
                order.owner,
                _calculateOutputAmount(order),
                _calculateFeesEarned(order)
            );
        }
    }
}

/**
 * @dev Check if an order is fully filled based on current tick
 */
function _checkIfFilled(
    ExitOrder storage order,
    int24 currentTick
) internal view returns (bool) {
    if (order.direction == OrderDirection.SellToken0ForToken1) {
        // Selling token0: filled when price goes above upper tick
        return currentTick >= order.tickUpper;
    } else {
        // Selling token1: filled when price goes below lower tick
        return currentTick <= order.tickLower;
    }
}
```

## Security Considerations

### Reentrancy Protection

```solidity
// Use OpenZeppelin's ReentrancyGuard
import {ReentrancyGuard} from "@openzeppelin/contracts/security/ReentrancyGuard.sol";

contract PositionExiterHook is BaseHook, ReentrancyGuard {
    // All external state-changing functions use nonReentrant
    function createOrder(CreateOrderParams calldata params)
        external
        payable
        nonReentrant
        returns (bytes32 orderId)
    {
        // ...
    }
}
```

### Access Control

```solidity
// Role-based access for admin functions
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

contract PositionExiterHook is BaseHook, AccessControl {
    bytes32 public constant KEEPER_ROLE = keccak256("KEEPER_ROLE");
    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");

    function emergencyClose(bytes32 orderId)
        external
        onlyRole(ADMIN_ROLE)
    {
        // ...
    }

    function processExpiredOrders(bytes32[] calldata orderIds)
        external
        onlyRole(KEEPER_ROLE)
    {
        // ...
    }
}
```

### Input Validation

```solidity
function createOrder(CreateOrderParams calldata params)
    external
    payable
    returns (bytes32 orderId)
{
    // Validate tick alignment
    require(
        params.tickLower % params.poolKey.tickSpacing == 0,
        "tickLower not aligned"
    );
    require(
        params.tickUpper % params.poolKey.tickSpacing == 0,
        "tickUpper not aligned"
    );

    // Validate tick order
    require(params.tickLower < params.tickUpper, "Invalid tick range");

    // Validate deadline
    require(params.deadline > block.timestamp, "Deadline in past");
    require(
        params.deadline <= block.timestamp + MAX_ORDER_DURATION,
        "Deadline too far"
    );

    // Validate gas escrow
    require(msg.value >= MIN_GAS_ESCROW, "Insufficient gas escrow");

    // Validate amount
    require(params.amountIn > 0, "Zero amount");

    // ...
}
```

## Testing Strategy

### Unit Tests (Foundry)

```solidity
// test/PositionExiterHook.t.sol

contract PositionExiterHookTest is Test {
    PositionExiterHook hook;
    PoolManager poolManager;

    function setUp() public {
        // Deploy mock tokens
        // Deploy PoolManager
        // Deploy hook with correct address prefix
        // Initialize test pool
    }

    function test_CreateOrder_Success() public {
        // Test successful order creation
    }

    function test_CreateOrder_RevertsOnInvalidTicks() public {
        // Test validation
    }

    function test_AfterSwap_DetectsFilledOrder() public {
        // Test hook callback
    }

    function test_CancelOrder_ReturnsTokens() public {
        // Test cancellation
    }

    function test_ExpiredOrder_CanBeClosed() public {
        // Test expiry handling
    }
}
```

### Integration Tests

```typescript
// test/integration/full-flow.test.ts

describe("Full Exit Order Flow", () => {
  it("should create order, fill on price movement, and return tokens", async () => {
    // 1. Create order via API with x402 payment
    // 2. Verify on-chain position created
    // 3. Simulate swaps that move price
    // 4. Verify order marked as filled
    // 5. Verify tokens sent to recipient
    // 6. Verify gas refund
  });
});
```

### Fork Tests

```solidity
// Test against mainnet fork to verify real pool behavior
contract ForkTest is Test {
    function setUp() public {
        // Fork Base mainnet
        vm.createSelectFork(vm.envString("BASE_RPC_URL"));
    }

    function test_RealPoolInteraction() public {
        // Test with real pool state
    }
}
```

## Current Implementation Status (POC)

### What's Built and Working

| Component | Status | Details |
|-----------|--------|---------|
| **PositionExiterHook.sol** | Done | Uniswap V4 hook with `afterSwap` + `afterInitialize`. Creates single-sided LP orders, tracks tick movement, manages order lifecycle. 32 passing integration tests. |
| **Sepolia Deployment** | Done | Hook at `0x78015ED15d7584Ca4DD2F2D321c5a941959b5040`, pool initialized with mWETH/mUSDC mock tokens. Official V4 PoolManager at `0xE03A1074c86CFeDd5C142C4F04F1a1536e203543`. |
| **API Server** | Done | Express + TypeScript. Endpoints: `POST /estimate`, `POST /exit` (x402-gated), `GET /status/:id`, `POST /cancel/:id`, `GET /orders/:owner`. |
| **x402 Payment Gate** | Done | `POST /exit` returns 402 with payment requirements. Dev mode skips verification (`SKIP_PAYMENT=true`). |
| **Tick Calculator** | Done | Calculates optimal tick range based on pool state, volatility estimate, and timeframe. Reads live pool state from Sepolia. |
| **Keeper Service** | Done | Background loop (default 30s) polls active orders, calls `canClose()` on-chain, auto-settles filled/expired orders via `closeExpiredOrder()`. |
| **Frontend** | Done | Vanilla TypeScript + Vite. MetaMask integration, Sepolia network switching, order creation/cancellation, Etherscan tx links. |
| **On-chain order creation** | Done | API creates orders via deployer wallet on Sepolia. Events parsed for order ID + liquidity. |
| **Fill status tracking** | Done | `_afterSwap` tracks tick movement. `getOrderFillStatus()` returns fill percent + current token balances. |
| **Order cancellation** | Done | Owner can cancel active orders, tokens returned to recipient. |
| **Expiry handling** | Done | `closeExpiredOrder()` settles orders past deadline, sends tokens to recipient. |

### What's NOT Implemented (POC Limitations)

| Feature | Current State | Production Requirement |
|---------|--------------|----------------------|
| **Auto-withdraw on fill** | Keeper polls and settles externally | Option C: `_afterSwap` detects full fill and auto-removes liquidity + transfers tokens in the same swap tx. Zero latency, no external trigger needed. |
| **On-demand pool creation** | Pool pre-deployed with mock tokens | Hook detects if pool exists for a pair, creates at oracle price if not, then adds user's position. First order bootstraps the pool. |
| **Real x402 payments** | `SKIP_PAYMENT=true` in dev | Integrate with Coinbase x402 facilitator. Verify payment proofs on-chain or via API. |
| **User-signed transactions** | API's deployer wallet sends all txs | Users sign `createOrder` directly from MetaMask. Hook validates `msg.sender` as token owner. |
| **Persistent storage** | In-memory `Map<string, Order>` | PostgreSQL with the schema defined in this spec. Survives API restarts. |
| **Multi-pool support** | Single mWETH/mUSDC pool | Registry of supported pools. API accepts any token pair and routes to correct pool. |
| **Price oracle integration** | Hardcoded 1:1 price for mock pool | Chainlink or Uniswap TWAP oracle for real market prices. Used for tick range calculation and pool initialization. |
| **Gas escrow** | Not implemented | `GasEscrow.sol` — users prepay gas for settlement. Keeper gets paid from escrow. Remaining refunded. |
| **TokenAllowanceGuard** | Direct ERC20 approvals | Scoped, time-limited, order-specific approvals as defined in this spec. |
| **Chainlink Automation** | Centralized keeper loop in API | Decentralized keeper via Chainlink Automation or Gelato for guaranteed settlement. |
| **Multi-chain** | Sepolia only | Deploy to Base, Arbitrum, Ethereum mainnet. |
| **Rate limiting / abuse prevention** | None | Per-wallet order limits, minimum amounts, cooldowns. |
| **Contract upgradability** | Immutable | Proxy pattern or versioned deployments with migration. |
| **Audit** | Not audited | Professional security audit before mainnet. |

### Auto-Settlement Architecture (Production Target)

The current POC uses an off-chain **Keeper Service** that polls every 30 seconds and calls `closeExpiredOrder()` when an order is closeable. This works for the POC but adds latency and a centralized dependency.

**Production target (Option C — hook-native auto-withdraw):**

```
User creates order → tokens deposited as single-sided LP
                                ↓
         Traders swap through the pool (normal Uniswap activity)
                                ↓
              _afterSwap detects tick crossed order's full range
                                ↓
         In the SAME transaction: remove liquidity + transfer to recipient
                                ↓
                    User receives tokens automatically
```

Key implementation details for Option C:
1. In `_afterSwap`, after updating `lastTicks`, iterate active orders for the pool
2. For each order where `currentTick >= tickUpper` (sell token0) or `currentTick <= tickLower` (sell token1), the order is fully filled
3. Call `poolManager.unlock()` to remove the liquidity position
4. Transfer the output tokens directly to `order.recipient`
5. Emit `OrderFilled` event
6. Gas cost is borne by the swapper — need to ensure this is reasonable (batch limit)

The keeper would remain as a fallback only for expired orders that were never fully filled.

### Production Roadmap

#### Phase 1: Testnet Hardening
- Implement user-signed transactions (remove deployer wallet dependency)
- Add PostgreSQL persistence
- Integrate real x402 payment verification
- Add multi-pool support with real Sepolia tokens (WETH, USDC)
- Chainlink price oracle integration

#### Phase 2: Auto-Settlement (Option C)
- Modify `_afterSwap` to detect when an order's tick range is fully crossed
- In the same callback, remove the liquidity and transfer tokens to recipient
- This eliminates the keeper for filled orders entirely
- Keep keeper only for expired orders (deadline reached but not fully filled)
- Gas optimization: batch-process multiple filled orders in one callback

#### Phase 3: Mainnet (Base)
- Deploy hook + pool for real WETH/USDC on Base
- Gas escrow system for settlement costs
- Chainlink Automation as decentralized keeper backup
- Professional audit
- Whitelist-only launch with $1,000 max order size

#### Phase 4: Public Launch
- Remove whitelist
- Increase limits
- Add more token pairs
- Multi-chain deployment (Arbitrum, Ethereum mainnet)
- Analytics dashboard
- On-demand pool creation for arbitrary pairs

## Gas Optimization

### Batch Processing

```solidity
// Process multiple expired orders in one transaction
function batchCloseExpired(bytes32[] calldata orderIds)
    external
    returns (CloseResult[] memory results)
{
    results = new CloseResult[](orderIds.length);

    for (uint256 i = 0; i < orderIds.length; i++) {
        results[i] = _closeOrder(orderIds[i]);
    }

    return results;
}
```

### Storage Packing

```solidity
// Pack order data efficiently
struct PackedOrderData {
    // Slot 1: 256 bits
    address owner;              // 160 bits
    int24 tickLower;            // 24 bits
    int24 tickUpper;            // 24 bits
    uint8 status;               // 8 bits
    uint8 direction;            // 8 bits
    // 32 bits unused

    // Slot 2: 256 bits
    uint128 liquidity;          // 128 bits
    uint64 createdAt;           // 64 bits
    uint64 deadline;            // 64 bits
}
```
