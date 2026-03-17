import { Storage } from "@google-cloud/storage";
import { env } from "../config/env.js";

let storageInstance: Storage | undefined;
const checkedBuckets = new Set<string>();

export function getStorage(): Storage {
  if (storageInstance) {
    return storageInstance;
  }

  storageInstance = new Storage({
    projectId: env.GOOGLE_CLOUD_PROJECT,
  });

  return storageInstance;
}

export async function assertBucketExists(bucketName: string): Promise<void> {
  if (checkedBuckets.has(bucketName)) {
    return;
  }

  const exists = env.STORAGE_EMULATOR_HOST
    ? await bucketExistsViaEmulator(bucketName)
    : (await getStorage().bucket(bucketName).exists())[0];
  if (!exists) {
    throw new Error(`Storage bucket ${bucketName} is required`);
  }

  checkedBuckets.add(bucketName);
}

async function bucketExistsViaEmulator(bucketName: string): Promise<boolean> {
  const baseUrl = env.STORAGE_EMULATOR_HOST.replace(/\/$/, "");
  const response = await fetch(`${baseUrl}/storage/v1/b/${encodeURIComponent(bucketName)}`);
  if (response.status === 404) {
    return false;
  }
  if (!response.ok) {
    throw new Error(`Storage bucket lookup failed with ${response.status}`);
  }
  return true;
}

export async function readMarkdown(path: string): Promise<string> {
  const bucket = getStorage().bucket(env.ORGANIZE_GCS_BUCKET);
  const file = bucket.file(path);
  const [content] = await file.download();
  return content.toString("utf-8");
}

export async function writeMarkdown(path: string, content: string): Promise<void> {
  const bucket = getStorage().bucket(env.ORGANIZE_GCS_BUCKET);
  const file = bucket.file(path);
  await file.save(content, {
    contentType: "text/markdown",
  });
}
