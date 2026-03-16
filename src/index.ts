import { createServer } from "node:http";
import { env } from "./config/env.js";
import { assertBucketExists } from "./core/storage.js";
import { logger } from "./lib/logger.js";
import { createApp } from "./app.js";

const app = createApp();
const server = createServer(app);

void (async () => {
  await assertBucketExists(env.ORGANIZE_GCS_BUCKET);

  server.listen(env.PORT, "0.0.0.0", () => {
    logger.info(
      {
        port: env.PORT,
        project: env.GOOGLE_CLOUD_PROJECT,
        stateBackend: env.STATE_BACKEND,
        pubsubEmulatorHost: env.PUBSUB_EMULATOR_HOST,
        pubsubTopicName: env.PUBSUB_TOPIC_NAME,
        pubsubPublishEnabled: env.PUBSUB_PUBLISH_ENABLED,
        firestoreEmulatorHost: env.FIRESTORE_EMULATOR_HOST,
        storageEmulatorHost: env.STORAGE_EMULATOR_HOST,
        organizeGcsBucket: env.ORGANIZE_GCS_BUCKET,
        leaseTtlSeconds: env.LEASE_TTL_SECONDS,
        vertexUseRealApi: env.VERTEX_USE_REAL_API,
      },
      "organize server started",
    );
  });
})().catch((error) => {
  logger.error(
    {
      error: error instanceof Error ? error.message : "unknown error",
      organizeGcsBucket: env.ORGANIZE_GCS_BUCKET,
    },
    "organize startup failed",
  );
  process.exit(1);
});
