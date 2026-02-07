// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {PoolModifyLiquidityTest} from "@uniswap/v4-core/src/test/PoolModifyLiquidityTest.sol";

import {PositionExiterHook} from "../src/PositionExiterHook.sol";
import {MockERC20} from "../src/test/MockERC20.sol";

/// @title DeploySepolia
/// @notice Deploys the full stack to Sepolia using the existing Uniswap V4 deployment
/// @dev Usage:
///   1. Set env vars: DEPLOYER_PRIVATE_KEY, SEPOLIA_RPC_URL, FEE_RECIPIENT
///   2. Run: forge script script/DeploySepolia.s.sol:DeploySepolia \
///           --rpc-url $SEPOLIA_RPC_URL --broadcast --verify
contract DeploySepolia is Script {
    // ═══════════════════════════════════════════════════════════════════════
    // Official Uniswap V4 Sepolia Addresses
    // Source: https://docs.uniswap.org/contracts/v4/deployments
    // ═══════════════════════════════════════════════════════════════════════
    address constant POOL_MANAGER_SEPOLIA = 0xE03A1074c86CFeDd5C142C4F04F1a1536e203543;
    address constant MODIFY_LIQUIDITY_ROUTER_SEPOLIA = 0x0C478023803a644c94c4CE1C1e7b9A087e411B0A;
    address constant SWAP_ROUTER_SEPOLIA = 0x9B6b46e2c869aa39918Db7f52f5557FE577B6eEe;

    // Standard deterministic CREATE2 deployer (deployed on all chains)
    address constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;

    uint24 constant POOL_FEE = 3000;
    int24 constant TICK_SPACING = 60;
    uint160 constant SQRT_PRICE_1_1 = 79228162514264337593543950336;
    uint160 constant FLAG_MASK = uint160(0x3FFF);

    // State variables to avoid stack-too-deep
    MockERC20 public token0;
    MockERC20 public token1;
    address public hookAddress;

    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);
        address feeRecipient = vm.envOr("FEE_RECIPIENT", deployer);

        console.log("=== DeploySepolia ===");
        console.log("Deployer:", deployer);
        console.log("Fee Recipient:", feeRecipient);
        console.log("PoolManager:", POOL_MANAGER_SEPOLIA);

        vm.startBroadcast(deployerKey);

        _deployTokens(deployer);
        _deployHook(feeRecipient);
        _setupPool(deployer);

        vm.stopBroadcast();

        _printSummary();
    }

    function _deployTokens(address deployer) internal {
        MockERC20 tokenA = new MockERC20("Mock Wrapped Ether", "mWETH", 18);
        MockERC20 tokenB = new MockERC20("Mock USD Coin", "mUSDC", 6);

        // Ensure token0 < token1 (required by Uniswap V4)
        if (address(tokenA) < address(tokenB)) {
            token0 = tokenA;
            token1 = tokenB;
        } else {
            token0 = tokenB;
            token1 = tokenA;
        }

        console.log("Token0 (%s):", token0.symbol(), address(token0));
        console.log("Token1 (%s):", token1.symbol(), address(token1));

        // Mint tokens to deployer
        uint256 amount0 = 1_000e18; // 1000 tokens (18 decimals)
        uint256 amount1 = (token1.decimals() == 6) ? 1_000_000e6 : 1_000e18;
        token0.mint(deployer, amount0);
        token1.mint(deployer, amount1);
        console.log("Minted tokens to deployer");
    }

    function _deployHook(address feeRecipient) internal {
        uint160 flags = uint160(Hooks.AFTER_INITIALIZE_FLAG | Hooks.AFTER_SWAP_FLAG);
        bytes memory creationCode = abi.encodePacked(
            type(PositionExiterHook).creationCode,
            abi.encode(IPoolManager(POOL_MANAGER_SEPOLIA), feeRecipient)
        );

        bytes32 codeHash = keccak256(creationCode);
        bytes32 salt;
        address computed;
        bool found = false;

        for (uint256 i = 0; i < 500_000; i++) {
            salt = bytes32(i);
            computed = address(uint160(uint256(keccak256(
                abi.encodePacked(bytes1(0xFF), CREATE2_DEPLOYER, salt, codeHash)
            ))));
            if (uint160(computed) & FLAG_MASK == flags) {
                found = true;
                break;
            }
        }
        require(found, "Could not find valid salt in 500k iterations");

        hookAddress = computed;
        console.log("Hook target address:", hookAddress);
        console.log("Salt:", uint256(salt));

        // Deploy via standard CREATE2 deployer
        (bool success,) = CREATE2_DEPLOYER.call(abi.encodePacked(salt, creationCode));
        require(success, "CREATE2 deployment failed");
        require(hookAddress.code.length > 0, "Hook not deployed at expected address");
        console.log("PositionExiterHook deployed at:", hookAddress);
    }

    function _setupPool(address deployer) internal {
        IPoolManager poolManager = IPoolManager(POOL_MANAGER_SEPOLIA);
        PoolModifyLiquidityTest modifyRouter = PoolModifyLiquidityTest(MODIFY_LIQUIDITY_ROUTER_SEPOLIA);

        // Approve tokens for the modify liquidity router
        token0.approve(address(modifyRouter), type(uint256).max);
        token1.approve(address(modifyRouter), type(uint256).max);

        // Also approve for the hook (needed for creating orders later)
        token0.approve(hookAddress, type(uint256).max);
        token1.approve(hookAddress, type(uint256).max);

        // Initialize pool
        PoolKey memory poolKey = PoolKey({
            currency0: Currency.wrap(address(token0)),
            currency1: Currency.wrap(address(token1)),
            fee: POOL_FEE,
            tickSpacing: TICK_SPACING,
            hooks: IHooks(hookAddress)
        });
        poolManager.initialize(poolKey, SQRT_PRICE_1_1);
        console.log("Pool initialized at 1:1 price");

        // Seed pool with initial liquidity
        modifyRouter.modifyLiquidity(
            poolKey,
            ModifyLiquidityParams({
                tickLower: -600,
                tickUpper: 600,
                liquidityDelta: 100e18,
                salt: bytes32(0)
            }),
            ""
        );
        console.log("Pool seeded with initial liquidity");
    }

    function _printSummary() internal view {
        console.log("");
        console.log("=== DEPLOYMENT SUMMARY (Sepolia) ===");
        console.log("POOL_MANAGER_ADDRESS=%s", POOL_MANAGER_SEPOLIA);
        console.log("HOOK_ADDRESS=%s", hookAddress);
        console.log("TOKEN0_ADDRESS=%s", address(token0));
        console.log("TOKEN1_ADDRESS=%s", address(token1));
        console.log("SWAP_ROUTER_ADDRESS=%s", SWAP_ROUTER_SEPOLIA);
        console.log("MODIFY_LIQUIDITY_ROUTER_ADDRESS=%s", MODIFY_LIQUIDITY_ROUTER_SEPOLIA);
        console.log("");
        console.log("Copy the addresses above into your api/.env and frontend/.env files");
    }
}
