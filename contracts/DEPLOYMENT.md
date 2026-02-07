# Deployment Guide

## Prerequisites

1. **Foundry** - Install with:
   ```bash
   curl -L https://foundry.paradigm.xyz | bash
   foundryup
   ```

2. **Sepolia ETH** - Get from a faucet if needed

3. **Private Key** - Export your wallet's private key (use a dev wallet!)

## Step 1: Install Dependencies

```bash
cd contracts

# Install Uniswap V4 and OpenZeppelin
# Note: Use --no-git flag (not --no-commit) in newer Foundry versions
forge install uniswap/v4-core --no-git
forge install uniswap/v4-periphery --no-git
forge install openzeppelin/openzeppelin-contracts --no-git
forge install OpenZeppelin/uniswap-hooks --no-git
forge install foundry-rs/forge-std --no-git

# If the above still fails, try without any flags:
# forge install uniswap/v4-core
# forge install uniswap/v4-periphery
# forge install openzeppelin/openzeppelin-contracts
# forge install foundry-rs/forge-std
```

## Step 2: Set Environment Variables

Create a `.env` file in the `contracts` directory:

```bash
# Your wallet's private key (WITHOUT 0x prefix)
DEPLOYER_PRIVATE_KEY=your_private_key_here

# Your address to receive fees
FEE_RECIPIENT=0xYourAddressHere

# Sepolia RPC URL (get from Alchemy, Infura, or use public)
SEPOLIA_RPC_URL=https://eth-sepolia.g.alchemy.com/v2/YOUR_KEY

# Optional: Override PoolManager address if needed
# POOL_MANAGER=0x...
```

## Step 3: Find the PoolManager Address

Check the official Uniswap V4 deployments:
- **Docs**: https://docs.uniswap.org/contracts/v4/deployments
- **Etherscan**: Search "Uniswap V4 Pool Manager" on Sepolia

Known addresses:
- **Mainnet**: `0x000000000004444c5dc75cB358380D2e3dE08A90`
- **Base**: `0x498581fF718922c3f8e6A244956aF099B2652b2b`

## Step 4: Build Contracts

```bash
cd contracts
forge build
```

## Step 5: Deploy Mock Tokens (Optional)

If you need test tokens:

```bash
source .env
forge script script/DeployMockTokens.s.sol:DeployMockTokens \
  --rpc-url $SEPOLIA_RPC_URL \
  --broadcast \
  --verify
```

## Step 6: Deploy the Hook

```bash
source .env
forge script script/DeployHook.s.sol:DeployHook \
  --rpc-url $SEPOLIA_RPC_URL \
  --broadcast \
  --verify
```

## Step 7: Update API Configuration

After deployment, update `api/.env`:

```bash
HOOK_ADDRESS=0x_deployed_hook_address
POOL_MANAGER_ADDRESS=0x_pool_manager_address
```

## Troubleshooting

### "Hook address doesn't have correct flags"

Uniswap V4 hooks must be deployed to addresses with specific bits set. For a production deployment, you need to:

1. Use CREATE2 with a salt that produces a valid address
2. The last 14 bits of the address must match the hook's permissions

For testing, you can deploy directly, but the hook won't work with the PoolManager until it has the correct address.

### "Contract verification failed"

Make sure you have your Etherscan API key set:
```bash
export ETHERSCAN_API_KEY=your_key
```

## Alternative: Local Testing with Anvil

For local testing without spending real ETH:

```bash
# Start local fork of Sepolia
anvil --fork-url $SEPOLIA_RPC_URL

# In another terminal, deploy to local fork
forge script script/DeployHook.s.sol:DeployHook \
  --rpc-url http://localhost:8545 \
  --broadcast
```
