# DEX Position Exiter

An agent-native, payment-gated (x402 standard) token exit service built on Uniswap V4 hooks. Designed for autonomous AI agents and traders that need to exit DeFi positions with minimal price impact — no wallet UI or human interaction required.

## Overview

When exiting large positions in low-liquidity tokens, direct market sells cause significant price impact and "ruin the chart." This service provides an alternative: creating optimized Uniswap V4 single-sided liquidity positions that allow gradual exits as natural market activity moves the price through the position's tick range.

### Why Agent-Native?

The service uses the [x402 payment protocol](https://www.x402.org/) — an HTTP-native payment standard that lets AI agents pay for services programmatically. An autonomous agent can:

1. Discover the API and receive a `402 Payment Required` response with pricing
2. Pay the service fee (USDC) via x402 without any human wallet interaction
3. Trigger a position exit and monitor its status via REST API
4. Receive converted tokens automatically when the position fills

This makes it the first Uniswap V4 hook service purpose-built for the agent economy.

### How It Works

1. **Request Exit**: Agent/user specifies token to sell, token to receive, amount, and timeframe
2. **Pay via x402**: Service fee paid via x402 protocol (USDC on L2)
3. **Position Created**: Optimal tick range calculated, single-sided LP position opened on Uniswap V4
4. **Auto-Execute**: Hook monitors every swap via `afterSwap` — when price moves through range, position converts automatically
5. **Receive Tokens**: Tokens + LP fees returned to recipient

### Example Use Case

> "Sell 20% of my CoinX for USDC over 7 days without ruining the chart"

The service:
- Calculates optimal tick range above current price
- Creates 100% CoinX / 0% USDC LP position
- Monitors every swap for tick crossings via the V4 hook
- Auto-closes when fully filled (or returns mix at deadline)
- Returns USDC + earned LP fees

## Tech Stack

- **Smart Contracts**: Solidity 0.8.26, Foundry, Uniswap V4 hooks (Cancun EVM)
- **Backend**: Node.js 20+, TypeScript, Express, x402 middleware, Viem
- **Keeper Service**: Background order settlement (polls every 30s for expired orders)
- **Frontend**: Vite, TypeScript, Viem (vanilla TS, no framework)
- **Database**: In-memory (PostgreSQL planned)
- **Networks**: Ethereum Sepolia (testing), Base (production target)

## Project Structure

```
DEX_Position_Exiter/
├── contracts/           # Solidity smart contracts (Foundry)
│   ├── src/            # Contract source files
│   │   ├── interfaces/ # IPositionExiterHook.sol
│   │   └── PositionExiterHook.sol
│   ├── test/           # 32 integration tests
│   ├── script/         # Deployment scripts (Anvil, Sepolia)
│   └── foundry.toml    # Foundry configuration
├── api/                # Express.js API server
│   ├── src/
│   │   ├── routes/     # API endpoints (exit, health)
│   │   ├── services/   # orderService, tickCalculator, keeperService, contractClient
│   │   ├── middleware/  # x402 payment, error handling
│   │   ├── abi/        # Generated contract ABIs + addresses
│   │   ├── types/      # Zod schemas & TypeScript types
│   │   └── utils/      # Logger
│   └── package.json
├── frontend/           # Vite + TypeScript frontend
│   ├── src/
│   │   ├── main.ts     # Wallet connect, order UI, balance display
│   │   └── abi/        # Contract ABIs + addresses
│   └── index.html
├── docs/               # Documentation
│   ├── ARCHITECTURE.md # System design, diagrams, data flows
│   ├── TECHNICAL_SPEC.md # Contract interfaces, API design, algorithms
│   └── POC_ROADMAP.md  # Phase tracking, deployed addresses
└── start-dev.sh        # Dev environment launcher
```

## Quick Start

### Prerequisites
- Node.js 20+
- npm or yarn

### Run Development Servers

**Option 1: Single command**
```bash
./start-dev.sh
```

**Option 2: Manual (two terminals)**

Terminal 1 - API:
```bash
cd api && npm install && npm run dev
```

Terminal 2 - Frontend:
```bash
cd frontend && npm install && npm run dev
```

Then open http://localhost:5173 in your browser.

### Test the API

```bash
# Health check
curl http://localhost:3000/health

# Get estimate
curl -X POST http://localhost:3000/api/v1/estimate \
  -H "Content-Type: application/json" \
  -d '{"tokenSell":"0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14","tokenBuy":"0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238","amount":"1000000000000000000","timeframeDays":7,"network":"sepolia"}'
```

### Deploy to Local Anvil

```bash
# Terminal 1: Start Anvil
anvil --host 127.0.0.1 --port 8545

# Terminal 2: Deploy contracts
cd contracts
forge script script/DeployAnvil.s.sol --rpc-url http://127.0.0.1:8545 --broadcast

# Terminal 3: Start API + Frontend
./start-dev.sh
```

## Documentation

- [Architecture](./docs/ARCHITECTURE.md) - System design, diagrams, data flows
- [Technical Spec](./docs/TECHNICAL_SPEC.md) - Contract interfaces, API design, algorithms
- [POC Roadmap](./docs/POC_ROADMAP.md) - Phase tracking, deployed addresses, remaining work

## Project Status

**Phase 4 Complete** — Full stack wired end-to-end on local Anvil.

### Done
- [x] Research x402 payment protocol & Uniswap V4 hooks architecture
- [x] Design system architecture & define smart contract interfaces
- [x] Implement PositionExiterHook (747 lines, full feature set)
- [x] 32 integration tests with real PoolManager (all passing)
- [x] Set up Node.js/TypeScript API with x402 middleware
- [x] Build frontend with wallet connect + order management UI
- [x] Deploy contracts to local Anvil (PoolManager, hook, tokens, routers)
- [x] Wire API to real contract calls via Viem (orderService, tickCalculator, contractClient)
- [x] Keeper service for automatic order settlement (polls every 30s)
- [x] Frontend: real token balances, auto-refresh, cancel buttons

### Remaining
- [ ] Token approval flow in frontend (user approves, then hook transfers)
- [ ] Deploy to Sepolia testnet
- [ ] Real x402 payment integration (currently mock in dev mode)
- [ ] Persistent database (PostgreSQL, currently in-memory)
- [ ] Security audit
- [ ] Deploy to Base mainnet

See [POC Roadmap](./docs/POC_ROADMAP.md) for detailed phase breakdown.

## Design Decisions

| Decision | Choice |
|----------|--------|
| Position Closing | Hook-based (`afterSwap` monitoring) |
| Fee Structure | Flat fee ($1 USDC per order) |
| Partial Fills | Return token mix at deadline |
| Payment Protocol | x402 (agent-native, HTTP-based) |
| Test Network | Ethereum Sepolia |
| Production Network | Base |
| Token Support | Any token pair with a V4 pool |

## Key Components

### Smart Contracts

| Contract | Status | Purpose |
|----------|--------|---------|
| `PositionExiterHook.sol` | Implemented | Uniswap V4 hook — monitors swaps via `afterSwap`, manages LP positions, auto-closes filled orders |
| `IPositionExiterHook.sol` | Implemented | Interface with enums, structs, events, and errors |
| `TokenAllowanceGuard.sol` | Planned | Scoped approvals — users approve only exact amounts per order |
| `GasEscrow.sol` | Planned | Holds prepaid gas, pays executors, refunds unused |

### API Endpoints

All routes under `/api/v1`:

| Endpoint | Description |
|----------|-------------|
| `POST /exit` | Create exit order (x402 payment-gated) |
| `GET /status/:orderId` | Check order status and fill percentage |
| `POST /cancel/:orderId` | Cancel an active order |
| `POST /estimate` | Get cost estimate and optimal tick range |
| `GET /orders/:owner` | List all orders for an address |
| `GET /health` | Health check with contract connectivity status |

### Services

| Service | Purpose |
|---------|---------|
| `orderService` | Core business logic — create, cancel, query orders via on-chain calls |
| `contractClient` | Viem public + wallet clients, contract instances |
| `tickCalculator` | Optimal tick range calculation, volatility analysis, fill probability |
| `keeperService` | Background settlement — polls every 30s for expired orders |

## Security Features

- **Hook-Level Access Control**: Only the hook contract can manage LP positions
- **Time-Bound Orders**: Orders expire at deadline, can always be closed
- **Emergency Pause**: Admin can pause the hook in case of issues
- **x402 Payment Gating**: Service access requires upfront payment, preventing spam

## References

- [x402 Protocol](https://www.x402.org/)
- [x402 GitHub](https://github.com/coinbase/x402)
- [Uniswap V4 Docs](https://docs.uniswap.org/contracts/v4/overview)
- [Uniswap V4 Hooks](https://docs.uniswap.org/contracts/v4/concepts/hooks)

## License

MIT
