#!/bin/bash

# DEX Position Exiter - Development Server Startup Script
# This script starts both the API and frontend servers

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "================================================"
echo "  DEX Position Exiter - Development Environment"
echo "================================================"
echo ""

# Check if node is installed
if ! command -v node &> /dev/null; then
    echo "Error: Node.js is not installed"
    echo "Please install Node.js 20+ from https://nodejs.org"
    exit 1
fi

NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 20 ]; then
    echo "Error: Node.js 20+ is required (found v$NODE_VERSION)"
    exit 1
fi

echo "Node.js version: $(node -v)"
echo ""

# Install API dependencies
echo "[1/4] Installing API dependencies..."
cd "$SCRIPT_DIR/api"
if [ ! -d "node_modules" ]; then
    npm install
else
    echo "      (already installed)"
fi

# Create .env if it doesn't exist
if [ ! -f ".env" ]; then
    echo "[2/4] Creating API .env file..."
    cp .env.example .env 2>/dev/null || cat > .env << 'EOF'
PORT=3000
NODE_ENV=development
LOG_LEVEL=info
CORS_ORIGIN=*
SKIP_PAYMENT=true
PAYMENT_ADDRESS=0x0000000000000000000000000000000000000001
EOF
else
    echo "[2/4] API .env already exists"
fi

# Install frontend dependencies
echo "[3/4] Installing frontend dependencies..."
cd "$SCRIPT_DIR/frontend"
if [ ! -d "node_modules" ]; then
    npm install
else
    echo "      (already installed)"
fi

echo "[4/4] Starting servers..."
echo ""
echo "================================================"
echo "  Starting API server on http://localhost:3000"
echo "  Starting frontend on http://localhost:5173"
echo "================================================"
echo ""
echo "Press Ctrl+C to stop both servers"
echo ""

# Start API in background
cd "$SCRIPT_DIR/api"
npm run dev &
API_PID=$!

# Give API a moment to start
sleep 2

# Start frontend in foreground
cd "$SCRIPT_DIR/frontend"
npm run dev &
FRONTEND_PID=$!

# Handle shutdown
cleanup() {
    echo ""
    echo "Shutting down servers..."
    kill $API_PID 2>/dev/null
    kill $FRONTEND_PID 2>/dev/null
    exit 0
}

trap cleanup SIGINT SIGTERM

# Wait for both processes
wait
