// Contract addresses deployed on Anvil (chain 31337)
// Updated by DeployAnvil.s.sol script
export const ANVIL_ADDRESSES = {
  poolManager: "0x5FbDB2315678afecb367f032d93F642f64180aa3" as const,
  hook: "0xF5490D81a7916dF196264C90cF221FD9e9A45040" as const,
  token0: "0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9" as const,
  token1: "0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9" as const,
  swapRouter: "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512" as const,
  modifyLiquidityRouter: "0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0" as const,
} as const;

// Pool configuration matching DeployAnvil.s.sol
export const POOL_CONFIG = {
  fee: 3000,
  tickSpacing: 60,
  sqrtPriceX96_1_1: BigInt("79228162514264337593543950336"),
} as const;
