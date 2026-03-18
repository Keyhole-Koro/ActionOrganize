import { Storage } from "@google-cloud/storage";
import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";

let storageInstance: Storage | undefined;
const checkedBuckets = new Set<string>();

export function getStorage(): Storage {
  if (storageInstance) {
    return storageInstance;
  }

  const options: any = {
    projectId: env.GOOGLE_CLOUD_PROJECT,
  };

  if (env.STORAGE_EMULATOR_HOST) {
    options.apiEndpoint = env.STORAGE_EMULATOR_HOST;
    options.credentials = { client_email: "dummy@example.com", private_key: "dummy" };
  }

  storageInstance = new Storage(options);

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
  try {
    const response = await fetch(`${baseUrl}/storage/v1/b/${encodeURIComponent(bucketName)}`);
    if (response.status === 404) {
      return false;
    }
    if (!response.ok) {
      throw new Error(`Storage bucket lookup failed with ${response.status}`);
    }
    return true;
  } catch (error) {
    logger.warn({ error, bucketName }, "failed to check bucket existence via emulator");
    return false;
  }
}

export async function readMarkdown(path: string): Promise<string> {
  const bucket = getStorage().bucket(env.ORGANIZE_GCS_BUCKET);
  const file = bucket.file(path);
  try {
    const [content] = await file.download();
    return content.toString("utf-8");
  } catch (error) {
    throw new Error(`Failed to read markdown from GCS: ${path}. Error: ${error instanceof Error ? error.message : "unknown"}`);
  }
}

/** Read raw bytes from any gs://bucket/path URI. */
export async function readFromGcsUri(uri: string): Promise<Buffer> {
  const match = uri.match(/^gs:\/\/([^/]+)\/(.+)$/);
  if (!match) throw new Error(`Invalid GCS URI: ${uri}`);
  const [, bucketName, path] = match;
  try {
    const [content] = await getStorage().bucket(bucketName).file(path).download();
    return content;
  } catch (error) {
    throw new Error(`Failed to read from GCS URI: ${uri}. Error: ${error instanceof Error ? error.message : "unknown"}`);
  }
}

export async function writeMarkdown(path: string, content: string): Promise<void> {
  const bucket = getStorage().bucket(env.ORGANIZE_GCS_BUCKET);
  const file = bucket.file(path);
  await file.save(content, {
    contentType: "text/markdown",
    resumable: false,
  });
}
