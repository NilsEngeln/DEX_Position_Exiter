import { Request, Response, NextFunction } from "express";
import { logger } from "../utils/logger.js";

export interface ApiError extends Error {
  statusCode?: number;
  code?: string;
}

export function errorHandler(
  err: ApiError,
  _req: Request,
  res: Response,
  _next: NextFunction
): void {
  const statusCode = err.statusCode || 500;
  const message = err.message || "Internal Server Error";

  logger.error("API Error", {
    statusCode,
    message,
    code: err.code,
    stack: err.stack,
  });

  res.status(statusCode).json({
    error: statusCode === 500 ? "Internal Server Error" : message,
    code: err.code,
    ...(process.env.NODE_ENV === "development" && { stack: err.stack }),
  });
}
