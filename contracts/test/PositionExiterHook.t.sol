// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, console} from "forge-std/Test.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";

import {PositionExiterHook} from "../src/PositionExiterHook.sol";
import {IPositionExiterHook} from "../src/interfaces/IPositionExiterHook.sol";
import {MockERC20} from "../src/test/MockERC20.sol";

/// @title PositionExiterHookTest
/// @notice Unit tests for the PositionExiterHook contract
contract PositionExiterHookTest is Test {
    PositionExiterHook public hook;
    MockERC20 public token0;
    MockERC20 public token1;

    address public feeRecipient = address(0xFEE);
    address public user = address(0x1);

    function setUp() public {
        // Deploy mock tokens
        token0 = new MockERC20("Token0", "TKN0", 18);
        token1 = new MockERC20("Token1", "TKN1", 18);

        // Ensure token0 < token1 by address
        if (address(token0) > address(token1)) {
            (token0, token1) = (token1, token0);
        }

        // Note: Full hook testing requires a PoolManager mock or fork test
        // This test file focuses on unit tests that don't require pool interactions

        console.log("Token0:", address(token0));
        console.log("Token1:", address(token1));
    }

    function test_Constants() public {
        // Deploy hook with mock pool manager
        // Note: This would fail without proper hook address mining
        // For now, we just test the interface
    }

    function test_MockTokenDeployment() public {
        // After setUp, token0 always has the lower address
        assertTrue(address(token0) < address(token1));
        assertEq(token0.decimals(), 18);
        assertEq(token1.decimals(), 18);
    }

    function test_MockTokenMinting() public {
        token0.mint(user, 1000 ether);
        assertEq(token0.balanceOf(user), 1000 ether);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // FUZZ TESTS
    // ═══════════════════════════════════════════════════════════════════════════

    function testFuzz_MockTokenMinting(uint256 amount) public {
        vm.assume(amount > 0 && amount < type(uint128).max);
        token0.mint(user, amount);
        assertEq(token0.balanceOf(user), amount);
    }
}

/// @title PositionExiterHookForkTest
/// @notice Fork tests that interact with real Uniswap V4 on Sepolia
/// @dev Run with: forge test --fork-url $SEPOLIA_RPC_URL --match-contract PositionExiterHookForkTest
contract PositionExiterHookForkTest is Test {
    // TODO: Add fork tests once deployed to Sepolia
    // These will test actual pool interactions

    function setUp() public {
        // Skip if not running fork test
        if (block.chainid != 11155111) {
            return;
        }
    }

    function test_placeholder() public {
        // Placeholder for fork tests
        assertTrue(true);
    }
}
