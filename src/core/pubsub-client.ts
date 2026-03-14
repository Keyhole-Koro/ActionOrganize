import { PubSub } from "@google-cloud/pubsub";
import { env } from "../config/env.js";

let pubsubInstance: PubSub | undefined;

export function getPubsub(): PubSub {
  if (pubsubInstance) {
    return pubsubInstance;
  }

  pubsubInstance = new PubSub({
    projectId: env.GOOGLE_CLOUD_PROJECT,
  });

  return pubsubInstance;
}
