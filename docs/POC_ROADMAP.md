# POC Roadmap - Working Frontend Demo

## Current State: INTEGRATION COMPLETE

All phases through Phase 4 are implemented. The full stack is wired end-to-end:
- Contracts deployed to local Anvil
- API reads/writes to real on-chain contracts
- Frontend updated for Anvil with improved UX

### Layer Status

| Layer | Status | What Works |
|-------|--------|-----------|
| **Smart Contracts** | DEPLOYED | 748-line hook, 32 integration tests, deployed to Anvil via CREATE2 |
| **API Server** | WIRED | Express + real contract calls via viem + x402 dev mode |
| **Frontend** | UPDATED | Anvil chain, token balances, cancel buttons, auto-refresh |

---

## Completed Phases

### Phase 1: Make It Run
- [x] **1.1** Install npm dependencies for `api/` and `frontend/`
- [x] **1.2** Create `api/.env` with dev defaults (Anvil RPC, contract addresses)
- [x] **1.3** Verify both servers start (API on :3000, frontend on :5173)

### Phase 2: Contract Deployment (Local Anvil)
- [x] **2.1** `DeployAnvil.s.sol` — deploys PoolManager, tokens, hook (via CREATE2), initializes pool, seeds liquidity
- [x] **2.2** Exported ABIs to `api/src/abi/` and `frontend/src/abi/` (PositionExiterHook + ERC20 + addresses)
- [x] **2.3** Pool initialized at 1:1 price with 1000e18 liquidity, test user funded

### Phase 3: Wire API to Contracts
- [x] **3.1** Created `contractClient.ts` — viem public + wallet clients, hook/token contract instances, pool helpers
- [x] **3.2** `orderService.createOrder()` calls real `PositionExiterHook.createOrder()` on Anvil
- [x] **3.3** `getOrderStatus()` reads fill % from `hook.getOrderFillStatus()` on-chain
- [x] **3.4** `cancelOrder()` calls real `hook.cancelOrder()` on-chain
- [x] **3.5** `tickCalculator.getPoolState()` reads current tick from `hook.lastTicks(poolId)`
- [x] **3.6** Backend wallet (Anvil deployer key) approves tokens and signs all transactions

### Phase 4: Frontend Improvements
- [x] **4.1** Switched to Anvil chain (31337) with deployed token addresses
- [x] **4.2** Shows real token balances (ETH, WETH, USDC)
- [x] **4.3** Human-readable amounts in estimate/order display
- [x] **4.4** Auto-refresh orders + balances every 10 seconds
- [x] **4.5** Cancel button on active orders (calls API → chain)
- [x] **4.6** Token symbol display from deployed contract info

---

## Remaining Work (Future)

### Phase 5: Production Readiness
- [ ] **5.1** Token approval flow in frontend (user approves → hook transfers)
- [ ] **5.2** Deploy to Sepolia testnet
- [ ] **5.3** Real x402 payment integration (not mock)
- [ ] **5.4** Persistent database (PostgreSQL) instead of in-memory
- [ ] **5.5** Security audit
- [ ] **5.6** Deploy to Base mainnet

---

## Deployed Addresses (Anvil)

| Contract | Address |
|----------|---------|
| PoolManager | `0x5FbDB2315678afecb367f032d93F642f64180aa3` |
| PositionExiterHook | `0xF5490D81a7916dF196264C90cF221FD9e9A45040` |
| Token0 (WETH) | `0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9` |
| Token1 (USDC) | `0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9` |
| SwapRouter | `0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512` |
| ModifyLiquidityRouter | `0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0` |

## Running the POC

```bash
# Terminal 1: Start Anvil
anvil --host 127.0.0.1 --port 8545

# Terminal 2: Deploy contracts
cd contracts
forge script script/DeployAnvil.s.sol --rpc-url http://127.0.0.1:8545 --broadcast --use /usr/local/bin/solc

# Terminal 3: Start API
cd api && npm run dev

# Terminal 4: Start Frontend
cd frontend && npm run dev

# Open http://localhost:5173 in browser
# Connect MetaMask to Anvil (chain ID 31337, RPC http://127.0.0.1:8545)
```
