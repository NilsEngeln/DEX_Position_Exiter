# DEX Position Exiter - Architecture Document

## Overview

A payment-gated (x402 standard) token exit service that utilizes Uniswap V4 hooks to enable intelligent, low-impact token exits (or entries) for DeFi positions.

## Problem Statement

When exiting large positions in low-liquidity tokens, direct market sells cause significant price impact and "ruin the chart." This service provides an alternative: creating optimized Uniswap V4 liquidity positions that allow gradual exits as natural market activity moves the price through the position's tick range.

## Core Concept

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           USER/AGENT FLOW                                    │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  1. Agent Request                    2. x402 Payment                         │
│  ┌─────────────┐                     ┌─────────────┐                        │
│  │ "Sell 20%   │  ──HTTP Request──▶  │   402       │                        │
│  │  of CoinX   │                     │  Payment    │                        │
│  │  for USDC"  │  ◀──Payment Req──   │  Required   │                        │
│  └─────────────┘                     └─────────────┘                        │
│         │                                   │                                │
│         │                                   ▼                                │
│         │                            ┌─────────────┐                        │
│         │  ──Pay (USDC on L2)──────▶ │  Facilitator│                        │
│         │                            │  (Coinbase) │                        │
│         │                            └─────────────┘                        │
│         ▼                                                                    │
│  3. Position Creation                                                        │
│  ┌─────────────────────────────────────────────────────────────┐            │
│  │                    UNISWAP V4 POOL                          │            │
│  │  ┌──────────────────────────────────────────────────────┐   │            │
│  │  │     Current    │    LP Position (100% CoinX)         │   │            │
│  │  │      Price     │    Tick Range: [current+1, upper]   │   │            │
│  │  │        ▼       │                                      │   │            │
│  │  │    ────●────────████████████████████─────────────     │   │            │
│  │  │               │◀─── Sell Zone ────▶│                  │   │            │
│  │  └──────────────────────────────────────────────────────┘   │            │
│  └─────────────────────────────────────────────────────────────┘            │
│                                                                              │
│  4. Over Time (e.g., 7 days)                                                │
│  ┌─────────────────────────────────────────────────────────────┐            │
│  │  Price moves up ───▶  Position converts: CoinX → USDC       │            │
│  │                                                              │            │
│  │  If fully converted: Auto-close LP, return USDC + fees      │            │
│  │  If time expires:    Close LP, return mix + unused gas      │            │
│  └─────────────────────────────────────────────────────────────┘            │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

## System Architecture

```
┌────────────────────────────────────────────────────────────────────────────────┐
│                              SYSTEM COMPONENTS                                  │
├────────────────────────────────────────────────────────────────────────────────┤
│                                                                                 │
│  ┌─────────────────┐         ┌─────────────────────────────────────────────┐   │
│  │   API SERVER    │         │            SMART CONTRACTS                   │   │
│  │   (Express +    │         │                                              │   │
│  │    x402)        │         │   ┌─────────────────────────────────────┐   │   │
│  │                 │         │   │    PositionExiterHook.sol           │   │   │
│  │  ┌───────────┐  │         │   │    (Uniswap V4 Hook)                 │   │   │
│  │  │ POST      │  │         │   │                                      │   │   │
│  │  │ /exit     │──┼────────▶│   │  - afterSwap() monitoring           │   │   │
│  │  │           │  │         │   │  - Position state tracking           │   │   │
│  │  └───────────┘  │         │   │  - Auto-close on fill                │   │   │
│  │                 │         │   └─────────────────────────────────────┘   │   │
│  │  ┌───────────┐  │         │                      │                       │   │
│  │  │ GET       │  │         │                      ▼                       │   │
│  │  │ /status   │  │         │   ┌─────────────────────────────────────┐   │   │
│  │  │ /:orderId │  │         │   │    PositionManager.sol              │   │   │
│  │  └───────────┘  │         │   │    (Extended from v4-periphery)     │   │   │
│  │                 │         │   │                                      │   │   │
│  │  ┌───────────┐  │         │   │  - Mints/burns LP positions         │   │   │
│  │  │ POST      │  │         │   │  - Manages token approvals          │   │   │
│  │  │ /cancel   │  │         │   │  - Handles gas escrow               │   │   │
│  │  │ /:orderId │  │         │   └─────────────────────────────────────┘   │   │
│  │  └───────────┘  │         │                      │                       │   │
│  │                 │         │                      ▼                       │   │
│  │  ┌───────────┐  │         │   ┌─────────────────────────────────────┐   │   │
│  │  │ Tick      │  │         │   │    GasEscrow.sol                    │   │   │
│  │  │ Calculator│◀─┼─────────┼───│                                      │   │   │
│  │  │ Service   │  │         │   │  - Holds prepaid gas fees           │   │   │
│  │  └───────────┘  │         │   │  - Refunds unused gas               │   │   │
│  │                 │         │   │  - Pays executor on close           │   │   │
│  └─────────────────┘         │   └─────────────────────────────────────┘   │   │
│                              │                                              │   │
│  ┌─────────────────┐         │   ┌─────────────────────────────────────┐   │   │
│  │   ORACLE &      │         │   │    TokenAllowanceGuard.sol          │   │   │
│  │   ANALYTICS     │         │   │                                      │   │   │
│  │                 │         │   │  - Limited approval scope            │   │   │
│  │  - Price feeds  │         │   │  - Per-order token limits            │   │   │
│  │  - Volatility   │         │   │  - Time-bound approvals              │   │   │
│  │  - Liquidity    │         │   └─────────────────────────────────────┘   │   │
│  │    depth        │         │                                              │   │
│  └─────────────────┘         └─────────────────────────────────────────────┘   │
│                                                                                 │
└────────────────────────────────────────────────────────────────────────────────┘
```

## Component Details

### 1. API Server (x402 Payment-Gated)

The API server handles incoming requests and payment verification using the x402 standard.

```
┌──────────────────────────────────────────────────────────────────────┐
│                        x402 PAYMENT FLOW                              │
├──────────────────────────────────────────────────────────────────────┤
│                                                                       │
│  Agent/User                    API Server                Facilitator  │
│      │                             │                          │       │
│      │──POST /exit ────────────────▶                          │       │
│      │  {tokenSell, tokenBuy,      │                          │       │
│      │   amount, timeframe}        │                          │       │
│      │                             │                          │       │
│      │◀─────────402 Response───────│                          │       │
│      │  Headers:                   │                          │       │
│      │  - PAYMENT-REQUIRED:        │                          │       │
│      │    {amount, network,        │                          │       │
│      │     payTo, validUntil}      │                          │       │
│      │                             │                          │       │
│      │──POST /exit + Signed Tx ────▶                          │       │
│      │  Headers:                   │                          │       │
│      │  - PAYMENT-SIGNATURE        │──Verify & Settle────────▶│       │
│      │                             │                          │       │
│      │                             │◀─────Confirmed───────────│       │
│      │                             │                          │       │
│      │◀────200 OK + Order ID───────│                          │       │
│      │                             │                          │       │
└──────────────────────────────────────────────────────────────────────┘
```

### 2. Tick Range Calculator

The intelligent core that determines optimal position parameters.

**Inputs:**
- Token pair (tokenSell, tokenBuy)
- Amount to exit
- Timeframe
- Current pool state

**Calculations:**
1. **Current Price Analysis**: Fetch current tick from Uniswap V4 pool
2. **Volatility Assessment**: Analyze historical price movement
3. **Liquidity Depth**: Evaluate existing liquidity at various tick ranges
4. **Optimal Range**: Calculate tick range that:
   - Starts just above current price (for sells) or below (for buys)
   - Width based on volatility and timeframe
   - Maximizes probability of fill within timeframe
   - Minimizes price impact on existing liquidity

```python
# Pseudocode for tick range calculation
def calculate_optimal_range(token_sell, token_buy, amount, timeframe_days):
    pool = get_pool(token_sell, token_buy)
    current_tick = pool.current_tick
    tick_spacing = pool.tick_spacing

    # Historical volatility (standard deviation of daily returns)
    volatility = calculate_volatility(pool, days=30)

    # Expected price movement based on volatility and timeframe
    expected_move = volatility * sqrt(timeframe_days) * 2  # 2 sigma

    # Convert to ticks
    ticks_expected = price_to_ticks(expected_move)

    # For sells: position above current price
    tick_lower = align_to_spacing(current_tick + tick_spacing, tick_spacing)
    tick_upper = align_to_spacing(tick_lower + ticks_expected, tick_spacing)

    return TickRange(
        lower=tick_lower,
        upper=tick_upper,
        estimated_fill_probability=calculate_fill_prob(volatility, ticks_expected)
    )
```

### 3. Smart Contracts

#### PositionExiterHook.sol

Custom Uniswap V4 hook that monitors and manages exit positions.

```solidity
// Simplified interface
interface IPositionExiterHook {
    struct ExitOrder {
        address owner;
        PoolKey poolKey;
        int24 tickLower;
        int24 tickUpper;
        uint128 liquidity;
        uint256 deadline;
        uint256 gasEscrowed;
        bool isSellOrder;  // true = selling token0 for token1
        OrderStatus status;
    }

    enum OrderStatus { Active, Filled, Expired, Cancelled }

    // Create a new exit position
    function createExitPosition(
        PoolKey calldata key,
        int24 tickLower,
        int24 tickUpper,
        uint256 amount,
        uint256 deadline
    ) external returns (bytes32 orderId);

    // Hook callback - monitors for position fills
    function afterSwap(
        address sender,
        PoolKey calldata key,
        IPoolManager.SwapParams calldata params,
        BalanceDelta delta,
        bytes calldata hookData
    ) external returns (bytes4, int128);

    // Close position (auto-called on fill or expiry)
    function closePosition(bytes32 orderId) external;

    // Cancel order and return funds
    function cancelOrder(bytes32 orderId) external;
}
```

#### TokenAllowanceGuard.sol

Ensures users only approve exactly what's needed for each order.

```solidity
interface ITokenAllowanceGuard {
    struct AllowanceScope {
        address token;
        uint256 amount;
        bytes32 orderId;
        uint256 expiresAt;
    }

    // User approves tokens to this contract with specific scope
    function scopedApprove(
        address token,
        uint256 amount,
        bytes32 orderId,
        uint256 expiresAt
    ) external;

    // Only PositionManager can transfer, only for valid order
    function transferFrom(
        address token,
        address from,
        uint256 amount,
        bytes32 orderId
    ) external;
}
```

### 4. Data Flow

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         COMPLETE DATA FLOW                               │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  [1] REQUEST PHASE                                                       │
│  ═══════════════                                                         │
│  User ──▶ API: POST /exit                                                │
│           {                                                              │
│             tokenSell: "0x...",    // CoinX                              │
│             tokenBuy: "0x...",     // USDC                               │
│             amount: "20%",         // or absolute amount                 │
│             timeframe: 7           // days                               │
│           }                                                              │
│                                                                          │
│  [2] PRICING PHASE                                                       │
│  ═════════════════                                                       │
│  API ──▶ TickCalculator: Calculate optimal range                        │
│  API ──▶ GasEstimator: Estimate total gas (create + close)              │
│  API ──▶ FeeCalculator: Calculate service fee                           │
│                                                                          │
│  Total Payment = Gas Estimate + Service Fee + Buffer                     │
│                                                                          │
│  [3] PAYMENT PHASE (x402)                                                │
│  ═════════════════════════                                               │
│  API ──▶ User: 402 Response with payment requirements                   │
│  User ──▶ Blockchain: Sign and submit payment                           │
│  Facilitator ──▶ API: Confirm payment                                   │
│                                                                          │
│  [4] EXECUTION PHASE                                                     │
│  ══════════════════                                                      │
│  API ──▶ TokenAllowanceGuard: Verify user approval                      │
│  API ──▶ PositionManager: Create LP position                            │
│       ├──▶ GasEscrow: Deposit gas prepayment                            │
│       └──▶ PoolManager: Add liquidity at calculated ticks               │
│                                                                          │
│  [5] MONITORING PHASE (ongoing)                                          │
│  ════════════════════════════                                            │
│  Every swap in pool ──▶ PositionExiterHook.afterSwap()                  │
│       │                                                                  │
│       ├── Check if price crossed position's tick range                  │
│       │                                                                  │
│       └── If position fully converted OR deadline reached:              │
│           ├──▶ Remove liquidity                                         │
│           ├──▶ Transfer tokens to user                                  │
│           └──▶ Refund unused gas from escrow                            │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

## Security Model

### Token Approval Safety

```
┌──────────────────────────────────────────────────────────────────────┐
│                    SCOPED APPROVAL ARCHITECTURE                       │
├──────────────────────────────────────────────────────────────────────┤
│                                                                       │
│  Traditional (Risky)              Our Approach (Safe)                 │
│  ══════════════════               ════════════════════                │
│                                                                       │
│  User approves                    User approves                       │
│  MAX_UINT256 to                   EXACT amount to                     │
│  random contract                  TokenAllowanceGuard                 │
│       │                                  │                            │
│       ▼                                  ▼                            │
│  ┌─────────────┐                  ┌─────────────────────────────┐    │
│  │ Contract    │                  │ TokenAllowanceGuard         │    │
│  │ can drain   │                  │                             │    │
│  │ ALL tokens  │                  │ - Tracks per-order limits   │    │
│  │ forever     │                  │ - Time-bound approvals      │    │
│  └─────────────┘                  │ - Only PositionManager      │    │
│                                   │   can transfer              │    │
│                                   │ - Auto-revokes on close     │    │
│                                   └─────────────────────────────┘    │
│                                                                       │
└──────────────────────────────────────────────────────────────────────┘
```

### Gas Escrow Protection

1. **Prepayment**: User pays estimated gas upfront via x402
2. **Escrow**: Gas funds held in GasEscrow contract
3. **Execution**: Executor (keeper) receives payment for closing position
4. **Refund**: Unused gas returned to user automatically

### Smart Contract Security

- All contracts upgradeable via proxy pattern (for bug fixes)
- Timelock on admin functions
- Emergency pause functionality
- Formal verification of core logic
- Multiple audit rounds before mainnet

## Technology Stack

### Backend (API Server)
- **Runtime**: Node.js / TypeScript
- **Framework**: Express.js with x402 middleware
- **Database**: PostgreSQL (order tracking, analytics)
- **Cache**: Redis (rate limiting, session)
- **Queue**: Bull/BullMQ (background job processing)

### Smart Contracts
- **Language**: Solidity 0.8.26+
- **Framework**: Foundry
- **Dependencies**:
  - `@uniswap/v4-core`
  - `@uniswap/v4-periphery`
  - `@openzeppelin/contracts`
- **Deployment**: Hardhat + Foundry scripts

### Analytics & Oracles
- **Price Feeds**: Chainlink, Uniswap TWAP
- **Historical Data**: The Graph subgraph
- **Volatility**: Custom calculation from on-chain data

### Supported Networks (Initial)
- Base (primary - low fees, Coinbase ecosystem)
- Arbitrum
- Optimism
- Ethereum Mainnet (for high-value positions)

## API Specification

### POST /exit (x402 Protected)

Create a new exit order.

**Request:**
```json
{
  "tokenSell": "0x1234....",
  "tokenBuy": "0x5678....",
  "amount": "1000000000000000000",
  "amountType": "absolute",
  "timeframeDays": 7,
  "minFillPercent": 80,
  "network": "base"
}
```

**Response (after payment):**
```json
{
  "orderId": "0xabcd...",
  "status": "created",
  "position": {
    "tickLower": 100200,
    "tickUpper": 100800,
    "liquidity": "5000000000000000000",
    "estimatedFillPrice": "1.05",
    "estimatedFillProbability": 0.85
  },
  "costs": {
    "gasPrepaid": "0.005",
    "serviceFee": "0.001",
    "total": "0.006"
  },
  "expiresAt": "2024-01-15T00:00:00Z"
}
```

### GET /status/:orderId

Get order status and current position state.

### POST /cancel/:orderId

Cancel an active order (returns tokens minus gas used).

### GET /estimate

Get cost estimate without creating order.

## Open Questions

1. **Hook vs Keeper Architecture**: Should position closing be triggered by:
   - Hook's afterSwap (more gas efficient, but adds overhead to every swap)
   - External keeper network (more flexible, but requires incentivization)
   - Hybrid approach?

2. **Multi-hop Exits**: Should we support exits through multiple pools for better routing?

3. **Partial Fills**: How to handle positions that only partially fill before deadline?

4. **MEV Protection**: How to protect users from sandwich attacks during position creation?

5. **Fee Structure**: Flat fee vs percentage-based vs tiered?

## Next Steps

1. [ ] Finalize architecture decisions (answer open questions)
2. [ ] Design detailed smart contract interfaces
3. [ ] Prototype tick calculation algorithm
4. [ ] Set up development environment (Foundry + local node)
5. [ ] Implement core smart contracts
6. [ ] Build API server with x402 integration
7. [ ] Testing (unit, integration, mainnet fork)
8. [ ] Security audit
9. [ ] Testnet deployment
10. [ ] Mainnet launch

---

## References

- [x402 Protocol - Coinbase](https://www.x402.org/)
- [x402 GitHub Repository](https://github.com/coinbase/x402)
- [Uniswap V4 Documentation](https://docs.uniswap.org/contracts/v4/overview)
- [Uniswap V4 Hooks Guide](https://docs.uniswap.org/contracts/v4/concepts/hooks)
- [LimitOrder Hook Example](https://github.com/Uniswap/v4-periphery/blob/example-contracts/contracts/hooks/examples/LimitOrder.sol)
- [Uniswap V4 Whitepaper](https://app.uniswap.org/whitepaper-v4.pdf)
