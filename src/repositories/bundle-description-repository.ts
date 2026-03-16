import { env } from "../config/env.js";
import { assertBucketExists, getStorage } from "../core/storage.js";

export class BundleDescriptionRepository {
  private readonly storage = getStorage();

  async writeHtml(path: string, html: string): Promise<string> {
    const bucket = this.storage.bucket(env.ORGANIZE_GCS_BUCKET);
    await assertBucketExists(env.ORGANIZE_GCS_BUCKET);
    await bucket.file(path).save(html, {
      contentType: "text/html; charset=utf-8",
      resumable: false,
    });
    return path;
  }

  async writeMarkdown(path: string, markdown: string): Promise<string> {
    const bucket = this.storage.bucket(env.ORGANIZE_GCS_BUCKET);
    await assertBucketExists(env.ORGANIZE_GCS_BUCKET);
    await bucket.file(path).save(markdown, {
      contentType: "text/markdown; charset=utf-8",
      resumable: false,
    });
    return path;
  }
}
