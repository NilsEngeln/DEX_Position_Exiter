// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";

/// @title IPositionExiterHook
/// @notice Interface for the Position Exiter Hook - a Uniswap V4 hook that enables
///         intelligent, low-impact token exits through single-sided LP positions
/// @dev This hook monitors afterSwap events to detect when positions are filled
interface IPositionExiterHook {
    // ═══════════════════════════════════════════════════════════════════════════
    // ENUMS
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Status of an exit order
    enum OrderStatus {
        Active,     // Position is live, waiting for price to move through range
        Filled,     // Position fully converted to target token
        Expired,    // Deadline reached, position closed with current mix
        Cancelled   // User cancelled before fill
    }

    /// @notice Direction of the exit order
    enum OrderDirection {
        SellToken0ForToken1,  // Placing liquidity above current price
        SellToken1ForToken0   // Placing liquidity below current price
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // STRUCTS
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Full details of an exit order
    struct ExitOrder {
        address owner;           // Order creator
        address recipient;       // Where to send tokens on close
        PoolKey poolKey;         // Uniswap V4 pool identifier
        int24 tickLower;         // Lower tick of position
        int24 tickUpper;         // Upper tick of position
        uint128 liquidity;       // Liquidity amount in position
        OrderDirection direction; // Sell direction
        uint256 createdAt;       // Timestamp of creation
        uint256 deadline;        // Expiry timestamp
        OrderStatus status;      // Current status
        uint256 token0Deposited; // Original token0 amount
        uint256 token1Deposited; // Original token1 amount
    }

    /// @notice Parameters for creating a new order
    struct CreateOrderParams {
        PoolKey poolKey;         // Pool to create position in
        int24 tickLower;         // Lower tick of position
        int24 tickUpper;         // Upper tick of position
        uint256 amountIn;        // Amount of token to sell
        OrderDirection direction; // Sell direction
        uint256 deadline;        // Order expiry timestamp
        address recipient;       // Where to send output tokens
    }

    /// @notice Result of closing an order
    struct CloseResult {
        uint256 token0Out;       // Token0 returned to user
        uint256 token1Out;       // Token1 returned to user
        uint256 feesEarned0;     // Fees earned in token0
        uint256 feesEarned1;     // Fees earned in token1
        OrderStatus finalStatus; // Final order status
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // EVENTS
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Emitted when a new exit order is created
    event OrderCreated(
        bytes32 indexed orderId,
        address indexed owner,
        address indexed recipient,
        int24 tickLower,
        int24 tickUpper,
        uint128 liquidity,
        OrderDirection direction,
        uint256 deadline
    );

    /// @notice Emitted when an order is fully filled
    event OrderFilled(
        bytes32 indexed orderId,
        address indexed owner,
        uint256 amountOut,
        uint256 feesEarned
    );

    /// @notice Emitted when an order expires and is closed
    event OrderExpired(
        bytes32 indexed orderId,
        address indexed owner,
        uint256 token0Out,
        uint256 token1Out
    );

    /// @notice Emitted when an order is cancelled by the owner
    event OrderCancelled(
        bytes32 indexed orderId,
        address indexed owner,
        uint256 token0Returned,
        uint256 token1Returned
    );

    // ═══════════════════════════════════════════════════════════════════════════
    // ERRORS
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Tick values are not aligned to pool's tick spacing
    error InvalidTickAlignment();

    /// @notice tickLower must be less than tickUpper
    error InvalidTickRange();

    /// @notice Deadline must be in the future
    error DeadlineInPast();

    /// @notice Deadline exceeds maximum allowed duration
    error DeadlineTooFar();

    /// @notice Amount must be greater than zero
    error ZeroAmount();

    /// @notice Order does not exist
    error OrderNotFound();

    /// @notice Caller is not the order owner
    error NotOrderOwner();

    /// @notice Order is not in Active status
    error OrderNotActive();

    /// @notice Order has not expired yet
    error OrderNotExpired();

    /// @notice Insufficient token approval
    error InsufficientAllowance();

    // ═══════════════════════════════════════════════════════════════════════════
    // CONSTANTS
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Service fee in USD (1 dollar = 1e6 with 6 decimals)
    function SERVICE_FEE() external view returns (uint256);

    /// @notice Maximum order duration (30 days)
    function MAX_ORDER_DURATION() external view returns (uint256);

    // ═══════════════════════════════════════════════════════════════════════════
    // EXTERNAL FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Create a new exit order
    /// @dev Caller must have approved tokens to this contract
    /// @param params Order creation parameters
    /// @return orderId Unique identifier for the order
    function createOrder(CreateOrderParams calldata params)
        external
        returns (bytes32 orderId);

    /// @notice Cancel an active order and return tokens to owner
    /// @dev Only callable by order owner
    /// @param orderId The order to cancel
    /// @return result The tokens returned
    function cancelOrder(bytes32 orderId)
        external
        returns (CloseResult memory result);

    /// @notice Close an order that has reached its deadline
    /// @dev Can be called by anyone - designed to be called by hook's afterSwap
    /// @param orderId The order to close
    /// @return result The final state and amounts
    function closeExpiredOrder(bytes32 orderId)
        external
        returns (CloseResult memory result);

    // ═══════════════════════════════════════════════════════════════════════════
    // VIEW FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Get full order details
    /// @param orderId The order to query
    /// @return order The order details
    function getOrder(bytes32 orderId) external view returns (ExitOrder memory order);

    /// @notice Get current fill status of an order
    /// @param orderId The order to query
    /// @return fillPercent 0-100 representing conversion percentage
    /// @return currentToken0 Current token0 amount in position
    /// @return currentToken1 Current token1 amount in position
    function getOrderFillStatus(bytes32 orderId)
        external
        view
        returns (uint8 fillPercent, uint256 currentToken0, uint256 currentToken1);

    /// @notice Get all active orders for an owner
    /// @param owner The address to query
    /// @return orderIds Array of active order IDs
    function getActiveOrders(address owner)
        external
        view
        returns (bytes32[] memory orderIds);

    /// @notice Check if an order can be closed
    /// @param orderId The order to check
    /// @return closeable Whether the order can be closed
    /// @return reason Description of why (or why not)
    function canClose(bytes32 orderId)
        external
        view
        returns (bool closeable, string memory reason);

    /// @notice Get the total number of orders created
    /// @return count Total order count
    function orderCount() external view returns (uint256 count);
}
