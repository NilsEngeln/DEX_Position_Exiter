# DEX Position Exiter

A payment-gated (x402 standard) token exit service built on Uniswap V4 hooks that enables intelligent, low-impact token exits for DeFi positions.

## Overview

When exiting large positions in low-liquidity tokens, direct market sells cause significant price impact. This service provides an alternative: creating optimized Uniswap V4 liquidity positions that allow gradual exits as natural market activity moves the price through your position's tick range.

### How It Works

1. **Request Exit**: Agent/user specifies token to sell, token to receive, amount, and timeframe
2. **Pay via x402**: Service fee + gas escrow paid via x402 protocol (USDC on L2)
3. **Position Created**: Optimal tick range calculated, single-sided LP position opened
4. **Auto-Execute**: When price moves through range, position converts automatically
5. **Receive Tokens**: Tokens + fees returned, unused gas refunded

### Example Use Case

> "Sell 20% of my CoinX for USDC over 7 days without ruining the chart"

The service:
- Calculates optimal tick range above current price
- Creates 100% CoinX / 0% USDC LP position
- Monitors for price movement through the range
- Auto-closes when filled (or at deadline)
- Returns USDC + earned fees + gas refund

## Tech Stack

- **Smart Contracts**: Solidity 0.8.26+, Foundry, Uniswap V4 hooks
- **Backend**: Node.js, TypeScript, Express, x402 middleware
- **Database**: PostgreSQL (planned)
- **Networks**: Ethereum Sepolia (testing), Base (production)

## Project Structure

```
DEX_Position_Exiter/
├── contracts/           # Solidity smart contracts (Foundry)
│   ├── src/            # Contract source files
│   │   ├── interfaces/ # Contract interfaces
│   │   └── PositionExiterHook.sol
│   ├── test/           # Contract tests
│   └── foundry.toml    # Foundry configuration
├── api/                # Express.js API server
│   ├── src/
│   │   ├── routes/     # API endpoints
│   │   ├── services/   # Business logic
│   │   ├── middleware/ # x402, error handling
│   │   ├── types/      # TypeScript types
│   │   └── utils/      # Helpers
│   └── package.json
├── frontend/           # Vite + TypeScript frontend
│   └── src/
└── docs/               # Documentation
    ├── ARCHITECTURE.md
    └── TECHNICAL_SPEC.md
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

## Documentation

- [Architecture](./docs/ARCHITECTURE.md) - System design, diagrams, data flows
- [Technical Spec](./docs/TECHNICAL_SPEC.md) - Contract interfaces, API design, algorithms

## Project Status

**Phase: Development Setup** (Current)

- [x] Research x402 payment protocol
- [x] Research Uniswap V4 hooks architecture
- [x] Design system architecture
- [x] Define smart contract interfaces
- [x] Set up Foundry project structure
- [x] Set up Node.js/TypeScript API structure
- [x] Create initial contract scaffolding
- [ ] Implement full Uniswap V4 integration
- [ ] Build API server with database
- [ ] Testing (unit, integration, fork tests)
- [ ] Deploy to Sepolia testnet
- [ ] Security audit
- [ ] Deploy to Base mainnet

## Design Decisions

| Decision | Choice |
|----------|--------|
| Position Closing | Hook-based (`afterSwap` monitoring) |
| Fee Structure | Flat fee ($1 per order) |
| Partial Fills | Return mix at deadline |
| Test Network | Ethereum Sepolia |
| Production Network | Base |
| Token Support | Any token pair with V4 pool |

## Key Components

### Smart Contracts

| Contract | Purpose |
|----------|---------|
| `PositionExiterHook.sol` | Uniswap V4 hook - monitors swaps, manages positions |
| `TokenAllowanceGuard.sol` | Scoped approvals - users only approve exact amounts needed |
| `GasEscrow.sol` | Holds prepaid gas, pays executors, refunds unused |

### API Endpoints

| Endpoint | Description |
|----------|-------------|
| `POST /exit` | Create exit order (x402 protected) |
| `GET /status/:orderId` | Check order status |
| `POST /cancel/:orderId` | Cancel active order |
| `GET /estimate` | Get cost estimate |

## Security Features

- **Scoped Approvals**: Users approve only the exact amount for each order
- **Time-Bound**: Approvals expire automatically
- **Gas Escrow**: Prepaid gas ensures positions can always be closed
- **Emergency Pause**: Admin can pause in case of issues

## References

- [x402 Protocol](https://www.x402.org/)
- [x402 GitHub](https://github.com/coinbase/x402)
- [Uniswap V4 Docs](https://docs.uniswap.org/contracts/v4/overview)
- [Uniswap V4 Hooks](https://docs.uniswap.org/contracts/v4/concepts/hooks)
- [LimitOrder Example](https://github.com/Uniswap/v4-periphery/blob/example-contracts/contracts/hooks/examples/LimitOrder.sol)

## License

MIT
