// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {PoolManager} from "@uniswap/v4-core/src/PoolManager.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency, CurrencyLibrary} from "@uniswap/v4-core/src/types/Currency.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {ModifyLiquidityParams, SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {PoolModifyLiquidityTest} from "@uniswap/v4-core/src/test/PoolModifyLiquidityTest.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";

import {PositionExiterHook} from "../src/PositionExiterHook.sol";

/// @title DeployAnvil
/// @notice Deploys the full stack to a local Anvil instance for POC testing
/// @dev Run: anvil && forge script script/DeployAnvil.s.sol --rpc-url http://127.0.0.1:8545 --broadcast --use /usr/local/bin/solc
contract DeployAnvil is Script {
    // Anvil's default deployer account #0
    uint256 constant DEPLOYER_KEY = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;
    address constant DEPLOYER = 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266;
    address constant FEE_RECIPIENT = 0x70997970C51812dc3A010C7d01b50e0d17dc79C8;
    address constant TEST_USER = 0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC;

    // Standard deterministic CREATE2 deployer (exists on Anvil by default)
    address constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;

    uint24 constant POOL_FEE = 3000;
    int24 constant TICK_SPACING = 60;
    uint160 constant SQRT_PRICE_1_1 = 79228162514264337593543950336;
    uint160 constant FLAG_MASK = uint160(0x3FFF);

    // State variables to avoid stack-too-deep
    PoolManager public manager;
    PoolSwapTest public swapRouter;
    PoolModifyLiquidityTest public modifyLiquidityRouter;
    MockERC20 public token0;
    MockERC20 public token1;
    address public hookAddress;

    function run() external {
        vm.startBroadcast(DEPLOYER_KEY);

        _deployCore();
        _deployTokens();
        _deployHook();
        _setupPool();
        _mintToTestUser();

        vm.stopBroadcast();

        _printSummary();
    }

    function _deployCore() internal {
        manager = new PoolManager(DEPLOYER);
        console.log("PoolManager:", address(manager));

        swapRouter = new PoolSwapTest(IPoolManager(address(manager)));
        modifyLiquidityRouter = new PoolModifyLiquidityTest(IPoolManager(address(manager)));
        console.log("SwapRouter:", address(swapRouter));
        console.log("ModifyLiquidityRouter:", address(modifyLiquidityRouter));
    }

    function _deployTokens() internal {
        MockERC20 tokenA = new MockERC20("Wrapped Ether", "WETH", 18);
        MockERC20 tokenB = new MockERC20("USD Coin", "USDC", 6);

        if (address(tokenA) < address(tokenB)) {
            token0 = tokenA;
            token1 = tokenB;
        } else {
            token0 = tokenB;
            token1 = tokenA;
        }
        console.log("Token0:", address(token0));
        console.log("Token1:", address(token1));
    }

    function _deployHook() internal {
        uint160 flags = uint160(Hooks.AFTER_INITIALIZE_FLAG | Hooks.AFTER_SWAP_FLAG);
        bytes memory creationCode = abi.encodePacked(
            type(PositionExiterHook).creationCode,
            abi.encode(IPoolManager(address(manager)), FEE_RECIPIENT)
        );

        bytes32 codeHash = keccak256(creationCode);
        bytes32 salt;
        address computed;
        for (uint256 i = 0; i < 200_000; i++) {
            salt = bytes32(i);
            computed = address(uint160(uint256(keccak256(
                abi.encodePacked(bytes1(0xFF), CREATE2_DEPLOYER, salt, codeHash)
            ))));
            if (uint160(computed) & FLAG_MASK == flags) {
                break;
            }
        }
        hookAddress = computed;
        console.log("Hook target address:", hookAddress);
        console.log("Salt:", uint256(salt));

        // Deploy via standard CREATE2 deployer (send salt ++ creationCode)
        (bool success,) = CREATE2_DEPLOYER.call(abi.encodePacked(salt, creationCode));
        require(success, "CREATE2 deployment failed");
        require(hookAddress.code.length > 0, "Hook not deployed");
        console.log("PositionExiterHook deployed at:", hookAddress);
    }

    function _setupPool() internal {
        // Mint tokens to deployer
        uint256 mintAmount = 1_000_000e18;
        token0.mint(DEPLOYER, mintAmount);
        token1.mint(DEPLOYER, mintAmount);

        // Approve routers
        token0.approve(address(modifyLiquidityRouter), type(uint256).max);
        token1.approve(address(modifyLiquidityRouter), type(uint256).max);
        token0.approve(address(swapRouter), type(uint256).max);
        token1.approve(address(swapRouter), type(uint256).max);

        // Initialize pool
        PoolKey memory poolKey = PoolKey({
            currency0: Currency.wrap(address(token0)),
            currency1: Currency.wrap(address(token1)),
            fee: POOL_FEE,
            tickSpacing: TICK_SPACING,
            hooks: IHooks(hookAddress)
        });
        manager.initialize(poolKey, SQRT_PRICE_1_1);
        console.log("Pool initialized at 1:1 price");

        // Seed pool with liquidity
        modifyLiquidityRouter.modifyLiquidity(
            poolKey,
            ModifyLiquidityParams({
                tickLower: -600,
                tickUpper: 600,
                liquidityDelta: 1000e18,
                salt: bytes32(0)
            }),
            ""
        );
        console.log("Pool seeded with liquidity");
    }

    function _mintToTestUser() internal {
        token0.mint(TEST_USER, 100e18);
        token1.mint(TEST_USER, 100e18);
        console.log("Minted tokens to test user:", TEST_USER);
    }

    function _printSummary() internal view {
        console.log("");
        console.log("=== DEPLOYMENT SUMMARY ===");
        console.log("POOL_MANAGER_ADDRESS=", address(manager));
        console.log("HOOK_ADDRESS=", hookAddress);
        console.log("TOKEN0_ADDRESS=", address(token0));
        console.log("TOKEN1_ADDRESS=", address(token1));
        console.log("SWAP_ROUTER_ADDRESS=", address(swapRouter));
        console.log("MODIFY_LIQUIDITY_ROUTER_ADDRESS=", address(modifyLiquidityRouter));
    }
}
