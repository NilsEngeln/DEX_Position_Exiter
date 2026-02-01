import { Request, Response, NextFunction } from "express";
import { SERVICE_FEE_USD } from "../types/index.js";
import { logger } from "../utils/logger.js";

/**
 * x402 Payment Middleware
 *
 * Implements the x402 payment protocol flow:
 * 1. If no payment signature, return 402 with payment requirements
 * 2. If payment signature present, verify and settle payment
 * 3. If payment verified, continue to handler
 *
 * @see https://www.x402.org/
 * @see https://github.com/coinbase/x402
 */

interface PaymentRequirement {
  scheme: "exact";
  network: string;
  maxAmountRequired: string;
  resource: string;
  description: string;
  mimeType: string;
  payTo: string;
  maxTimeoutSeconds: number;
  asset: string;
  extra?: Record<string, unknown>;
}

interface PaymentPayload {
  x402Version: number;
  scheme: "exact";
  network: string;
  payload: {
    signature: string;
    authorization: {
      from: string;
      to: string;
      value: string;
      validAfter: string;
      validBefore: string;
      nonce: string;
    };
  };
}

// Configuration
const FACILITATOR_URL = process.env.X402_FACILITATOR_URL || "https://x402.org/facilitator";
const PAYMENT_ADDRESS = process.env.PAYMENT_ADDRESS || "0x0000000000000000000000000000000000000000";
const USDC_ADDRESS_SEPOLIA = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";
const USDC_ADDRESS_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

/**
 * Create payment requirement object for 402 response
 */
function createPaymentRequirement(
  req: Request,
  network: string
): PaymentRequirement {
  const usdcAddress = network === "base" ? USDC_ADDRESS_BASE : USDC_ADDRESS_SEPOLIA;

  return {
    scheme: "exact",
    network: network === "base" ? "base" : "ethereum-sepolia",
    maxAmountRequired: SERVICE_FEE_USD.toString(),
    resource: `${req.protocol}://${req.get("host")}${req.originalUrl}`,
    description: "DEX Position Exiter - Create Exit Order",
    mimeType: "application/json",
    payTo: PAYMENT_ADDRESS,
    maxTimeoutSeconds: 300, // 5 minutes to complete payment
    asset: `eip155:${network === "base" ? "8453" : "11155111"}/erc20:${usdcAddress}`,
  };
}

/**
 * Verify payment with facilitator
 */
async function verifyPayment(
  paymentPayload: PaymentPayload,
  requirement: PaymentRequirement
): Promise<{ verified: boolean; payerAddress?: string; error?: string }> {
  try {
    // In production, this calls the x402 facilitator to verify and settle
    // For development/testing, we'll implement a mock verification

    if (process.env.NODE_ENV === "development" || process.env.SKIP_PAYMENT === "true") {
      logger.warn("Payment verification skipped (development mode)");
      return {
        verified: true,
        payerAddress: paymentPayload.payload.authorization.from,
      };
    }

    const response = await fetch(`${FACILITATOR_URL}/verify`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        paymentPayload,
        requirement,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      return { verified: false, error };
    }

    const result = await response.json() as { settled: boolean; payer: string };
    return {
      verified: result.settled,
      payerAddress: result.payer,
    };
  } catch (error) {
    logger.error("Payment verification failed", { error });
    return {
      verified: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

/**
 * x402 Payment Middleware
 */
export async function x402Middleware(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const paymentHeader = req.headers["x-payment"] as string | undefined;
  const network = req.body?.network || "sepolia";

  // If no payment header, return 402 with requirements
  if (!paymentHeader) {
    const requirement = createPaymentRequirement(req, network);

    logger.info("Returning 402 Payment Required", {
      resource: requirement.resource,
      amount: requirement.maxAmountRequired,
    });

    res.status(402).json({
      x402Version: 1,
      accepts: [requirement],
      error: "Payment required to access this resource",
    });
    return;
  }

  // Parse payment payload
  let paymentPayload: PaymentPayload;
  try {
    paymentPayload = JSON.parse(
      Buffer.from(paymentHeader, "base64").toString("utf-8")
    );
  } catch {
    res.status(400).json({
      error: "Invalid payment header",
      message: "Could not parse X-Payment header",
    });
    return;
  }

  // Verify payment
  const requirement = createPaymentRequirement(req, network);
  const verification = await verifyPayment(paymentPayload, requirement);

  if (!verification.verified) {
    logger.warn("Payment verification failed", { error: verification.error });
    res.status(402).json({
      x402Version: 1,
      accepts: [requirement],
      error: verification.error || "Payment verification failed",
    });
    return;
  }

  // Payment verified - add payer address to request and continue
  logger.info("Payment verified", { payer: verification.payerAddress });
  req.body.payerAddress = verification.payerAddress;

  next();
}
