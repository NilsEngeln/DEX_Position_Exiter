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
    address constant POOL_MANAGER_SEPOLIA = address(0); // TODO: Update with actual address
    address constant POOL_MANAGER_BASE = address(0);    // TODO: Update with actual address

    function run() external {
        // Get configuration from environment
        uint256 deployerPrivateKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address poolManager = vm.envOr("POOL_MANAGER", POOL_MANAGER_SEPOLIA);
        address feeRecipient = vm.envAddress("FEE_RECIPIENT");

        console.log("Deploying PositionExiterHook...");
        console.log("PoolManager:", poolManager);
        console.log("Fee Recipient:", feeRecipient);

        // Calculate required hook flags
        // We need: afterInitialize, afterSwap
        uint160 flags = uint160(
            Hooks.AFTER_INITIALIZE_FLAG | Hooks.AFTER_SWAP_FLAG
        );

        console.log("Required flags:", flags);

        vm.startBroadcast(deployerPrivateKey);

        // Mine a salt that produces an address with the correct flags
        // The hook address must have specific bits set based on the hooks it implements
        (address hookAddress, bytes32 salt) = HookMiner.find(
            CREATE2_FACTORY,
            flags,
            type(PositionExiterHook).creationCode,
            abi.encode(IPoolManager(poolManager), feeRecipient)
        );

        console.log("Computed hook address:", hookAddress);
        console.log("Salt:", vm.toString(salt));

        // Deploy using CREATE2
        PositionExiterHook hook = new PositionExiterHook{salt: salt}(
            IPoolManager(poolManager),
            feeRecipient
        );

        console.log("Deployed hook at:", address(hook));
        require(address(hook) == hookAddress, "Hook address mismatch");

        vm.stopBroadcast();
    }

    // Deterministic CREATE2 factory (same on all chains)
    address constant CREATE2_FACTORY = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
}
