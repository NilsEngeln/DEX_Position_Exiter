// Contract addresses — reads from Vite env vars (set in frontend/.env)
// After deploying with DeploySepolia.s.sol, fill in the addresses in frontend/.env

export const ADDRESSES = {
  poolManager: (import.meta.env.VITE_POOL_MANAGER_ADDRESS || "0xE03A1074c86CFeDd5C142C4F04F1a1536e203543") as `0x${string}`,
  hook: (import.meta.env.VITE_HOOK_ADDRESS || "") as `0x${string}`,
  token0: (import.meta.env.VITE_TOKEN0_ADDRESS || "") as `0x${string}`,
  token1: (import.meta.env.VITE_TOKEN1_ADDRESS || "") as `0x${string}`,
  swapRouter: (import.meta.env.VITE_SWAP_ROUTER_ADDRESS || "0x9b6b46e2c869aa39918db7f52f5557fe577b6eee") as `0x${string}`,
  modifyLiquidityRouter: (import.meta.env.VITE_MODIFY_LIQUIDITY_ROUTER_ADDRESS || "0x0c478023803a644c94c4ce1c1e7b9a087e411b0a") as `0x${string}`,
} as const;

// Pool configuration matching deployment scripts
export const POOL_CONFIG = {
  fee: 3000,
  tickSpacing: 60,
  sqrtPriceX96_1_1: BigInt("79228162514264337593543950336"),
} as const;
