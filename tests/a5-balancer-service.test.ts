import { beforeEach, describe, expect, it, vi } from "vitest";
import { A5BalancerService } from "../src/services/a5-balancer-service.js";
import type { EventEnvelope } from "../src/models/envelope.js";

function makeEnvelope(payload: Record<string, unknown>): EventEnvelope {
  return {
    schemaVersion: "1",
    type: "topic.metrics.updated",
    traceId: "trace-1",
    workspaceId: "ws-1",
    topicId: "topic-1",
    idempotencyKey: "idem-1",
    emittedAt: "2026-01-01T00:00:00+00:00",
    payload,
  };
}

describe("A5BalancerService", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("selects targetNodeIds and persists organize op", async () => {
    const service = new A5BalancerService();
    const upsert = vi.fn().mockResolvedValue(undefined);

    (
      service as unknown as {
        organizeOpRepository: { upsert: typeof upsert };
      }
    ).organizeOpRepository = { upsert };

    const result = await service.onTopicMetricsUpdated(
      makeEnvelope({
        topicId: "topic-77",
        targetNodeIds: ["node-a", "node-b", "node-a"],
        generation: 8,
        maxNodes: 2,
      }),
    );

    expect(result).toEqual({
      topicId: "topic-77",
      nodeIds: ["node-a", "node-b"],
      generation: 8,
      metrics: {
        imbalance: 0,
        unresolvedRate: 0,
        redundancy: 0,
      },
    });

    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "ws-1",
        topicId: "topic-77",
        opType: "rebalance",
        nodeIds: ["node-a", "node-b"],
        generation: 8,
      }),
    );
  });

  it("falls back to root node when payload has no candidates", async () => {
    const service = new A5BalancerService();
    const upsert = vi.fn().mockResolvedValue(undefined);

    (
      service as unknown as {
        organizeOpRepository: { upsert: typeof upsert };
      }
    ).organizeOpRepository = { upsert };

    const result = await service.onTopicMetricsUpdated(makeEnvelope({}));

    expect(result.nodeIds).toEqual(["node:topic-1:root"]);
    expect(result.generation).toBe(1);
  });
});
