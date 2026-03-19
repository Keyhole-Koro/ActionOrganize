import { Router } from "express";
import { env } from "../config/env.js";
import { listSupportedEventTypes } from "../agents/registry.js";

export const healthRouter = Router();

healthRouter.get("/healthz", (_req, res) => {
  res.status(200).json({
    ok: true,
    service: "organize",
    stateBackend: env.STATE_BACKEND,
    supportedEventTypes: listSupportedEventTypes(),
  });
});
