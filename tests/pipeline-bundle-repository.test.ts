import { Timestamp } from "@google-cloud/firestore";
import { afterEach, describe, expect, it } from "vitest";
import { PipelineBundleRepository } from "../src/repositories/pipeline-bundle-repository.js";

const repository = new PipelineBundleRepository();
const workspaceId = "ws-bundle-repo";
const topicId = "topic-locks";

async function deleteBundle(bundleId: string) {
  await repository.docRef(workspaceId, topicId, bundleId).delete();
}

describe("PipelineBundleRepository.tryStartApply", () => {
  const createdBundleIds: string[] = [];

  afterEach(async () => {
    await Promise.all(createdBundleIds.splice(0).map((bundleId) => deleteBundle(bundleId)));
  });

  it("rejects lock acquisition when applying lock is still fresh", async () => {
    const bundleId = `bundle-fresh-${Date.now()}`;
    createdBundleIds.push(bundleId);

    await repository.docRef(workspaceId, topicId, bundleId).set({
      bundleId,
      topicId,
      sourceDraftVersion: 1,
      schemaVersion: 1,
      atomCount: 0,
      bundleStatus: "applying",
      applyingAt: Timestamp.fromMillis(Date.now() - 100),
      applyingTraceId: "trace-old",
    });

    const acquired = await repository.tryStartApply(
      workspaceId,
      topicId,
      bundleId,
      "trace-new",
      60000,
    );

    expect(acquired).toBe(false);

    const snapshot = await repository.docRef(workspaceId, topicId, bundleId).get();
    expect(snapshot.get("applyingTraceId")).toBe("trace-old");
    expect(snapshot.get("bundleStatus")).toBe("applying");
  });

  it("reacquires lock when applying lock is stale", async () => {
    const bundleId = `bundle-stale-${Date.now()}`;
    createdBundleIds.push(bundleId);

    await repository.docRef(workspaceId, topicId, bundleId).set({
      bundleId,
      topicId,
      sourceDraftVersion: 1,
      schemaVersion: 1,
      atomCount: 0,
      bundleStatus: "applying",
      applyingAt: Timestamp.fromMillis(Date.now() - 5000),
      applyingTraceId: "trace-old",
    });

    const acquired = await repository.tryStartApply(
      workspaceId,
      topicId,
      bundleId,
      "trace-new",
      1000,
    );

    expect(acquired).toBe(true);

    const snapshot = await repository.docRef(workspaceId, topicId, bundleId).get();
    expect(snapshot.get("applyingTraceId")).toBe("trace-new");
    expect(snapshot.get("bundleStatus")).toBe("applying");
  });

  it("returns structured applyError from snapshot", async () => {
    const bundleId = `bundle-error-${Date.now()}`;
    createdBundleIds.push(bundleId);

    await repository.docRef(workspaceId, topicId, bundleId).set({
      bundleId,
      topicId,
      sourceDraftVersion: 2,
      schemaVersion: 3,
      atomCount: 1,
      bundleStatus: "error",
      applyError: {
        code: "artifact_write_failed",
        message: "gcs unavailable",
      },
    });

    const snapshot = await repository.get(workspaceId, topicId, bundleId);

    expect(snapshot).toMatchObject({
      bundleId,
      bundleStatus: "error",
      applyError: {
        code: "artifact_write_failed",
        message: "gcs unavailable",
      },
    });
  });

  it("retries from error status and clears previous applyError", async () => {
    const bundleId = `bundle-retry-${Date.now()}`;
    createdBundleIds.push(bundleId);

    await repository.docRef(workspaceId, topicId, bundleId).set({
      bundleId,
      topicId,
      sourceDraftVersion: 3,
      schemaVersion: 4,
      atomCount: 2,
      bundleStatus: "error",
      applyError: {
        code: "artifact_write_failed",
        message: "gcs unavailable",
      },
    });

    const acquired = await repository.tryStartApply(
      workspaceId,
      topicId,
      bundleId,
      "trace-retry",
      1000,
    );

    expect(acquired).toBe(true);

    const snapshot = await repository.get(workspaceId, topicId, bundleId);
    expect(snapshot).toMatchObject({
      bundleId,
      bundleStatus: "applying",
    });
    expect(snapshot?.applyError).toBeUndefined();
  });
});