import { Router } from "express";

export const healthRoutes = Router();

healthRoutes.get("/", (_req, res) => {
  res.json({
    status: "healthy",
    timestamp: new Date().toISOString(),
    version: "0.1.0",
  });
});

healthRoutes.get("/ready", (_req, res) => {
  // TODO: Add actual readiness checks (DB, RPC, etc.)
  res.json({
    ready: true,
    checks: {
      database: true,
      rpc: true,
    },
  });
});
