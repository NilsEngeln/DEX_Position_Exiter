// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, console} from "forge-std/Test.sol";
import {Deployers} from "@uniswap/v4-core/test/utils/Deployers.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency, CurrencyLibrary} from "@uniswap/v4-core/src/types/Currency.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {SwapParams, ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";

import {PositionExiterHook} from "../src/PositionExiterHook.sol";
import {IPositionExiterHook} from "../src/interfaces/IPositionExiterHook.sol";

/// @title PositionExiterHookIntegrationTest
/// @notice Full integration tests with real PoolManager, routers, and hook deployment
contract PositionExiterHookIntegrationTest is Test, Deployers {
    using PoolIdLibrary for PoolKey;
    using CurrencyLibrary for Currency;
    using StateLibrary for IPoolManager;

    PositionExiterHook public hook;
    PoolKey poolKey;
    PoolId poolId;

    MockERC20 token0;
    MockERC20 token1;

    address feeRecipient = address(0xFEE);
    address user = address(0x1);
    address recipient = address(0x2);

    uint24 constant POOL_FEE = 3000;
    int24 constant TICK_SPACING = 60;

    function setUp() public {
        // Deploy PoolManager and all test routers
        deployFreshManagerAndRouters();

        // Deploy, mint, and approve two test currencies
        (currency0, currency1) = deployMintAndApprove2Currencies();
        token0 = MockERC20(Currency.unwrap(currency0));
        token1 = MockERC20(Currency.unwrap(currency1));

        // Deploy hook at address with correct flag bits (AFTER_INITIALIZE | AFTER_SWAP)
        uint160 flags = uint160(Hooks.AFTER_INITIALIZE_FLAG | Hooks.AFTER_SWAP_FLAG);
        address hookAddress =
            address(uint160(type(uint160).max & clearAllHookPermissionsMask | flags));

        deployCodeTo(
            "PositionExiterHook",
            abi.encode(manager, feeRecipient),
            hookAddress
        );
        hook = PositionExiterHook(hookAddress);

        // Initialize pool with our hook at 1:1 price
        poolKey = PoolKey({
            currency0: currency0,
            currency1: currency1,
            fee: POOL_FEE,
            tickSpacing: TICK_SPACING,
            hooks: IHooks(hookAddress)
        });
        poolId = poolKey.toId();
        manager.initialize(poolKey, SQRT_PRICE_1_1);

        // Seed pool with liquidity so swaps work
        modifyLiquidityRouter.modifyLiquidity(
            poolKey,
            ModifyLiquidityParams({
                tickLower: -600,
                tickUpper: 600,
                liquidityDelta: 100e18,
                salt: bytes32(0)
            }),
            ZERO_BYTES
        );

        // Fund user
        token0.mint(user, 100e18);
        token1.mint(user, 100e18);

        // User approves hook to pull tokens
        vm.startPrank(user);
        token0.approve(address(hook), type(uint256).max);
        token1.approve(address(hook), type(uint256).max);
        vm.stopPrank();
    }

    // ═══════════════════════════════════════════════════════════════════════
    // DEPLOYMENT & INITIALIZATION
    // ═══════════════════════════════════════════════════════════════════════

    function test_hookDeployment() public view {
        assertEq(hook.feeRecipient(), feeRecipient);
        assertEq(hook.totalOrders(), 0);
    }

    function test_afterInitializeRecordsTick() public view {
        // At SQRT_PRICE_1_1, tick should be 0
        int24 recordedTick = hook.lastTicks(poolId);
        assertEq(recordedTick, 0);
    }

    function test_hookPermissions() public view {
        Hooks.Permissions memory perms = hook.getHookPermissions();
        assertFalse(perms.beforeInitialize);
        assertTrue(perms.afterInitialize);
        assertFalse(perms.beforeSwap);
        assertTrue(perms.afterSwap);
        assertFalse(perms.beforeAddLiquidity);
        assertFalse(perms.afterAddLiquidity);
        assertFalse(perms.beforeRemoveLiquidity);
        assertFalse(perms.afterRemoveLiquidity);
        assertFalse(perms.beforeDonate);
        assertFalse(perms.afterDonate);
        assertFalse(perms.beforeSwapReturnDelta);
        assertFalse(perms.afterSwapReturnDelta);
        assertFalse(perms.afterAddLiquidityReturnDelta);
        assertFalse(perms.afterRemoveLiquidityReturnDelta);
    }

    function test_constants() public view {
        assertEq(hook.SERVICE_FEE(), 1e6);
        assertEq(hook.MAX_ORDER_DURATION(), 30 days);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // ORDER CREATION
    // ═══════════════════════════════════════════════════════════════════════

    function test_createOrder_SellToken0() public {
        IPositionExiterHook.CreateOrderParams memory params = IPositionExiterHook.CreateOrderParams({
            poolKey: poolKey,
            tickLower: 60,
            tickUpper: 120,
            amountIn: 1e18,
            direction: IPositionExiterHook.OrderDirection.SellToken0ForToken1,
            deadline: block.timestamp + 7 days,
            recipient: recipient
        });

        vm.prank(user);
        bytes32 orderId = hook.createOrder(params);

        assertTrue(orderId != bytes32(0));
        assertEq(hook.totalOrders(), 1);

        IPositionExiterHook.ExitOrder memory order = hook.getOrder(orderId);
        assertEq(order.owner, user);
        assertEq(order.recipient, recipient);
        assertEq(uint8(order.status), uint8(IPositionExiterHook.OrderStatus.Active));
        assertEq(
            uint8(order.direction),
            uint8(IPositionExiterHook.OrderDirection.SellToken0ForToken1)
        );
        assertEq(order.tickLower, 60);
        assertEq(order.tickUpper, 120);
        assertTrue(order.liquidity > 0);
        assertEq(order.token0Deposited, 1e18);
        assertEq(order.token1Deposited, 0);
    }

    function test_createOrder_SellToken1() public {
        IPositionExiterHook.CreateOrderParams memory params = IPositionExiterHook.CreateOrderParams({
            poolKey: poolKey,
            tickLower: -120,
            tickUpper: -60,
            amountIn: 1e18,
            direction: IPositionExiterHook.OrderDirection.SellToken1ForToken0,
            deadline: block.timestamp + 7 days,
            recipient: recipient
        });

        vm.prank(user);
        bytes32 orderId = hook.createOrder(params);

        IPositionExiterHook.ExitOrder memory order = hook.getOrder(orderId);
        assertEq(order.owner, user);
        assertEq(
            uint8(order.direction),
            uint8(IPositionExiterHook.OrderDirection.SellToken1ForToken0)
        );
        assertEq(order.token0Deposited, 0);
        assertEq(order.token1Deposited, 1e18);
    }

    function test_createOrder_transfersTokens() public {
        uint256 balanceBefore = token0.balanceOf(user);

        vm.prank(user);
        hook.createOrder(IPositionExiterHook.CreateOrderParams({
            poolKey: poolKey,
            tickLower: 60,
            tickUpper: 120,
            amountIn: 1e18,
            direction: IPositionExiterHook.OrderDirection.SellToken0ForToken1,
            deadline: block.timestamp + 7 days,
            recipient: recipient
        }));

        uint256 balanceAfter = token0.balanceOf(user);
        assertEq(balanceBefore - balanceAfter, 1e18);
    }

    function test_createMultipleOrders() public {
        vm.startPrank(user);

        bytes32 orderId1 = hook.createOrder(IPositionExiterHook.CreateOrderParams({
            poolKey: poolKey,
            tickLower: 60,
            tickUpper: 120,
            amountIn: 0.5e18,
            direction: IPositionExiterHook.OrderDirection.SellToken0ForToken1,
            deadline: block.timestamp + 7 days,
            recipient: recipient
        }));

        bytes32 orderId2 = hook.createOrder(IPositionExiterHook.CreateOrderParams({
            poolKey: poolKey,
            tickLower: 120,
            tickUpper: 180,
            amountIn: 0.5e18,
            direction: IPositionExiterHook.OrderDirection.SellToken0ForToken1,
            deadline: block.timestamp + 7 days,
            recipient: recipient
        }));

        vm.stopPrank();

        assertTrue(orderId1 != orderId2);
        assertEq(hook.orderCount(), 2);

        bytes32[] memory activeOrders = hook.getActiveOrders(user);
        assertEq(activeOrders.length, 2);
        assertEq(activeOrders[0], orderId1);
        assertEq(activeOrders[1], orderId2);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // VALIDATION TESTS
    // ═══════════════════════════════════════════════════════════════════════

    function test_createOrder_reverts_invalidTickAlignment() public {
        vm.prank(user);
        vm.expectRevert(IPositionExiterHook.InvalidTickAlignment.selector);
        hook.createOrder(IPositionExiterHook.CreateOrderParams({
            poolKey: poolKey,
            tickLower: 61, // Not aligned to tickSpacing=60
            tickUpper: 120,
            amountIn: 1e18,
            direction: IPositionExiterHook.OrderDirection.SellToken0ForToken1,
            deadline: block.timestamp + 7 days,
            recipient: recipient
        }));
    }

    function test_createOrder_reverts_invalidTickRange() public {
        vm.prank(user);
        vm.expectRevert(IPositionExiterHook.InvalidTickRange.selector);
        hook.createOrder(IPositionExiterHook.CreateOrderParams({
            poolKey: poolKey,
            tickLower: 120,
            tickUpper: 60, // Lower >= Upper
            amountIn: 1e18,
            direction: IPositionExiterHook.OrderDirection.SellToken0ForToken1,
            deadline: block.timestamp + 7 days,
            recipient: recipient
        }));
    }

    function test_createOrder_reverts_deadlineInPast() public {
        vm.prank(user);
        vm.expectRevert(IPositionExiterHook.DeadlineInPast.selector);
        hook.createOrder(IPositionExiterHook.CreateOrderParams({
            poolKey: poolKey,
            tickLower: 60,
            tickUpper: 120,
            amountIn: 1e18,
            direction: IPositionExiterHook.OrderDirection.SellToken0ForToken1,
            deadline: block.timestamp - 1,
            recipient: recipient
        }));
    }

    function test_createOrder_reverts_deadlineTooFar() public {
        vm.prank(user);
        vm.expectRevert(IPositionExiterHook.DeadlineTooFar.selector);
        hook.createOrder(IPositionExiterHook.CreateOrderParams({
            poolKey: poolKey,
            tickLower: 60,
            tickUpper: 120,
            amountIn: 1e18,
            direction: IPositionExiterHook.OrderDirection.SellToken0ForToken1,
            deadline: block.timestamp + 31 days,
            recipient: recipient
        }));
    }

    function test_createOrder_reverts_zeroAmount() public {
        vm.prank(user);
        vm.expectRevert(IPositionExiterHook.ZeroAmount.selector);
        hook.createOrder(IPositionExiterHook.CreateOrderParams({
            poolKey: poolKey,
            tickLower: 60,
            tickUpper: 120,
            amountIn: 0,
            direction: IPositionExiterHook.OrderDirection.SellToken0ForToken1,
            deadline: block.timestamp + 7 days,
            recipient: recipient
        }));
    }

    // ═══════════════════════════════════════════════════════════════════════
    // ORDER CANCELLATION
    // ═══════════════════════════════════════════════════════════════════════

    function test_cancelOrder() public {
        vm.prank(user);
        bytes32 orderId = hook.createOrder(IPositionExiterHook.CreateOrderParams({
            poolKey: poolKey,
            tickLower: 60,
            tickUpper: 120,
            amountIn: 1e18,
            direction: IPositionExiterHook.OrderDirection.SellToken0ForToken1,
            deadline: block.timestamp + 7 days,
            recipient: recipient
        }));

        uint256 userBal0Before = token0.balanceOf(user);

        vm.prank(user);
        IPositionExiterHook.CloseResult memory result = hook.cancelOrder(orderId);

        // Check status
        IPositionExiterHook.ExitOrder memory order = hook.getOrder(orderId);
        assertEq(uint8(order.status), uint8(IPositionExiterHook.OrderStatus.Cancelled));
        assertEq(uint8(result.finalStatus), uint8(IPositionExiterHook.OrderStatus.Cancelled));

        // User should receive tokens back
        uint256 userBal0After = token0.balanceOf(user);
        assertTrue(
            userBal0After > userBal0Before || result.token1Out > 0,
            "User should receive tokens back"
        );
    }

    function test_cancelOrder_removesFromActive() public {
        vm.startPrank(user);
        bytes32 orderId = hook.createOrder(IPositionExiterHook.CreateOrderParams({
            poolKey: poolKey,
            tickLower: 60,
            tickUpper: 120,
            amountIn: 1e18,
            direction: IPositionExiterHook.OrderDirection.SellToken0ForToken1,
            deadline: block.timestamp + 7 days,
            recipient: recipient
        }));

        assertEq(hook.getActiveOrders(user).length, 1);

        hook.cancelOrder(orderId);
        vm.stopPrank();

        assertEq(hook.getActiveOrders(user).length, 0);
    }

    function test_cancelOrder_reverts_notOwner() public {
        vm.prank(user);
        bytes32 orderId = hook.createOrder(IPositionExiterHook.CreateOrderParams({
            poolKey: poolKey,
            tickLower: 60,
            tickUpper: 120,
            amountIn: 1e18,
            direction: IPositionExiterHook.OrderDirection.SellToken0ForToken1,
            deadline: block.timestamp + 7 days,
            recipient: recipient
        }));

        vm.prank(recipient);
        vm.expectRevert(IPositionExiterHook.NotOrderOwner.selector);
        hook.cancelOrder(orderId);
    }

    function test_cancelOrder_reverts_notFound() public {
        vm.prank(user);
        vm.expectRevert(IPositionExiterHook.OrderNotFound.selector);
        hook.cancelOrder(bytes32(uint256(999)));
    }

    function test_cancelOrder_reverts_alreadyCancelled() public {
        vm.startPrank(user);
        bytes32 orderId = hook.createOrder(IPositionExiterHook.CreateOrderParams({
            poolKey: poolKey,
            tickLower: 60,
            tickUpper: 120,
            amountIn: 1e18,
            direction: IPositionExiterHook.OrderDirection.SellToken0ForToken1,
            deadline: block.timestamp + 7 days,
            recipient: recipient
        }));

        hook.cancelOrder(orderId);

        vm.expectRevert(IPositionExiterHook.OrderNotActive.selector);
        hook.cancelOrder(orderId);
        vm.stopPrank();
    }

    // ═══════════════════════════════════════════════════════════════════════
    // ORDER EXPIRATION
    // ═══════════════════════════════════════════════════════════════════════

    function test_closeExpiredOrder() public {
        vm.prank(user);
        bytes32 orderId = hook.createOrder(IPositionExiterHook.CreateOrderParams({
            poolKey: poolKey,
            tickLower: 60,
            tickUpper: 120,
            amountIn: 1e18,
            direction: IPositionExiterHook.OrderDirection.SellToken0ForToken1,
            deadline: block.timestamp + 7 days,
            recipient: recipient
        }));

        vm.warp(block.timestamp + 8 days);

        IPositionExiterHook.CloseResult memory result = hook.closeExpiredOrder(orderId);

        IPositionExiterHook.ExitOrder memory order = hook.getOrder(orderId);
        assertEq(uint8(order.status), uint8(IPositionExiterHook.OrderStatus.Expired));
        assertEq(uint8(result.finalStatus), uint8(IPositionExiterHook.OrderStatus.Expired));
        assertTrue(
            result.token0Out > 0 || result.token1Out > 0,
            "Should return tokens"
        );
    }

    function test_closeExpiredOrder_sendsToRecipient() public {
        vm.prank(user);
        bytes32 orderId = hook.createOrder(IPositionExiterHook.CreateOrderParams({
            poolKey: poolKey,
            tickLower: 60,
            tickUpper: 120,
            amountIn: 1e18,
            direction: IPositionExiterHook.OrderDirection.SellToken0ForToken1,
            deadline: block.timestamp + 7 days,
            recipient: recipient
        }));

        uint256 recipientBal0Before = token0.balanceOf(recipient);
        uint256 recipientBal1Before = token1.balanceOf(recipient);

        vm.warp(block.timestamp + 8 days);
        hook.closeExpiredOrder(orderId);

        uint256 recipientBal0After = token0.balanceOf(recipient);
        uint256 recipientBal1After = token1.balanceOf(recipient);

        assertTrue(
            recipientBal0After > recipientBal0Before || recipientBal1After > recipientBal1Before,
            "Recipient should receive tokens on expiry"
        );
    }

    function test_closeExpiredOrder_reverts_notExpired() public {
        vm.prank(user);
        bytes32 orderId = hook.createOrder(IPositionExiterHook.CreateOrderParams({
            poolKey: poolKey,
            tickLower: 60,
            tickUpper: 120,
            amountIn: 1e18,
            direction: IPositionExiterHook.OrderDirection.SellToken0ForToken1,
            deadline: block.timestamp + 7 days,
            recipient: recipient
        }));

        vm.expectRevert(IPositionExiterHook.OrderNotExpired.selector);
        hook.closeExpiredOrder(orderId);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // afterSwap HOOK - TICK TRACKING
    // ═══════════════════════════════════════════════════════════════════════

    function test_afterSwap_updatesTick() public {
        int24 initialTick = hook.lastTicks(poolId);
        assertEq(initialTick, 0);

        // Swap token0 -> token1 (zeroForOne) moves tick down
        swap(poolKey, true, -1e18, ZERO_BYTES);

        int24 newTick = hook.lastTicks(poolId);
        assertTrue(newTick < initialTick, "Tick should decrease after zeroForOne swap");
    }

    function test_afterSwap_updatesTickBothDirections() public {
        // Swap down
        swap(poolKey, true, -1e16, ZERO_BYTES);
        int24 tickAfterDown = hook.lastTicks(poolId);
        assertTrue(tickAfterDown < 0);

        // Swap back up
        swap(poolKey, false, -1e16, ZERO_BYTES);
        int24 tickAfterUp = hook.lastTicks(poolId);
        assertTrue(tickAfterUp > tickAfterDown);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // canClose VIEW FUNCTION
    // ═══════════════════════════════════════════════════════════════════════

    function test_canClose_activeOrder() public {
        vm.prank(user);
        bytes32 orderId = hook.createOrder(IPositionExiterHook.CreateOrderParams({
            poolKey: poolKey,
            tickLower: 60,
            tickUpper: 120,
            amountIn: 1e18,
            direction: IPositionExiterHook.OrderDirection.SellToken0ForToken1,
            deadline: block.timestamp + 7 days,
            recipient: recipient
        }));

        (bool closeable, string memory reason) = hook.canClose(orderId);
        assertFalse(closeable);
        assertEq(reason, "Order still active");
    }

    function test_canClose_expiredOrder() public {
        vm.prank(user);
        bytes32 orderId = hook.createOrder(IPositionExiterHook.CreateOrderParams({
            poolKey: poolKey,
            tickLower: 60,
            tickUpper: 120,
            amountIn: 1e18,
            direction: IPositionExiterHook.OrderDirection.SellToken0ForToken1,
            deadline: block.timestamp + 7 days,
            recipient: recipient
        }));

        vm.warp(block.timestamp + 8 days);
        (bool closeable, string memory reason) = hook.canClose(orderId);
        assertTrue(closeable);
        assertEq(reason, "Order expired");
    }

    function test_canClose_notFound() public view {
        (bool closeable, string memory reason) = hook.canClose(bytes32(uint256(999)));
        assertFalse(closeable);
        assertEq(reason, "Order not found");
    }

    function test_canClose_cancelledOrder() public {
        vm.startPrank(user);
        bytes32 orderId = hook.createOrder(IPositionExiterHook.CreateOrderParams({
            poolKey: poolKey,
            tickLower: 60,
            tickUpper: 120,
            amountIn: 1e18,
            direction: IPositionExiterHook.OrderDirection.SellToken0ForToken1,
            deadline: block.timestamp + 7 days,
            recipient: recipient
        }));
        hook.cancelOrder(orderId);
        vm.stopPrank();

        (bool closeable, string memory reason) = hook.canClose(orderId);
        assertFalse(closeable);
        assertEq(reason, "Order not active");
    }

    // ═══════════════════════════════════════════════════════════════════════
    // FILL STATUS
    // ═══════════════════════════════════════════════════════════════════════

    function test_getOrderFillStatus_initial() public {
        vm.prank(user);
        bytes32 orderId = hook.createOrder(IPositionExiterHook.CreateOrderParams({
            poolKey: poolKey,
            tickLower: 60,
            tickUpper: 120,
            amountIn: 1e18,
            direction: IPositionExiterHook.OrderDirection.SellToken0ForToken1,
            deadline: block.timestamp + 7 days,
            recipient: recipient
        }));

        (uint8 fillPercent,,) = hook.getOrderFillStatus(orderId);
        assertEq(fillPercent, 0);
    }

    function test_getOrderFillStatus_reverts_notFound() public {
        vm.expectRevert(IPositionExiterHook.OrderNotFound.selector);
        hook.getOrderFillStatus(bytes32(uint256(999)));
    }

    // ═══════════════════════════════════════════════════════════════════════
    // ORDER COUNT
    // ═══════════════════════════════════════════════════════════════════════

    function test_orderCount() public {
        assertEq(hook.orderCount(), 0);

        vm.startPrank(user);
        hook.createOrder(IPositionExiterHook.CreateOrderParams({
            poolKey: poolKey,
            tickLower: 60,
            tickUpper: 120,
            amountIn: 0.5e18,
            direction: IPositionExiterHook.OrderDirection.SellToken0ForToken1,
            deadline: block.timestamp + 7 days,
            recipient: recipient
        }));
        assertEq(hook.orderCount(), 1);

        hook.createOrder(IPositionExiterHook.CreateOrderParams({
            poolKey: poolKey,
            tickLower: 120,
            tickUpper: 180,
            amountIn: 0.5e18,
            direction: IPositionExiterHook.OrderDirection.SellToken0ForToken1,
            deadline: block.timestamp + 7 days,
            recipient: recipient
        }));
        assertEq(hook.orderCount(), 2);
        vm.stopPrank();
    }

    // ═══════════════════════════════════════════════════════════════════════
    // FUZZ TESTS
    // ═══════════════════════════════════════════════════════════════════════

    function testFuzz_createOrder_variableAmounts(uint256 amount) public {
        vm.assume(amount > 0 && amount <= 10e18);

        vm.prank(user);
        bytes32 orderId = hook.createOrder(IPositionExiterHook.CreateOrderParams({
            poolKey: poolKey,
            tickLower: 60,
            tickUpper: 120,
            amountIn: amount,
            direction: IPositionExiterHook.OrderDirection.SellToken0ForToken1,
            deadline: block.timestamp + 7 days,
            recipient: recipient
        }));

        IPositionExiterHook.ExitOrder memory order = hook.getOrder(orderId);
        assertEq(order.token0Deposited, amount);
        assertTrue(order.liquidity > 0);
    }

    function testFuzz_createOrder_variableDeadlines(uint256 duration) public {
        vm.assume(duration > 0 && duration <= 30 days);

        vm.prank(user);
        bytes32 orderId = hook.createOrder(IPositionExiterHook.CreateOrderParams({
            poolKey: poolKey,
            tickLower: 60,
            tickUpper: 120,
            amountIn: 1e18,
            direction: IPositionExiterHook.OrderDirection.SellToken0ForToken1,
            deadline: block.timestamp + duration,
            recipient: recipient
        }));

        IPositionExiterHook.ExitOrder memory order = hook.getOrder(orderId);
        assertEq(order.deadline, block.timestamp + duration);
    }
}
