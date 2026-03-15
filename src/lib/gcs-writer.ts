import type { Bucket } from "@google-cloud/storage";
import { env } from "../config/env.js";
import { getStorage } from "../core/storage.js";

let bucketReady = false;
const storage = getStorage();

async function ensureBucket(bucket: Bucket) {
    if (bucketReady) return;
    const [exists] = await bucket.exists();
    if (!exists) {
        await bucket.create();
    }
    bucketReady = true;
}

function getBucket() {
    return storage.bucket(env.ORGANIZE_GCS_BUCKET);
}

export async function writeText(
    path: string,
    content: string,
    contentType = "text/plain; charset=utf-8",
): Promise<string> {
    const bucket = getBucket();
    await ensureBucket(bucket);
    await bucket.file(path).save(content, {
        contentType,
        resumable: false,
    });
    return path;
}

export async function readText(path: string): Promise<string | null> {
    const bucket = getBucket();
    await ensureBucket(bucket);
    const file = bucket.file(path);
    const [exists] = await file.exists();
    if (!exists) return null;
    const [buffer] = await file.download();
    return buffer.toString("utf-8");
}

export async function writeMarkdown(path: string, content: string): Promise<string> {
    return writeText(path, content, "text/markdown; charset=utf-8");
}

export async function writeHtml(path: string, content: string): Promise<string> {
    return writeText(path, content, "text/html; charset=utf-8");
}
