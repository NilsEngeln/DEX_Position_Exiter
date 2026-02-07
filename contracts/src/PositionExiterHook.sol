// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {BaseHook} from "@openzeppelin/uniswap-hooks/base/BaseHook.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {BalanceDelta, toBalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary} from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";
import {SwapParams, ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {Currency, CurrencyLibrary} from "@uniswap/v4-core/src/types/Currency.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {TransientStateLibrary} from "@uniswap/v4-core/src/libraries/TransientStateLibrary.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";
import {LiquidityAmounts} from "@uniswap/v4-core/test/utils/LiquidityAmounts.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {CurrencySettler} from "@uniswap/v4-core/test/utils/CurrencySettler.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IPositionExiterHook} from "./interfaces/IPositionExiterHook.sol";

/// @title PositionExiterHook
/// @notice A Uniswap V4 hook that enables intelligent, low-impact token exits
///         through single-sided LP positions that auto-close when filled
/// @dev Implements afterSwap hook to monitor price movements and close filled positions
contract PositionExiterHook is BaseHook, IPositionExiterHook, IUnlockCallback, ReentrancyGuard {
    using PoolIdLibrary for PoolKey;
    using CurrencyLibrary for Currency;
    using SafeERC20 for IERC20;
    using StateLibrary for IPoolManager;
    using TransientStateLibrary for IPoolManager;
    using CurrencySettler for Currency;

    // ═══════════════════════════════════════════════════════════════════════════
    // CONSTANTS
    // ═══════════════════════════════════════════════════════════════════════════

    /// @inheritdoc IPositionExiterHook
    uint256 public constant SERVICE_FEE = 1e6; // $1 with 6 decimals (USDC)

    /// @inheritdoc IPositionExiterHook
    uint256 public constant MAX_ORDER_DURATION = 30 days;

    // ═══════════════════════════════════════════════════════════════════════════
    // STATE VARIABLES
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Mapping from orderId to ExitOrder
    mapping(bytes32 => ExitOrder) public orders;

    /// @notice Mapping from owner to their active order IDs
    mapping(address => bytes32[]) public ownerOrders;

    /// @notice Mapping from poolId to list of active orders in that pool
    mapping(PoolId => bytes32[]) public poolOrders;

    /// @notice Last recorded tick for each pool (for detecting tick crossings)
    mapping(PoolId => int24) public lastTicks;

    /// @notice Total number of orders ever created
    uint256 public totalOrders;

    /// @notice Address to receive service fees
    address public feeRecipient;

    // ═══════════════════════════════════════════════════════════════════════════
    // CALLBACK DATA TYPES
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Callback action types
    enum CallbackAction {
        AddLiquidity,
        RemoveLiquidity
    }

    /// @notice Data passed to unlock callback for adding liquidity
    struct AddLiquidityCallbackData {
        bytes32 orderId;
        PoolKey poolKey;
        int24 tickLower;
        int24 tickUpper;
        uint256 amount0;
        uint256 amount1;
        address sender;
    }

    /// @notice Data passed to unlock callback for removing liquidity
    struct RemoveLiquidityCallbackData {
        bytes32 orderId;
        PoolKey poolKey;
        int24 tickLower;
        int24 tickUpper;
        uint128 liquidity;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // CONSTRUCTOR
    // ═══════════════════════════════════════════════════════════════════════════

    constructor(IPoolManager _poolManager, address _feeRecipient) BaseHook(_poolManager) {
        feeRecipient = _feeRecipient;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // HOOK PERMISSIONS
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Returns the hook's permissions
    /// @dev We only need afterSwap to monitor for filled positions
    function getHookPermissions() public pure override returns (Hooks.Permissions memory) {
        return Hooks.Permissions({
            beforeInitialize: false,
            afterInitialize: true,   // To record initial tick
            beforeAddLiquidity: false,
            afterAddLiquidity: false,
            beforeRemoveLiquidity: false,
            afterRemoveLiquidity: false,
            beforeSwap: false,
            afterSwap: true,         // Main hook - monitor for fills
            beforeDonate: false,
            afterDonate: false,
            beforeSwapReturnDelta: false,
            afterSwapReturnDelta: false,
            afterAddLiquidityReturnDelta: false,
            afterRemoveLiquidityReturnDelta: false
        });
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // HOOK CALLBACKS
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Called after pool initialization
    /// @dev Records the initial tick for the pool
    function _afterInitialize(
        address,
        PoolKey calldata key,
        uint160,
        int24 tick
    ) internal override returns (bytes4) {
        lastTicks[key.toId()] = tick;
        return BaseHook.afterInitialize.selector;
    }

    /// @notice Called after every swap - monitors for filled positions
    /// @dev This is the core of the hook - detects tick crossings and closes filled orders
    function _afterSwap(
        address,
        PoolKey calldata key,
        SwapParams calldata,
        BalanceDelta,
        bytes calldata
    ) internal override returns (bytes4, int128) {
        PoolId poolId = key.toId();

        // Get current tick
        (, int24 currentTick,,) = poolManager.getSlot0(poolId);

        // Get previous tick
        int24 previousTick = lastTicks[poolId];

        // Update stored tick
        lastTicks[poolId] = currentTick;

        // If tick changed, check for filled orders
        if (currentTick != previousTick) {
            _processTickCrossing(poolId, previousTick, currentTick, key);
        }

        return (BaseHook.afterSwap.selector, 0);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // EXTERNAL FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════════════

    /// @inheritdoc IPositionExiterHook
    function createOrder(CreateOrderParams calldata params)
        external
        nonReentrant
        returns (bytes32 orderId)
    {
        // Validate parameters
        _validateOrderParams(params);

        // Generate order ID
        orderId = _generateOrderId(msg.sender, totalOrders);
        totalOrders++;

        // Transfer tokens from user
        (uint256 token0Amount, uint256 token1Amount) = _transferTokensIn(params);

        // Create the order
        orders[orderId] = ExitOrder({
            owner: msg.sender,
            recipient: params.recipient,
            poolKey: params.poolKey,
            tickLower: params.tickLower,
            tickUpper: params.tickUpper,
            liquidity: 0, // Will be set after adding liquidity
            direction: params.direction,
            createdAt: block.timestamp,
            deadline: params.deadline,
            status: OrderStatus.Active,
            token0Deposited: token0Amount,
            token1Deposited: token1Amount
        });

        // Add liquidity to the pool
        uint128 liquidity = _addLiquidity(orderId, params);
        orders[orderId].liquidity = liquidity;

        // Track order
        ownerOrders[msg.sender].push(orderId);
        poolOrders[params.poolKey.toId()].push(orderId);

        emit OrderCreated(
            orderId,
            msg.sender,
            params.recipient,
            params.tickLower,
            params.tickUpper,
            liquidity,
            params.direction,
            params.deadline
        );
    }

    /// @inheritdoc IPositionExiterHook
    function cancelOrder(bytes32 orderId)
        external
        nonReentrant
        returns (CloseResult memory result)
    {
        ExitOrder storage order = orders[orderId];

        if (order.owner == address(0)) revert OrderNotFound();
        if (order.owner != msg.sender) revert NotOrderOwner();
        if (order.status != OrderStatus.Active) revert OrderNotActive();

        // Remove liquidity and get tokens back
        result = _removeLiquidity(orderId);
        result.finalStatus = OrderStatus.Cancelled;

        // Update order status
        order.status = OrderStatus.Cancelled;

        // Transfer tokens to owner
        _transferTokensOut(order.poolKey, order.owner, result.token0Out, result.token1Out);

        emit OrderCancelled(orderId, order.owner, result.token0Out, result.token1Out);
    }

    /// @inheritdoc IPositionExiterHook
    function closeExpiredOrder(bytes32 orderId)
        external
        nonReentrant
        returns (CloseResult memory result)
    {
        ExitOrder storage order = orders[orderId];

        if (order.owner == address(0)) revert OrderNotFound();
        if (order.status != OrderStatus.Active) revert OrderNotActive();
        if (block.timestamp < order.deadline) revert OrderNotExpired();

        // Remove liquidity
        result = _removeLiquidity(orderId);
        result.finalStatus = OrderStatus.Expired;

        // Update order status
        order.status = OrderStatus.Expired;

        // Transfer tokens to recipient
        _transferTokensOut(order.poolKey, order.recipient, result.token0Out, result.token1Out);

        emit OrderExpired(orderId, order.owner, result.token0Out, result.token1Out);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // VIEW FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════════════

    /// @inheritdoc IPositionExiterHook
    function getOrder(bytes32 orderId) external view returns (ExitOrder memory) {
        return orders[orderId];
    }

    /// @inheritdoc IPositionExiterHook
    function getOrderFillStatus(bytes32 orderId)
        external
        view
        returns (uint8 fillPercent, uint256 currentToken0, uint256 currentToken1)
    {
        ExitOrder storage order = orders[orderId];
        if (order.owner == address(0)) revert OrderNotFound();

        // Get current position amounts
        (currentToken0, currentToken1) = _getPositionAmounts(orderId);

        // Calculate fill percentage based on direction
        if (order.direction == OrderDirection.SellToken0ForToken1) {
            // Selling token0: fill % = how much token0 has converted to token1
            if (order.token0Deposited > 0) {
                uint256 token0Remaining = currentToken0;
                uint256 token0Converted = order.token0Deposited > token0Remaining
                    ? order.token0Deposited - token0Remaining
                    : 0;
                fillPercent = uint8((token0Converted * 100) / order.token0Deposited);
            }
        } else {
            // Selling token1: fill % = how much token1 has converted to token0
            if (order.token1Deposited > 0) {
                uint256 token1Remaining = currentToken1;
                uint256 token1Converted = order.token1Deposited > token1Remaining
                    ? order.token1Deposited - token1Remaining
                    : 0;
                fillPercent = uint8((token1Converted * 100) / order.token1Deposited);
            }
        }
    }

    /// @inheritdoc IPositionExiterHook
    function getActiveOrders(address owner) external view returns (bytes32[] memory) {
        bytes32[] storage allOrders = ownerOrders[owner];
        uint256 activeCount = 0;

        // Count active orders
        for (uint256 i = 0; i < allOrders.length; i++) {
            if (orders[allOrders[i]].status == OrderStatus.Active) {
                activeCount++;
            }
        }

        // Build array of active orders
        bytes32[] memory activeOrders = new bytes32[](activeCount);
        uint256 index = 0;
        for (uint256 i = 0; i < allOrders.length; i++) {
            if (orders[allOrders[i]].status == OrderStatus.Active) {
                activeOrders[index] = allOrders[i];
                index++;
            }
        }

        return activeOrders;
    }

    /// @inheritdoc IPositionExiterHook
    function canClose(bytes32 orderId)
        external
        view
        returns (bool closeable, string memory reason)
    {
        ExitOrder storage order = orders[orderId];

        if (order.owner == address(0)) {
            return (false, "Order not found");
        }
        if (order.status != OrderStatus.Active) {
            return (false, "Order not active");
        }
        if (block.timestamp >= order.deadline) {
            return (true, "Order expired");
        }

        // Check if filled based on current tick
        PoolId poolId = order.poolKey.toId();
        (, int24 currentTick,,) = poolManager.getSlot0(poolId);

        bool isFilled = _isOrderFilled(order, currentTick);
        if (isFilled) {
            return (true, "Order filled");
        }

        return (false, "Order still active");
    }

    /// @inheritdoc IPositionExiterHook
    function orderCount() external view returns (uint256) {
        return totalOrders;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // INTERNAL FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Validate order creation parameters
    function _validateOrderParams(CreateOrderParams calldata params) internal view {
        // Validate tick alignment
        int24 tickSpacing = params.poolKey.tickSpacing;
        if (params.tickLower % tickSpacing != 0) revert InvalidTickAlignment();
        if (params.tickUpper % tickSpacing != 0) revert InvalidTickAlignment();

        // Validate tick order
        if (params.tickLower >= params.tickUpper) revert InvalidTickRange();

        // Validate deadline
        if (params.deadline <= block.timestamp) revert DeadlineInPast();
        if (params.deadline > block.timestamp + MAX_ORDER_DURATION) revert DeadlineTooFar();

        // Validate amount
        if (params.amountIn == 0) revert ZeroAmount();
    }

    /// @notice Generate a unique order ID
    function _generateOrderId(address owner, uint256 nonce) internal view returns (bytes32) {
        return keccak256(abi.encodePacked(owner, nonce, block.timestamp, block.prevrandao));
    }

    /// @notice Transfer tokens from user to this contract
    function _transferTokensIn(CreateOrderParams calldata params)
        internal
        returns (uint256 token0Amount, uint256 token1Amount)
    {
        Currency currency0 = params.poolKey.currency0;
        Currency currency1 = params.poolKey.currency1;

        if (params.direction == OrderDirection.SellToken0ForToken1) {
            // Selling token0: only need token0
            token0Amount = params.amountIn;
            token1Amount = 0;

            if (!currency0.isAddressZero()) {
                IERC20(Currency.unwrap(currency0)).safeTransferFrom(
                    msg.sender,
                    address(this),
                    token0Amount
                );
            }
        } else {
            // Selling token1: only need token1
            token0Amount = 0;
            token1Amount = params.amountIn;

            if (!currency1.isAddressZero()) {
                IERC20(Currency.unwrap(currency1)).safeTransferFrom(
                    msg.sender,
                    address(this),
                    token1Amount
                );
            }
        }
    }

    /// @notice Callback from PoolManager.unlock()
    /// @dev This is called by the PoolManager after we call unlock()
    function unlockCallback(bytes calldata data) external override returns (bytes memory) {
        require(msg.sender == address(poolManager), "Only PoolManager");

        (CallbackAction action, bytes memory callbackData) = abi.decode(data, (CallbackAction, bytes));

        if (action == CallbackAction.AddLiquidity) {
            return _handleAddLiquidityCallback(callbackData);
        } else if (action == CallbackAction.RemoveLiquidity) {
            return _handleRemoveLiquidityCallback(callbackData);
        }

        revert("Unknown action");
    }

    /// @notice Handle the add liquidity callback
    function _handleAddLiquidityCallback(bytes memory data) internal returns (bytes memory) {
        AddLiquidityCallbackData memory callbackData = abi.decode(data, (AddLiquidityCallbackData));

        // Calculate liquidity from amounts
        (, int24 currentTick,,) = poolManager.getSlot0(callbackData.poolKey.toId());
        uint160 sqrtPriceX96 = TickMath.getSqrtPriceAtTick(currentTick);
        uint160 sqrtPriceLowerX96 = TickMath.getSqrtPriceAtTick(callbackData.tickLower);
        uint160 sqrtPriceUpperX96 = TickMath.getSqrtPriceAtTick(callbackData.tickUpper);

        uint128 liquidity = LiquidityAmounts.getLiquidityForAmounts(
            sqrtPriceX96,
            sqrtPriceLowerX96,
            sqrtPriceUpperX96,
            callbackData.amount0,
            callbackData.amount1
        );

        // Modify position (add liquidity)
        (BalanceDelta delta,) = poolManager.modifyLiquidity(
            callbackData.poolKey,
            ModifyLiquidityParams({
                tickLower: callbackData.tickLower,
                tickUpper: callbackData.tickUpper,
                liquidityDelta: int256(uint256(liquidity)),
                salt: callbackData.orderId
            }),
            ""
        );

        // Settle tokens with the PoolManager
        // delta.amount0() is negative when we owe tokens to the pool
        if (delta.amount0() < 0) {
            callbackData.poolKey.currency0.settle(
                poolManager,
                address(this),
                uint256(-int256(delta.amount0())),
                false // not using claims
            );
        }
        if (delta.amount1() < 0) {
            callbackData.poolKey.currency1.settle(
                poolManager,
                address(this),
                uint256(-int256(delta.amount1())),
                false
            );
        }

        return abi.encode(liquidity);
    }

    /// @notice Handle the remove liquidity callback
    function _handleRemoveLiquidityCallback(bytes memory data) internal returns (bytes memory) {
        RemoveLiquidityCallbackData memory callbackData = abi.decode(data, (RemoveLiquidityCallbackData));

        // Remove liquidity (negative liquidityDelta)
        (BalanceDelta delta,) = poolManager.modifyLiquidity(
            callbackData.poolKey,
            ModifyLiquidityParams({
                tickLower: callbackData.tickLower,
                tickUpper: callbackData.tickUpper,
                liquidityDelta: -int256(uint256(callbackData.liquidity)),
                salt: callbackData.orderId
            }),
            ""
        );

        // Take tokens from the PoolManager
        // delta.amount0() is positive when pool owes us tokens
        uint256 amount0Out = 0;
        uint256 amount1Out = 0;

        if (delta.amount0() > 0) {
            amount0Out = uint256(int256(delta.amount0()));
            callbackData.poolKey.currency0.take(
                poolManager,
                address(this),
                amount0Out,
                false
            );
        }
        if (delta.amount1() > 0) {
            amount1Out = uint256(int256(delta.amount1()));
            callbackData.poolKey.currency1.take(
                poolManager,
                address(this),
                amount1Out,
                false
            );
        }

        return abi.encode(amount0Out, amount1Out);
    }

    /// @notice Add liquidity to the pool using unlock callback pattern
    function _addLiquidity(bytes32 orderId, CreateOrderParams calldata params)
        internal
        returns (uint128 liquidity)
    {
        ExitOrder storage order = orders[orderId];

        // Approve tokens to PoolManager
        Currency currency0 = params.poolKey.currency0;
        Currency currency1 = params.poolKey.currency1;

        if (!currency0.isAddressZero() && order.token0Deposited > 0) {
            IERC20(Currency.unwrap(currency0)).approve(address(poolManager), order.token0Deposited);
        }
        if (!currency1.isAddressZero() && order.token1Deposited > 0) {
            IERC20(Currency.unwrap(currency1)).approve(address(poolManager), order.token1Deposited);
        }

        // Prepare callback data
        AddLiquidityCallbackData memory callbackData = AddLiquidityCallbackData({
            orderId: orderId,
            poolKey: params.poolKey,
            tickLower: params.tickLower,
            tickUpper: params.tickUpper,
            amount0: order.token0Deposited,
            amount1: order.token1Deposited,
            sender: msg.sender
        });

        // Call unlock which will call our unlockCallback
        bytes memory result = poolManager.unlock(
            abi.encode(CallbackAction.AddLiquidity, abi.encode(callbackData))
        );

        liquidity = abi.decode(result, (uint128));
    }

    /// @notice Remove liquidity from the pool using unlock callback pattern
    function _removeLiquidity(bytes32 orderId)
        internal
        returns (CloseResult memory result)
    {
        ExitOrder storage order = orders[orderId];

        // Prepare callback data
        RemoveLiquidityCallbackData memory callbackData = RemoveLiquidityCallbackData({
            orderId: orderId,
            poolKey: order.poolKey,
            tickLower: order.tickLower,
            tickUpper: order.tickUpper,
            liquidity: order.liquidity
        });

        // Call unlock which will call our unlockCallback
        bytes memory callbackResult = poolManager.unlock(
            abi.encode(CallbackAction.RemoveLiquidity, abi.encode(callbackData))
        );

        (result.token0Out, result.token1Out) = abi.decode(callbackResult, (uint256, uint256));

        // Calculate fees (simplified - in production would track fee growth)
        result.feesEarned0 = 0;
        result.feesEarned1 = 0;
    }

    /// @notice Get current token amounts in a position
    function _getPositionAmounts(bytes32 orderId)
        internal
        view
        returns (uint256 token0, uint256 token1)
    {
        ExitOrder storage order = orders[orderId];

        // Get position info from PoolManager
        PoolId poolId = order.poolKey.toId();
        (, int24 currentTick,,) = poolManager.getSlot0(poolId);

        // Calculate amounts based on current tick and liquidity
        uint160 sqrtPriceX96 = TickMath.getSqrtPriceAtTick(currentTick);
        uint160 sqrtPriceLowerX96 = TickMath.getSqrtPriceAtTick(order.tickLower);
        uint160 sqrtPriceUpperX96 = TickMath.getSqrtPriceAtTick(order.tickUpper);

        (token0, token1) = LiquidityAmounts.getAmountsForLiquidity(
            sqrtPriceX96,
            sqrtPriceLowerX96,
            sqrtPriceUpperX96,
            order.liquidity
        );
    }

    /// @notice Transfer tokens out to recipient
    function _transferTokensOut(
        PoolKey memory poolKey,
        address recipient,
        uint256 amount0,
        uint256 amount1
    ) internal {
        Currency currency0 = poolKey.currency0;
        Currency currency1 = poolKey.currency1;

        if (amount0 > 0 && !currency0.isAddressZero()) {
            IERC20(Currency.unwrap(currency0)).safeTransfer(recipient, amount0);
        }
        if (amount1 > 0 && !currency1.isAddressZero()) {
            IERC20(Currency.unwrap(currency1)).safeTransfer(recipient, amount1);
        }
    }

    /// @notice Process tick crossing and check for filled orders
    function _processTickCrossing(
        PoolId poolId,
        int24 previousTick,
        int24 currentTick,
        PoolKey calldata key
    ) internal {
        bytes32[] storage orderIds = poolOrders[poolId];

        for (uint256 i = 0; i < orderIds.length; i++) {
            bytes32 orderId = orderIds[i];
            ExitOrder storage order = orders[orderId];

            // Skip non-active orders
            if (order.status != OrderStatus.Active) continue;

            // Check if this tick crossing filled the order
            bool wasFilled = _didTickCrossingFillOrder(order, previousTick, currentTick);

            if (wasFilled) {
                _closeFilledOrder(orderId, order, key);
            }
        }
    }

    /// @notice Check if a tick crossing filled an order
    function _didTickCrossingFillOrder(
        ExitOrder storage order,
        int24 previousTick,
        int24 currentTick
    ) internal view returns (bool) {
        if (order.direction == OrderDirection.SellToken0ForToken1) {
            // Selling token0: filled when price goes UP through tickUpper
            // (price going up = tick going up for token0/token1 pair)
            return previousTick < order.tickUpper && currentTick >= order.tickUpper;
        } else {
            // Selling token1: filled when price goes DOWN through tickLower
            return previousTick > order.tickLower && currentTick <= order.tickLower;
        }
    }

    /// @notice Check if an order is currently filled based on tick
    function _isOrderFilled(ExitOrder storage order, int24 currentTick)
        internal
        view
        returns (bool)
    {
        if (order.direction == OrderDirection.SellToken0ForToken1) {
            return currentTick >= order.tickUpper;
        } else {
            return currentTick <= order.tickLower;
        }
    }

    /// @notice Close a filled order
    function _closeFilledOrder(
        bytes32 orderId,
        ExitOrder storage order,
        PoolKey calldata key
    ) internal {
        // Remove liquidity
        CloseResult memory result = _removeLiquidity(orderId);

        // Update status
        order.status = OrderStatus.Filled;

        // Transfer tokens to recipient
        _transferTokensOut(key, order.recipient, result.token0Out, result.token1Out);

        // Calculate fees earned (in output token)
        uint256 feesEarned = order.direction == OrderDirection.SellToken0ForToken1
            ? result.feesEarned1
            : result.feesEarned0;

        uint256 amountOut = order.direction == OrderDirection.SellToken0ForToken1
            ? result.token1Out
            : result.token0Out;

        emit OrderFilled(orderId, order.owner, amountOut, feesEarned);
    }
}
