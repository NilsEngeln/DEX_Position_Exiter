// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {MockERC20} from "../src/test/MockERC20.sol";

/// @title DeployMockTokens
/// @notice Script to deploy mock tokens for testing on Sepolia
contract DeployMockTokens is Script {
    function run() external {
        uint256 deployerPrivateKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerPrivateKey);

        console.log("Deploying mock tokens...");
        console.log("Deployer:", deployer);

        vm.startBroadcast(deployerPrivateKey);

        // Deploy mock WETH (18 decimals)
        MockERC20 mockWETH = new MockERC20("Mock Wrapped Ether", "mWETH", 18);
        console.log("Mock WETH deployed at:", address(mockWETH));

        // Deploy mock USDC (6 decimals)
        MockERC20 mockUSDC = new MockERC20("Mock USD Coin", "mUSDC", 6);
        console.log("Mock USDC deployed at:", address(mockUSDC));

        // Deploy mock token for testing (CoinX)
        MockERC20 mockCoinX = new MockERC20("Mock CoinX", "mCOINX", 18);
        console.log("Mock CoinX deployed at:", address(mockCoinX));

        // Mint initial supply to deployer for testing
        uint256 wethAmount = 1000 ether;
        uint256 usdcAmount = 1_000_000 * 1e6; // 1M USDC
        uint256 coinxAmount = 10_000_000 ether; // 10M CoinX

        mockWETH.mint(deployer, wethAmount);
        mockUSDC.mint(deployer, usdcAmount);
        mockCoinX.mint(deployer, coinxAmount);

        console.log("Minted tokens to deployer");

        vm.stopBroadcast();

        // Output for easy copy-paste
        console.log("\n=== Deployed Addresses ===");
        console.log("MOCK_WETH=%s", address(mockWETH));
        console.log("MOCK_USDC=%s", address(mockUSDC));
        console.log("MOCK_COINX=%s", address(mockCoinX));
    }
}
