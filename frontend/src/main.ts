import {
  createWalletClient,
  createPublicClient,
  custom,
  http,
  formatUnits,
  type Address,
  type WalletClient,
  type PublicClient,
  defineChain,
} from "viem";

import { ANVIL_ADDRESSES } from "./abi/addresses.js";
import { ERC20ABI } from "./abi/ERC20.js";

// ═══════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════

const API_BASE_URL = import.meta.env.VITE_API_URL || "";

// Anvil local chain
const anvil = defineChain({
  id: 31337,
  name: "Anvil",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: { http: ["http://127.0.0.1:8545"] },
  },
});

// Deployed token info on Anvil
const TOKENS: Record<string, { address: Address; symbol: string; decimals: number }> = {
  TOKEN0: { address: ANVIL_ADDRESSES.token0, symbol: "WETH", decimals: 18 },
  TOKEN1: { address: ANVIL_ADDRESSES.token1, symbol: "USDC", decimals: 6 },
};

// ═══════════════════════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════════════════════

// @ts-ignore - walletClient stored for future wallet-based transactions
let walletClient: WalletClient | null = null;
let publicClient: PublicClient | null = null;
let connectedAddress: Address | null = null;

const localOrders: Array<{
  orderId: string;
  status: string;
  fillPercent: number;
  createdAt: string;
  deadline: string;
  txHash?: string;
}> = [];

// ═══════════════════════════════════════════════════════════════════════════
// DOM ELEMENTS
// ═══════════════════════════════════════════════════════════════════════════

const connectBtn = document.getElementById("connectBtn") as HTMLButtonElement;
const networkDot = document.getElementById("networkDot") as HTMLDivElement;
const networkName = document.getElementById("networkName") as HTMLSpanElement;
const createOrderForm = document.getElementById("createOrderForm") as HTMLFormElement;
const estimateBtn = document.getElementById("estimateBtn") as HTMLButtonElement;
const createBtn = document.getElementById("createBtn") as HTMLButtonElement;
const createResult = document.getElementById("createResult") as HTMLDivElement;
const orderIdInput = document.getElementById("orderIdInput") as HTMLInputElement;
const checkStatusBtn = document.getElementById("checkStatusBtn") as HTMLButtonElement;
const statusResult = document.getElementById("statusResult") as HTMLDivElement;
const ordersList = document.getElementById("ordersList") as HTMLDivElement;
const apiStatus = document.getElementById("apiStatus") as HTMLSpanElement;

const tokenSellInput = document.getElementById("tokenSell") as HTMLInputElement;
const tokenBuyInput = document.getElementById("tokenBuy") as HTMLInputElement;
const amountInput = document.getElementById("amount") as HTMLInputElement;
const timeframeSelect = document.getElementById("timeframe") as HTMLSelectElement;
const networkSelect = document.getElementById("network") as HTMLSelectElement;

// ═══════════════════════════════════════════════════════════════════════════
// WALLET CONNECTION
// ═══════════════════════════════════════════════════════════════════════════

async function connectWallet(): Promise<void> {
  if (!window.ethereum) {
    alert("Please install MetaMask or another web3 wallet");
    return;
  }

  try {
    const accounts = (await window.ethereum.request({
      method: "eth_requestAccounts",
    })) as Address[];

    if (accounts.length === 0) {
      throw new Error("No accounts found");
    }

    connectedAddress = accounts[0];

    walletClient = createWalletClient({
      account: connectedAddress,
      chain: anvil,
      transport: custom(window.ethereum),
    });

    publicClient = createPublicClient({
      chain: anvil,
      transport: http("http://127.0.0.1:8545"),
    });

    updateConnectionUI(true);

    // Switch to Anvil if needed
    const chainId = await window.ethereum.request({ method: "eth_chainId" });
    if (chainId !== "0x7a69") {
      await switchToAnvil();
    }

    // Show balances
    await showBalances();
    await loadOrders();
  } catch (error) {
    console.error("Failed to connect wallet:", error);
    alert("Failed to connect wallet. See console for details.");
  }
}

async function switchToAnvil(): Promise<void> {
  try {
    await window.ethereum!.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: "0x7a69" }],
    });
  } catch (error: any) {
    if (error.code === 4902) {
      await window.ethereum!.request({
        method: "wallet_addEthereumChain",
        params: [
          {
            chainId: "0x7a69",
            chainName: "Anvil (Local)",
            nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
            rpcUrls: ["http://127.0.0.1:8545"],
          },
        ],
      });
    }
  }
}

async function showBalances(): Promise<void> {
  if (!publicClient || !connectedAddress) return;

  const balanceEl = document.getElementById("balanceInfo");
  if (!balanceEl) return;

  try {
    const ethBalance = await publicClient.getBalance({ address: connectedAddress });
    const token0Balance = await publicClient.readContract({
      address: TOKENS.TOKEN0.address,
      abi: ERC20ABI,
      functionName: "balanceOf",
      args: [connectedAddress],
    });
    const token1Balance = await publicClient.readContract({
      address: TOKENS.TOKEN1.address,
      abi: ERC20ABI,
      functionName: "balanceOf",
      args: [connectedAddress],
    });

    balanceEl.innerHTML = `
      <strong>Balances:</strong>
      ${formatUnits(ethBalance, 18)} ETH |
      ${formatUnits(token0Balance as bigint, TOKENS.TOKEN0.decimals)} ${TOKENS.TOKEN0.symbol} |
      ${formatUnits(token1Balance as bigint, TOKENS.TOKEN1.decimals)} ${TOKENS.TOKEN1.symbol}
    `;
    balanceEl.style.display = "block";
  } catch (error) {
    console.error("Failed to fetch balances:", error);
  }
}

function updateConnectionUI(connected: boolean): void {
  if (connected && connectedAddress) {
    connectBtn.textContent = `${connectedAddress.slice(0, 6)}...${connectedAddress.slice(-4)}`;
    connectBtn.classList.add("connected");
    networkDot.classList.add("connected");
    networkName.textContent = "Anvil (Local)";
    createBtn.disabled = false;
  } else {
    connectBtn.textContent = "Connect Wallet";
    connectBtn.classList.remove("connected");
    networkDot.classList.remove("connected");
    networkName.textContent = "Not Connected";
    createBtn.disabled = true;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// API CALLS
// ═══════════════════════════════════════════════════════════════════════════

async function checkApiHealth(): Promise<void> {
  try {
    const response = await fetch(`${API_BASE_URL}/health`);
    if (response.ok) {
      const data = await response.json();
      const contractStatus = data.contracts?.hookDeployed ? "Contracts OK" : "No contracts";
      apiStatus.textContent = `Healthy (v${data.version}) - ${contractStatus}`;
      apiStatus.style.color = "#3fb950";
    } else {
      throw new Error("API unhealthy");
    }
  } catch {
    apiStatus.textContent = "Offline - start API with: cd api && npm run dev";
    apiStatus.style.color = "#f85149";
  }
}

async function getEstimate(): Promise<void> {
  const tokenSell = tokenSellInput.value.trim();
  const tokenBuy = tokenBuyInput.value.trim();
  const amount = amountInput.value.trim();
  const timeframeDays = parseInt(timeframeSelect.value);
  const network = networkSelect.value;

  if (!tokenSell || !tokenBuy || !amount) {
    showResult(createResult, "Please fill in all fields", true);
    return;
  }

  estimateBtn.disabled = true;
  estimateBtn.textContent = "Estimating...";

  try {
    const response = await fetch(`${API_BASE_URL}/api/v1/estimate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tokenSell, tokenBuy, amount, timeframeDays, network }),
    });

    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Estimate failed");

    const sellToken = getTokenInfo(tokenSell);
    const buyToken = getTokenInfo(tokenBuy);

    showResult(
      createResult,
      `Estimate Results:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Selling: ${formatUnits(BigInt(amount), sellToken.decimals)} ${sellToken.symbol}
For: ${buyToken.symbol}

Tick Range: [${data.tickRange.tickLower}, ${data.tickRange.tickUpper}]
Fill Probability: ${(data.estimatedFillProbability * 100).toFixed(1)}%

Pool: tick=${data.poolInfo.currentTick}, fee=${data.poolInfo.fee / 10000}%

Costs:
  Service Fee: $${data.costs.serviceFee}
  Est. Gas: ${formatUnits(BigInt(data.costs.estimatedGas), 18)} ETH`,
      false
    );
  } catch (error: any) {
    showResult(createResult, `Error: ${error.message}`, true);
  } finally {
    estimateBtn.disabled = false;
    estimateBtn.textContent = "Get Estimate";
  }
}

async function createOrder(event: Event): Promise<void> {
  event.preventDefault();

  if (!connectedAddress) {
    alert("Please connect your wallet first");
    return;
  }

  const tokenSell = tokenSellInput.value.trim();
  const tokenBuy = tokenBuyInput.value.trim();
  const amount = amountInput.value.trim();
  const timeframeDays = parseInt(timeframeSelect.value);
  const network = networkSelect.value;

  if (!tokenSell || !tokenBuy || !amount) {
    showResult(createResult, "Please fill in all fields", true);
    return;
  }

  createBtn.disabled = true;
  createBtn.textContent = "Creating Order...";

  try {
    // First request (no payment) triggers 402
    const initialResponse = await fetch(`${API_BASE_URL}/api/v1/exit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tokenSell, tokenBuy, amount, timeframeDays, network }),
    });

    if (initialResponse.status === 402) {
      const paymentReq = await initialResponse.json();

      // Build mock payment for dev mode (SKIP_PAYMENT=true)
      const mockPayment = btoa(
        JSON.stringify({
          x402Version: 1,
          scheme: "exact",
          network: "ethereum-sepolia",
          payload: {
            signature: "0x" + "00".repeat(65),
            authorization: {
              from: connectedAddress,
              to: paymentReq.accepts[0].payTo,
              value: paymentReq.accepts[0].maxAmountRequired,
              validAfter: "0",
              validBefore: String(Math.floor(Date.now() / 1000) + 300),
              nonce: "0",
            },
          },
        })
      );

      createBtn.textContent = "Sending to chain...";

      const paidResponse = await fetch(`${API_BASE_URL}/api/v1/exit`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Payment": mockPayment,
        },
        body: JSON.stringify({ tokenSell, tokenBuy, amount, timeframeDays, network }),
      });

      if (paidResponse.ok) {
        const order = await paidResponse.json();
        const sellToken = getTokenInfo(tokenSell);

        showResult(
          createResult,
          `Order Created On-Chain!
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Order ID: ${order.orderId}
Status: ${order.status.toUpperCase()}
Liquidity: ${order.position.liquidity}

Position: [${order.position.tickLower}, ${order.position.tickUpper}]
Fill Prob: ${(order.position.estimatedFillProbability * 100).toFixed(1)}%

Amount: ${formatUnits(BigInt(amount), sellToken.decimals)} ${sellToken.symbol}
Expires: ${new Date(order.expiresAt).toLocaleString()}
Tx: ${order.txHash}`,
          false
        );

        localOrders.unshift({
          orderId: order.orderId,
          status: order.status,
          fillPercent: 0,
          createdAt: new Date().toISOString(),
          deadline: order.expiresAt,
          txHash: order.txHash,
        });
        renderOrders();
      } else {
        const err = await paidResponse.json();
        throw new Error(err.error || err.message || "Order creation failed");
      }
    } else if (initialResponse.ok) {
      const order = await initialResponse.json();
      showResult(createResult, JSON.stringify(order, null, 2), false);
    } else {
      const error = await initialResponse.json();
      throw new Error(error.error || "Failed to create order");
    }
  } catch (error: any) {
    showResult(createResult, `Error: ${error.message}`, true);
  } finally {
    createBtn.disabled = false;
    createBtn.textContent = "Create Exit Order ($1)";
  }
}

async function checkOrderStatus(): Promise<void> {
  const orderId = orderIdInput.value.trim();
  if (!orderId) {
    showResult(statusResult, "Please enter an order ID", true);
    return;
  }

  checkStatusBtn.disabled = true;
  checkStatusBtn.textContent = "...";

  try {
    const response = await fetch(`${API_BASE_URL}/api/v1/status/${orderId}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Failed to get status");

    showResult(
      statusResult,
      `Order Status
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Order ID: ${data.orderId}
Status: ${data.status.toUpperCase()}
Fill: ${data.fillPercent}%

Token0 in position: ${data.currentToken0}
Token1 in position: ${data.currentToken1}

Created: ${new Date(data.createdAt).toLocaleString()}
Deadline: ${new Date(data.deadline).toLocaleString()}
${data.closedAt ? `Closed: ${new Date(data.closedAt).toLocaleString()}` : ""}
${data.closeReason ? `Reason: ${data.closeReason}` : ""}
Tx: ${data.txHash || "n/a"}`,
      false
    );
  } catch (error: any) {
    showResult(statusResult, `Error: ${error.message}`, true);
  } finally {
    checkStatusBtn.disabled = false;
    checkStatusBtn.textContent = "Check";
  }
}

async function cancelOrder(orderId: string): Promise<void> {
  try {
    const response = await fetch(`${API_BASE_URL}/api/v1/cancel/${orderId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ signature: "0x00" }),
    });

    const data = await response.json();
    if (!data.success) throw new Error(data.message);

    // Update local order
    const order = localOrders.find((o) => o.orderId === orderId);
    if (order) {
      order.status = "cancelled";
    }
    renderOrders();
    showResult(statusResult, `Order cancelled! Tx: ${data.txHash}`, false);
  } catch (error: any) {
    showResult(statusResult, `Cancel failed: ${error.message}`, true);
  }
}

async function loadOrders(): Promise<void> {
  if (!connectedAddress) return;

  try {
    const response = await fetch(`${API_BASE_URL}/api/v1/orders/${connectedAddress}`);
    if (response.ok) {
      const data = await response.json();
      localOrders.length = 0;
      localOrders.push(...data.orders);
    }
  } catch {
    // API might be offline
  }

  renderOrders();
}

// ═══════════════════════════════════════════════════════════════════════════
// UI HELPERS
// ═══════════════════════════════════════════════════════════════════════════

function getTokenInfo(address: string): { symbol: string; decimals: number } {
  if (address.toLowerCase() === TOKENS.TOKEN0.address.toLowerCase()) {
    return { symbol: TOKENS.TOKEN0.symbol, decimals: TOKENS.TOKEN0.decimals };
  }
  if (address.toLowerCase() === TOKENS.TOKEN1.address.toLowerCase()) {
    return { symbol: TOKENS.TOKEN1.symbol, decimals: TOKENS.TOKEN1.decimals };
  }
  return { symbol: "TOKEN", decimals: 18 };
}

function showResult(element: HTMLDivElement, message: string, isError: boolean): void {
  element.style.display = "block";
  element.textContent = message;
  element.classList.toggle("error", isError);
  element.classList.toggle("success", !isError);
}

function renderOrders(): void {
  if (localOrders.length === 0) {
    ordersList.innerHTML = `<div class="empty-state">No orders yet. Create one above!</div>`;
    return;
  }

  ordersList.innerHTML = localOrders
    .map(
      (order) => `
    <div class="order-item">
      <div class="order-header">
        <span class="order-id">${order.orderId.slice(0, 18)}...</span>
        <span class="status-badge status-${order.status}">${order.status}</span>
      </div>
      <div class="order-details">
        <span>Fill: ${order.fillPercent}%</span>
        <span>Expires: ${new Date(order.deadline).toLocaleDateString()}</span>
        ${order.txHash ? `<span class="tx-link">Tx: ${order.txHash.slice(0, 10)}...</span>` : ""}
      </div>
      <div class="progress-bar">
        <div class="progress-fill" style="width: ${order.fillPercent}%"></div>
      </div>
      ${
        order.status === "active"
          ? `<button class="cancel-btn" onclick="window.__cancelOrder('${order.orderId}')">Cancel</button>`
          : ""
      }
    </div>
  `
    )
    .join("");
}

// Expose cancel handler globally for inline onclick
(window as any).__cancelOrder = cancelOrder;

// ═══════════════════════════════════════════════════════════════════════════
// EVENT LISTENERS & INIT
// ═══════════════════════════════════════════════════════════════════════════

connectBtn.addEventListener("click", connectWallet);
estimateBtn.addEventListener("click", getEstimate);
createOrderForm.addEventListener("submit", createOrder);
checkStatusBtn.addEventListener("click", checkOrderStatus);

// Pre-fill with deployed Anvil tokens
tokenSellInput.value = TOKENS.TOKEN0.address;
tokenBuyInput.value = TOKENS.TOKEN1.address;
amountInput.value = "1000000000000000000"; // 1 token (18 decimals)

// Check API health on load
checkApiHealth();

// Auto-refresh orders every 10 seconds
setInterval(async () => {
  if (connectedAddress) {
    await loadOrders();
    await showBalances();
  }
}, 10000);

// Listen for account/chain changes
if (window.ethereum) {
  window.ethereum.on("accountsChanged", (accounts: Address[]) => {
    if (accounts.length === 0) {
      connectedAddress = null;
      walletClient = null;
      updateConnectionUI(false);
    } else {
      connectedAddress = accounts[0];
      updateConnectionUI(true);
      showBalances();
      loadOrders();
    }
  });

  window.ethereum.on("chainChanged", () => {
    window.location.reload();
  });
}

// Type declaration for window.ethereum
declare global {
  interface Window {
    ethereum?: {
      request: (args: { method: string; params?: any[] }) => Promise<any>;
      on: (event: string, callback: (...args: any[]) => void) => void;
    };
  }
}
