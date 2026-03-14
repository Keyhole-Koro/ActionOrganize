import { Router } from "express";
import { env } from "../config/env.js";
import { listSupportedEventTypes } from "../agents/registry.js";

export const healthRouter = Router();

healthRouter.get("/healthz", (_req, res) => {
  res.status(200).json({
    ok: true,
    service: "organize",
    project: env.GOOGLE_CLOUD_PROJECT,
    stateBackend: env.STATE_BACKEND,
    pubsubEmulatorHost: env.PUBSUB_EMULATOR_HOST,
    pubsubPublishEnabled: env.PUBSUB_PUBLISH_ENABLED,
    pubsubTopicName: env.PUBSUB_TOPIC_NAME,
    firestoreEmulatorHost: env.FIRESTORE_EMULATOR_HOST,
    supportedEventTypes: listSupportedEventTypes(),
  });
});
