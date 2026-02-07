import {
  createPublicClient,
  createWalletClient,
  http,
  getContract,
  encodeAbiParameters,
  keccak256,
  type PublicClient,
  type WalletClient,
  type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";

import { PositionExiterHookABI } from "../abi/PositionExiterHook.js";
import { ERC20ABI } from "../abi/ERC20.js";
import { ADDRESSES, POOL_CONFIG } from "../abi/addresses.js";
import { logger } from "../utils/logger.js";

// ═══════════════════════════════════════════════════════════════════════════
// CLIENTS
// ═══════════════════════════════════════════════════════════════════════════

let _publicClient: PublicClient | null = null;
let _walletClient: WalletClient | null = null;

export function getPublicClient(): PublicClient {
  if (!_publicClient) {
    const rpcUrl = process.env.SEPOLIA_RPC_URL;
    if (!rpcUrl) {
      throw new Error("SEPOLIA_RPC_URL not set in environment");
    }
    _publicClient = createPublicClient({
      chain: sepolia,
      transport: http(rpcUrl),
    });
    logger.info("Public client initialized", { chain: "sepolia" });
  }
  return _publicClient;
}

export function getWalletClient(): WalletClient {
  if (!_walletClient) {
    const privateKey = process.env.DEPLOYER_PRIVATE_KEY as `0x${string}`;
    if (!privateKey) {
      throw new Error("DEPLOYER_PRIVATE_KEY not set in environment");
    }
    const rpcUrl = process.env.SEPOLIA_RPC_URL;
    if (!rpcUrl) {
      throw new Error("SEPOLIA_RPC_URL not set in environment");
    }
    const account = privateKeyToAccount(privateKey);
    _walletClient = createWalletClient({
      account,
      chain: sepolia,
      transport: http(rpcUrl),
    });
    logger.info("Wallet client initialized", { address: account.address, chain: "sepolia" });
  }
  return _walletClient;
}

export function getDeployerAddress(): Address {
  const privateKey = process.env.DEPLOYER_PRIVATE_KEY as `0x${string}`;
  return privateKeyToAccount(privateKey).address;
}

// ═══════════════════════════════════════════════════════════════════════════
// CONTRACT INSTANCES
// ═══════════════════════════════════════════════════════════════════════════

export function getHookContract() {
  return getContract({
    address: ADDRESSES.hook,
    abi: PositionExiterHookABI,
    client: {
      public: getPublicClient(),
      wallet: getWalletClient(),
    },
  });
}

export function getTokenContract(tokenAddress: Address) {
  return getContract({
    address: tokenAddress,
    abi: ERC20ABI,
    client: {
      public: getPublicClient(),
      wallet: getWalletClient(),
    },
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// POOL HELPERS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Compute the Uniswap V4 PoolId from a PoolKey.
 * PoolId = keccak256(abi.encode(currency0, currency1, fee, tickSpacing, hooks))
 */
export function computePoolId(
  currency0: Address,
  currency1: Address,
  fee: number,
  tickSpacing: number,
  hooks: Address
): `0x${string}` {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "address" },
        { type: "address" },
        { type: "uint24" },
        { type: "int24" },
        { type: "address" },
      ],
      [currency0, currency1, fee, tickSpacing, hooks]
    )
  );
}

/**
 * Get the PoolId for our deployed pool
 */
export function getDeployedPoolId(): `0x${string}` {
  return computePoolId(
    ADDRESSES.token0,
    ADDRESSES.token1,
    POOL_CONFIG.fee,
    POOL_CONFIG.tickSpacing,
    ADDRESSES.hook
  );
}

/**
 * Build the PoolKey struct matching the deployed pool
 */
export function getDeployedPoolKey() {
  return {
    currency0: ADDRESSES.token0 as Address,
    currency1: ADDRESSES.token1 as Address,
    fee: POOL_CONFIG.fee,
    tickSpacing: POOL_CONFIG.tickSpacing,
    hooks: ADDRESSES.hook as Address,
  };
}

/**
 * Ensure the deployer wallet has approved the hook to spend tokens.
 * Called once on startup or before first order creation.
 */
export async function ensureTokenApprovals(): Promise<void> {
  const wallet = getWalletClient();
  const deployer = getDeployerAddress();
  const hookAddr = ADDRESSES.hook;

  for (const tokenAddr of [ADDRESSES.token0, ADDRESSES.token1]) {
    const token = getTokenContract(tokenAddr as Address);
    const allowance = await token.read.allowance([deployer, hookAddr]);

    if (allowance < BigInt("1000000000000000000000000")) {
      logger.info("Approving hook for token", { token: tokenAddr });
      const hash = await token.write.approve([
        hookAddr,
        BigInt("0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"),
      ]);
      logger.info("Approval tx sent", { hash, token: tokenAddr });
    }
  }
}

/**
 * Check if the RPC is reachable and contracts are deployed
 */
export async function checkContractHealth(): Promise<{
  rpc: boolean;
  hookDeployed: boolean;
  poolInitialized: boolean;
}> {
  try {
    const client = getPublicClient();
    const hookCode = await client.getCode({ address: ADDRESSES.hook as Address });
    const hookDeployed = !!hookCode && hookCode !== "0x";

    let poolInitialized = false;
    if (hookDeployed) {
      const hook = getHookContract();
      const poolId = getDeployedPoolId();
      const lastTick = await hook.read.lastTicks([poolId]);
      poolInitialized = lastTick !== undefined;
    }

    return { rpc: true, hookDeployed, poolInitialized };
  } catch {
    return { rpc: false, hookDeployed: false, poolInitialized: false };
  }
}
