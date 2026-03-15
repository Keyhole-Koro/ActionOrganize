import { describe, it, expect, vi } from "vitest";
import { PipelineWriteService } from "../src/services/pipeline-write-service.js";
import { TemporaryDependencyError } from "../src/core/errors.js";
import type { EventEnvelope } from "../src/models/envelope.js";

function makeEnvelope(type: string): EventEnvelope {
  return {
    schemaVersion: "1",
    type,
    traceId: "trace-1",
    workspaceId: "ws-1",
    topicId: "topic-1",
    idempotencyKey: `idem-${type}`,
    emittedAt: "2026-01-01T00:00:00+00:00",
    payload: {},
  };
}

describe("PipelineWriteService.onBundleDescribed", () => {
  it("writes described status to repository on firestore backend", async () => {
    const service = new PipelineWriteService();
    const markDescribed = vi.fn().mockResolvedValue(undefined);

    (service as unknown as { bundleRepository: { markDescribed: typeof markDescribed } }).bundleRepository = {
      markDescribed,
    };

    await service.onBundleDescribed(
      makeEnvelope("bundle.described"),
      "bundle-1",
      "mind/bundle_desc/bundle-1/v1.html",
    );

    expect(markDescribed).toHaveBeenCalledWith(
      "ws-1",
      "topic-1",
      "bundle-1",
      "mind/bundle_desc/bundle-1/v1.html",
    );
  });

  it("is no-op when backend check returns false", async () => {
    const service = new PipelineWriteService();
    const markDescribed = vi.fn().mockResolvedValue(undefined);

    (
      service as unknown as {
        bundleRepository: { markDescribed: typeof markDescribed };
        isFirestoreBackend: () => boolean;
      }
    ).bundleRepository = { markDescribed };

    (service as unknown as { isFirestoreBackend: () => boolean }).isFirestoreBackend = () => false;

    await service.onBundleDescribed(
      makeEnvelope("bundle.described"),
      "bundle-2",
      "mind/bundle_desc/bundle-2/v2.html",
    );

    expect(markDescribed).not.toHaveBeenCalled();
  });
});

describe("PipelineWriteService.onBundleCreated", () => {
  it("throws TemporaryDependencyError when bundle description write fails", async () => {
    const service = new PipelineWriteService();
    const get = vi.fn().mockResolvedValue(null);
    const tryStartApply = vi.fn().mockResolvedValue(true);
    const markApplyFailed = vi.fn().mockResolvedValue(undefined);
    const writeHtml = vi.fn().mockRejectedValue(new Error("gcs unavailable"));

    (
      service as unknown as {
        bundleRepository: {
          get: typeof get;
          tryStartApply: typeof tryStartApply;
          markApplyFailed: typeof markApplyFailed;
        };
        bundleDescriptionRepository: { writeHtml: typeof writeHtml };
      }
    ).bundleRepository = { get, tryStartApply, markApplyFailed };

    (
      service as unknown as {
        bundleDescriptionRepository: { writeHtml: typeof writeHtml };
      }
    ).bundleDescriptionRepository = { writeHtml };

    const promise = service.onBundleCreated(
      makeEnvelope("bundle.created"),
      "bundle-1",
      1,
      "input-1",
    );

    await expect(promise).rejects.toBeInstanceOf(TemporaryDependencyError);
    expect(tryStartApply).toHaveBeenCalledWith("ws-1", "topic-1", "bundle-1", "trace-1", 120000);
    expect(markApplyFailed).toHaveBeenCalledWith(
      "ws-1",
      "topic-1",
      "bundle-1",
      "artifact_write_failed",
      "gcs unavailable",
    );
  });

  it("returns no-op when apply reservation cannot be acquired", async () => {
    const service = new PipelineWriteService();
    const get = vi.fn().mockResolvedValue(null);
    const tryStartApply = vi.fn().mockResolvedValue(false);

    (
      service as unknown as {
        bundleRepository: { get: typeof get; tryStartApply: typeof tryStartApply };
      }
    ).bundleRepository = { get, tryStartApply };

    const result = await service.onBundleCreated(
      makeEnvelope("bundle.created"),
      "bundle-2",
      2,
      "input-2",
    );

    expect(result).toEqual({
      outlineVersion: 2,
      changedNodeIds: [],
      descRef: "mind/bundle_desc/bundle-2/v2.html",
      reissuedAtomIds: [],
    });
  });
});

describe("PipelineWriteService hierarchy planning", () => {
  it("groups claims into deterministic cluster and subcluster nodes", () => {
    const service = new PipelineWriteService() as unknown as {
      deriveClusterTitle: (title: string, claim: string) => string;
      deriveSubclusterTitle: (clusterTitle: string, title: string, claim: string) => string;
      toStableSlug: (value: string) => string;
      toClusterNodeId: (topicId: string, clusterSlug: string) => string;
      toSubclusterNodeId: (topicId: string, clusterSlug: string, subclusterSlug: string) => string;
      buildHierarchyPlan: (candidates: Array<{
        nodeId: string;
        title: string;
        clusterNodeId: string;
        clusterTitle: string;
        subclusterNodeId: string;
        subclusterTitle: string;
      }>) => {
        clusters: Array<{
          clusterNodeId: string;
          clusterTitle: string;
          subclusters: Array<{
            subclusterNodeId: string;
            subclusterTitle: string;
            claims: Array<{ nodeId: string; title: string }>;
          }>;
        }>;
      };
    };

    const clusterTitle = service.deriveClusterTitle(
      "Refresh token rotation is missing",
      "Token lifecycle policy is incomplete",
    );
    const subclusterTitle = service.deriveSubclusterTitle(
      clusterTitle,
      "Refresh token rotation is missing",
      "Token lifecycle policy is incomplete",
    );
    const clusterSlug = service.toStableSlug(clusterTitle);
    const subclusterSlug = service.toStableSlug(subclusterTitle);
    const clusterNodeId = service.toClusterNodeId("topic-1", clusterSlug);
    const subclusterNodeId = service.toSubclusterNodeId("topic-1", clusterSlug, subclusterSlug);

    const plan = service.buildHierarchyPlan([
      {
        nodeId: "node:topic-1:atom:a1",
        title: "Refresh token rotation is missing",
        clusterNodeId,
        clusterTitle,
        subclusterNodeId,
        subclusterTitle,
      },
      {
        nodeId: "node:topic-1:atom:a2",
        title: "Token TTL is not enforced",
        clusterNodeId,
        clusterTitle,
        subclusterNodeId,
        subclusterTitle,
      },
    ]);

    expect(plan.clusters).toHaveLength(1);
    expect(plan.clusters[0]).toMatchObject({
      clusterNodeId,
      clusterTitle,
    });
    expect(plan.clusters[0].subclusters).toHaveLength(1);
    expect(plan.clusters[0].subclusters[0]).toMatchObject({
      subclusterNodeId,
      subclusterTitle,
    });
    expect(plan.clusters[0].subclusters[0].claims.map((claim) => claim.nodeId)).toEqual([
      "node:topic-1:atom:a1",
      "node:topic-1:atom:a2",
    ]);
  });
});
