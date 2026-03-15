import express from "express";
import pinoHttpImport from "pino-http";
import { eventsRouter } from "./routes/events.js";
import { healthRouter } from "./routes/health.js";
import { dlqRouter } from "./routes/dlq.js";
import { logger } from "./lib/logger.js";

const pinoHttp = pinoHttpImport as unknown as (typeof pinoHttpImport)["default"];

export function createApp() {
  const app = express();

  app.use(express.json({ limit: "2mb" }));
  app.use(
    pinoHttp({
      logger,
    }),
  );

  app.use(healthRouter);
  app.use(eventsRouter);
  app.use(dlqRouter);

  return app;
}
