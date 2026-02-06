# POC Roadmap - Working Frontend Demo

## Current State Assessment

### Layer Status

| Layer | Status | What Works | What's Missing |
|-------|--------|-----------|----------------|
| **Smart Contracts** | WORKING | 748-line hook, 32 integration tests pass, all V4 APIs correct | Not deployed to any network yet |
| **API Server** | SCAFFOLDED | Express + routes + x402 middleware + Zod validation | All services return **mock data**, no blockchain interaction |
| **Frontend** | SCAFFOLDED | Wallet connect, order form, status checker, orders list | Depends on API which returns mocks; no direct contract reads |

### Detailed Gap Analysis

#### Contracts (`contracts/`) - 90% Complete
- `PositionExiterHook.sol` — Fully implemented and tested
- `IPositionExiterHook.sol` — Complete interface
- 32 integration tests with real PoolManager
- **Missing**: Deployment to a live network (Sepolia or local Anvil)

#### API (`api/`) - 40% Complete
- Express server with proper middleware (helmet, CORS, logging)
- Route handlers for all 5 endpoints
- x402 middleware works in dev mode (`SKIP_PAYMENT=true`)
- Zod request validation

**Critical gaps** (marked with `// TODO` in the code):
1. **`orderService.ts:82-85`** — `createOrder()` is fully simulated. Does NOT call `PositionExiterHook.createOrder()` on-chain. Returns fake txHash (`0x000...`).
2. **`orderService.ts:123-124`** — `getOrderStatus()` does NOT read fill status from chain. Returns hardcoded `fillPercent: 0`.
3. **`orderService.ts:159-161`** — `cancelOrder()` is simulated. Does NOT call `PositionExiterHook.cancelOrder()`.
4. **`tickCalculator.ts:145-169`** — `getPoolState()` returns hardcoded mock data (tick=0, fake liquidity). Does NOT read from PoolManager.
5. **`tickCalculator.ts:175-191`** — `calculateVolatility()` returns hardcoded 5% daily vol. No historical data fetching.
6. **No contract ABIs** imported — the API has no way to interact with deployed contracts.
7. **In-memory storage** — orders are lost on restart. No database.

#### Frontend (`frontend/`) - 60% Complete
- Full UI with dark theme, responsive grid layout
- MetaMask wallet connection + Sepolia network switching
- Create order form (token addresses, amount, timeframe)
- Order status checker by ID
- Orders list with progress bars and status badges
- API health check display
- x402 payment flow (mock)

**Critical gaps**:
1. **No contract ABI** — frontend can't read order state directly from chain
2. **No token approval flow** — user never approves tokens to the hook
3. **Relies entirely on API** — if API returns mocks, UI shows mock data
4. **No demo/simulation mode** — can't showcase the product without live API + contracts
5. **Raw wei inputs** — amount field expects raw numbers like `1000000000000000000`

---

## POC Strategy

### Recommended Approach: Local Anvil + Wired API

Deploy contracts to a local Anvil fork, wire the API to call real contracts, and connect the frontend. This gives us a true end-to-end demo.

### Prioritized Task List

#### Phase 1: Make It Run (API + Frontend boot up)
- [ ] **1.1** Install npm dependencies for `api/` and `frontend/`
- [ ] **1.2** Create `api/.env` from `.env.example` with dev defaults
- [ ] **1.3** Verify `npm run dev` works for both packages
- [ ] **1.4** Verify frontend loads at localhost:5173 and can hit API health endpoint

#### Phase 2: Contract Deployment (Local Anvil)
- [ ] **2.1** Write a Foundry script to deploy the hook + mock tokens to Anvil
- [ ] **2.2** Export contract ABIs (from `contracts/out/`) to a shared location
- [ ] **2.3** Initialize a pool on Anvil with the deployed hook and seed liquidity
- [ ] **2.4** Document the Anvil startup command and deployed addresses

#### Phase 3: Wire API to Contracts
- [ ] **3.1** Import hook ABI into the API, create a viem contract client
- [ ] **3.2** Replace `orderService.createOrder()` mock with real `PositionExiterHook.createOrder()` call
- [ ] **3.3** Replace `getOrderStatus()` mock with real `getOrder()` + `getOrderFillStatus()` reads
- [ ] **3.4** Replace `cancelOrder()` mock with real contract call
- [ ] **3.5** Replace `tickCalculator.getPoolState()` mock with real `StateLibrary.getSlot0()` read
- [ ] **3.6** Add a backend wallet (from .env private key) for signing transactions

#### Phase 4: Frontend Improvements for POC
- [ ] **4.1** Add token approval step before order creation (ERC20.approve → hook)
- [ ] **4.2** Add human-readable amount input (e.g., "1.0 ETH" instead of wei)
- [ ] **4.3** Show real tx hashes with Etherscan links
- [ ] **4.4** Add auto-refresh for order status (poll every 10s)
- [ ] **4.5** Add cancel button on active orders
- [ ] **4.6** Add token name/symbol display (read from ERC20 contract)

#### Phase 5: Polish & Demo
- [ ] **5.1** Add a "Demo Mode" toggle that simulates full lifecycle without chain
- [ ] **5.2** Add loading states and error messages for all API calls
- [ ] **5.3** Write a step-by-step demo script for showcasing the POC
- [ ] **5.4** Update README with POC running instructions

---

## Architecture for Wired POC

```
┌─────────────────────────────────────────────────────────┐
│                     FRONTEND (Vite)                      │
│  localhost:5173                                          │
│                                                          │
│  ┌──────────┐  ┌──────────┐  ┌────────────────────────┐│
│  │ Wallet   │  │ Order    │  │ Order List + Status    ││
│  │ Connect  │  │ Form     │  │ (polls /api/v1/status) ││
│  └────┬─────┘  └────┬─────┘  └────────────┬───────────┘│
│       │              │                      │            │
│       │   ┌──────────▼──────────┐          │            │
│       │   │  ERC20.approve()    │          │            │
│       │   │  (direct to chain)  │          │            │
│       │   └──────────┬──────────┘          │            │
│       │              │                      │            │
└───────┼──────────────┼──────────────────────┼────────────┘
        │              │ POST /api/v1/exit    │ GET /api/v1/status
        │              ▼                      ▼
┌───────┼─────────────────────────────────────────────────┐
│       │          API SERVER (Express)                    │
│       │          localhost:3000                           │
│       │                                                  │
│       │  ┌─────────┐  ┌──────────────┐  ┌────────────┐ │
│       │  │ x402    │  │ Order        │  │ Tick       │ │
│       │  │ Midware │  │ Service      │  │ Calculator │ │
│       │  └────┬────┘  └──────┬───────┘  └─────┬──────┘ │
│       │       │              │                  │        │
│       │       │    ┌─────────▼──────────────────▼──────┐│
│       │       │    │  Viem Contract Client              ││
│       │       │    │  (reads/writes to PositionExiterHook)│
│       │       │    └─────────┬──────────────────────────┘│
└───────┼───────┼──────────────┼───────────────────────────┘
        │       │              │
        │       │              ▼
┌───────▼───────┼──────────────────────────────────────────┐
│               │     ANVIL (Local Fork)                    │
│               │     localhost:8545                         │
│               │                                           │
│  ┌────────────┼──────────────────────────────────────┐   │
│  │            │    Uniswap V4 PoolManager            │   │
│  │            │         │                             │   │
│  │            │    PositionExiterHook                 │   │
│  │            │    (afterSwap monitoring)             │   │
│  │            │                                       │   │
│  │  MockERC20 (token0)    MockERC20 (token1)         │   │
│  └───────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────┘
```

### Key Data Flows

**Create Order:**
1. Frontend: User fills form → `ERC20.approve(hookAddress, amount)` via MetaMask
2. Frontend: POST `/api/v1/exit` with mock x402 payment
3. API: x402 middleware passes (SKIP_PAYMENT=true)
4. API: OrderService calls `hook.createOrder(params)` on Anvil
5. API: Returns orderId + txHash to frontend
6. Frontend: Displays order in list

**Monitor Order:**
1. Frontend: Polls `GET /api/v1/status/:orderId` every 10s
2. API: Calls `hook.getOrder(orderId)` + `hook.getOrderFillStatus(orderId)` on chain
3. API: Returns current status + fill percentage
4. Frontend: Updates progress bar

**Fill Order (simulated by swap):**
1. Developer runs a swap on Anvil that crosses the order's tick range
2. Hook's `afterSwap` detects crossing, marks order as filled
3. Next frontend poll sees `status: filled`

---

## Effort Estimates

| Phase | Tasks | Complexity |
|-------|-------|------------|
| Phase 1: Make it run | 4 | Low — just npm install + env setup |
| Phase 2: Anvil deploy | 4 | Medium — Foundry scripts, ABI export |
| Phase 3: Wire API | 6 | Medium-High — core integration work |
| Phase 4: Frontend | 6 | Medium — UX improvements |
| Phase 5: Polish | 4 | Low — demo prep |

**Critical path**: Phase 1 → 2 → 3 → 4 (sequential)
**Phase 5** can be done in parallel with Phase 4.
