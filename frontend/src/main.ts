import {
  createWalletClient,
  createPublicClient,
  custom,
  http,
  formatUnits,
  parseUnits,
  type Address,
  type WalletClient,
  type PublicClient,
} from "viem";
import { sepolia } from "viem/chains";

// ═══════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════

const API_BASE_URL = import.meta.env.VITE_API_URL || "http://localhost:3000";

// Test token addresses on Sepolia
const TEST_TOKENS = {
  // These are example addresses - replace with actual deployed test tokens
  USDC: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238", // Circle USDC on Sepolia
  WETH: "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14", // WETH on Sepolia
};

// ═══════════════════════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════════════════════

let walletClient: WalletClient | null = null;
let publicClient: PublicClient | null = null;
let connectedAddress: Address | null = null;

// Store orders locally for demo
const localOrders: Array<{
  orderId: string;
  status: string;
  fillPercent: number;
  createdAt: string;
  deadline: string;
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

// Form inputs
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
    // Request account access
    const accounts = await window.ethereum.request({
      method: "eth_requestAccounts",
    }) as Address[];

    if (accounts.length === 0) {
      throw new Error("No accounts found");
    }

    connectedAddress = accounts[0];

    // Create clients
    walletClient = createWalletClient({
      account: connectedAddress,
      chain: sepolia,
      transport: custom(window.ethereum),
    });

    publicClient = createPublicClient({
      chain: sepolia,
      transport: http(),
    });

    // Update UI
    updateConnectionUI(true);

    // Check network
    const chainId = await window.ethereum.request({ method: "eth_chainId" });
    if (chainId !== "0xaa36a7") {
      // Sepolia chain ID
      await switchToSepolia();
    }

    // Load orders
    await loadOrders();
  } catch (error) {
    console.error("Failed to connect wallet:", error);
    alert("Failed to connect wallet. See console for details.");
  }
}

async function switchToSepolia(): Promise<void> {
  try {
    await window.ethereum.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: "0xaa36a7" }],
    });
  } catch (error: any) {
    // Chain not added, try to add it
    if (error.code === 4902) {
      await window.ethereum.request({
        method: "wallet_addEthereumChain",
        params: [
          {
            chainId: "0xaa36a7",
            chainName: "Sepolia",
            nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
            rpcUrls: ["https://rpc.sepolia.org"],
            blockExplorerUrls: ["https://sepolia.etherscan.io"],
          },
        ],
      });
    }
  }
}

function updateConnectionUI(connected: boolean): void {
  if (connected && connectedAddress) {
    connectBtn.textContent = `${connectedAddress.slice(0, 6)}...${connectedAddress.slice(-4)}`;
    connectBtn.classList.add("connected");
    networkDot.classList.add("connected");
    networkName.textContent = "Sepolia";
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
      apiStatus.textContent = `Healthy (v${data.version})`;
      apiStatus.style.color = "#3fb950";
    } else {
      throw new Error("API unhealthy");
    }
  } catch {
    apiStatus.textContent = "Offline";
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
      body: JSON.stringify({
        tokenSell,
        tokenBuy,
        amount,
        timeframeDays,
        network,
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "Estimate failed");
    }

    showResult(
      createResult,
      `Estimate Results:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Tick Range:
  Lower: ${data.tickRange.tickLower}
  Upper: ${data.tickRange.tickUpper}

Fill Probability: ${(data.estimatedFillProbability * 100).toFixed(1)}%
Average Price: ${data.estimatedAveragePrice}

Costs:
  Service Fee: $${data.costs.serviceFee}
  Est. Gas: ${data.costs.estimatedGas} wei
  Total: ${data.costs.total}

Pool Info:
  Current Tick: ${data.poolInfo.currentTick}
  Fee Tier: ${data.poolInfo.fee / 10000}%
  Liquidity: ${data.poolInfo.liquidity}`,
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
    // First, make request without payment to get 402 response
    const initialResponse = await fetch(`${API_BASE_URL}/api/v1/exit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tokenSell,
        tokenBuy,
        amount,
        timeframeDays,
        network,
      }),
    });

    if (initialResponse.status === 402) {
      // Get payment requirements
      const paymentReq = await initialResponse.json();
      console.log("Payment required:", paymentReq);

      // In a real implementation, we would:
      // 1. Sign the payment with the wallet
      // 2. Send the signed payment in X-Payment header
      // For now, simulate with dev mode

      showResult(
        createResult,
        `Payment Required (x402)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Amount: $${parseInt(paymentReq.accepts[0].maxAmountRequired) / 1e6} USDC
Network: ${paymentReq.accepts[0].network}
Pay To: ${paymentReq.accepts[0].payTo}

In production, your wallet would sign a USDC transfer.
For testing, set SKIP_PAYMENT=true in API .env`,
        false
      );

      // If SKIP_PAYMENT is enabled on server, try again with mock payment
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

      const paidResponse = await fetch(`${API_BASE_URL}/api/v1/exit`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Payment": mockPayment,
        },
        body: JSON.stringify({
          tokenSell,
          tokenBuy,
          amount,
          timeframeDays,
          network,
        }),
      });

      if (paidResponse.ok) {
        const order = await paidResponse.json();
        showResult(
          createResult,
          `Order Created Successfully!
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Order ID: ${order.orderId}
Status: ${order.status}

Position:
  Tick Lower: ${order.position.tickLower}
  Tick Upper: ${order.position.tickUpper}
  Fill Probability: ${(order.position.estimatedFillProbability * 100).toFixed(1)}%

Expires: ${new Date(order.expiresAt).toLocaleString()}
Tx Hash: ${order.txHash || "pending"}`,
          false
        );

        // Add to local orders
        localOrders.unshift({
          orderId: order.orderId,
          status: order.status,
          fillPercent: 0,
          createdAt: new Date().toISOString(),
          deadline: order.expiresAt,
        });
        renderOrders();
      }
    } else if (initialResponse.ok) {
      // Direct success (shouldn't happen in production)
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
    createBtn.textContent = "Create Order (Pay $1)";
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

    if (!response.ok) {
      throw new Error(data.error || "Failed to get status");
    }

    showResult(
      statusResult,
      `Order Status
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Order ID: ${data.orderId}
Status: ${data.status.toUpperCase()}
Fill: ${data.fillPercent}%

Created: ${new Date(data.createdAt).toLocaleString()}
Deadline: ${new Date(data.deadline).toLocaleString()}
${data.closedAt ? `Closed: ${new Date(data.closedAt).toLocaleString()}` : ""}
${data.closeReason ? `Reason: ${data.closeReason}` : ""}`,
      false
    );
  } catch (error: any) {
    showResult(statusResult, `Error: ${error.message}`, true);
  } finally {
    checkStatusBtn.disabled = false;
    checkStatusBtn.textContent = "Check";
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
    // API might be offline, use local orders
  }

  renderOrders();
}

// ═══════════════════════════════════════════════════════════════════════════
// UI HELPERS
// ═══════════════════════════════════════════════════════════════════════════

function showResult(element: HTMLDivElement, message: string, isError: boolean): void {
  element.style.display = "block";
  element.textContent = message;
  element.classList.toggle("error", isError);
  element.classList.toggle("success", !isError);
}

function renderOrders(): void {
  if (localOrders.length === 0) {
    ordersList.innerHTML = `<div class="empty-state">No orders yet</div>`;
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
      </div>
      <div class="progress-bar">
        <div class="progress-fill" style="width: ${order.fillPercent}%"></div>
      </div>
    </div>
  `
    )
    .join("");
}

// ═══════════════════════════════════════════════════════════════════════════
// EVENT LISTENERS
// ═══════════════════════════════════════════════════════════════════════════

connectBtn.addEventListener("click", connectWallet);
estimateBtn.addEventListener("click", getEstimate);
createOrderForm.addEventListener("submit", createOrder);
checkStatusBtn.addEventListener("click", checkOrderStatus);

// Pre-fill with test tokens for convenience
tokenSellInput.value = TEST_TOKENS.WETH;
tokenBuyInput.value = TEST_TOKENS.USDC;
amountInput.value = "1000000000000000000"; // 1 token

// Check API health on load
checkApiHealth();

// Listen for account changes
if (window.ethereum) {
  window.ethereum.on("accountsChanged", (accounts: Address[]) => {
    if (accounts.length === 0) {
      connectedAddress = null;
      walletClient = null;
      updateConnectionUI(false);
    } else {
      connectedAddress = accounts[0];
      updateConnectionUI(true);
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
