import { Storage } from "@google-cloud/storage";
import { env } from "../config/env.js";

let storageInstance: Storage | undefined;

export function getStorage(): Storage {
  if (storageInstance) {
    return storageInstance;
  }

  storageInstance = new Storage({
    projectId: env.GOOGLE_CLOUD_PROJECT,
  });

  return storageInstance;
}
