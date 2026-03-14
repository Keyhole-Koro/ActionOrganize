import { Router } from "express";
import { env } from "../config/env.js";
import { listSupportedEventTypes } from "../agents/registry.js";

export const healthRouter = Router();

healthRouter.get("/healthz", (_req, res) => {
  res.status(200).json({
    ok: true,
    service: "organize",
    project: env.GOOGLE_CLOUD_PROJECT,
    pubsubEmulatorHost: env.PUBSUB_EMULATOR_HOST,
    supportedEventTypes: listSupportedEventTypes(),
  });
});
