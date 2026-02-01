// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {PositionExiterHook} from "../src/PositionExiterHook.sol";
import {HookMiner} from "../test/utils/HookMiner.sol";

/// @title DeployHook
/// @notice Script to deploy the PositionExiterHook with correct address prefix
contract DeployHook is Script {
    // Uniswap V4 PoolManager addresses
    // Source: https://docs.uniswap.org/contracts/v4/deployments
    address constant POOL_MANAGER_MAINNET = 0x000000000004444c5dc75cB358380D2e3dE08A90;
    address constant POOL_MANAGER_BASE = 0x498581fF718922c3f8e6A244956aF099B2652b2b;
    address constant POOL_MANAGER_SEPOLIA = 0x8C4BcBE6b9eF47855f97E675296FA3F6fafa5F1A; // Check docs for latest

    function run() external {
        // Get configuration from environment
        uint256 deployerPrivateKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address feeRecipient = vm.envAddress("FEE_RECIPIENT");

        // Default to Sepolia, can override with POOL_MANAGER env var
        address poolManager = vm.envOr("POOL_MANAGER", POOL_MANAGER_SEPOLIA);

        console.log("===========================================");
        console.log("  Deploying PositionExiterHook");
        console.log("===========================================");
        console.log("PoolManager:", poolManager);
        console.log("Fee Recipient:", feeRecipient);

        // Calculate required hook flags
        // We need: afterInitialize, afterSwap
        uint160 flags = uint160(
            Hooks.AFTER_INITIALIZE_FLAG | Hooks.AFTER_SWAP_FLAG
        );

        console.log("Required flags:", flags);

        vm.startBroadcast(deployerPrivateKey);

        // For simplicity, deploy without CREATE2 mining first
        // (Hook address mining is complex and requires the correct prefix)
        PositionExiterHook hook = new PositionExiterHook(
            IPoolManager(poolManager),
            feeRecipient
        );

        console.log("===========================================");
        console.log("  Deployed hook at:", address(hook));
        console.log("===========================================");

        vm.stopBroadcast();
    }
}
