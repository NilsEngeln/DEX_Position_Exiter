import { Router } from "express";
import { checkContractHealth } from "../services/contractClient.js";

export const healthRoutes = Router();

healthRoutes.get("/", async (_req, res) => {
  const contractHealth = await checkContractHealth();

  res.json({
    status: "healthy",
    timestamp: new Date().toISOString(),
    version: "0.1.0",
    contracts: contractHealth,
  });
});

healthRoutes.get("/ready", async (_req, res) => {
  const contractHealth = await checkContractHealth();

  res.json({
    ready: contractHealth.rpc && contractHealth.hookDeployed,
    checks: {
      rpc: contractHealth.rpc,
      hookDeployed: contractHealth.hookDeployed,
      poolInitialized: contractHealth.poolInitialized,
    },
  });
});
