import { env } from "../config/env.js";
import { getStorage } from "../core/storage.js";

export class BundleDescriptionRepository {
  private readonly storage = getStorage();
  private bucketReady = false;

  async writeHtml(path: string, html: string): Promise<string> {
    const bucket = this.storage.bucket(env.ORGANIZE_GCS_BUCKET);
    await this.ensureBucket(bucket);
    await bucket.file(path).save(html, {
      contentType: "text/html; charset=utf-8",
      resumable: false,
    });
    return path;
  }

  private async ensureBucket(bucket: ReturnType<Storage["bucket"]>) {
    if (this.bucketReady) {
      return;
    }

    const [exists] = await bucket.exists();
    if (!exists) {
      await bucket.create();
    }
    this.bucketReady = true;
  }
}
