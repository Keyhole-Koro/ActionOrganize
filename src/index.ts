import { createServer } from "node:http";
import { env } from "./config/env.js";
import { logger } from "./lib/logger.js";
import { createApp } from "./app.js";

const app = createApp();
const server = createServer(app);

server.listen(env.PORT, "0.0.0.0", () => {
  logger.info(
    {
      port: env.PORT,
      project: env.GOOGLE_CLOUD_PROJECT,
      pubsubEmulatorHost: env.PUBSUB_EMULATOR_HOST,
      firestoreEmulatorHost: env.FIRESTORE_EMULATOR_HOST,
      storageEmulatorHost: env.STORAGE_EMULATOR_HOST,
      vertexUseRealApi: env.VERTEX_USE_REAL_API,
    },
    "organize server started",
  );
});
