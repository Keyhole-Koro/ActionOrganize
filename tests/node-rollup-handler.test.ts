import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EventEnvelope } from "../src/models/envelope.js";

const onNodeRollupRequestedMock = vi.fn();

vi.mock("../src/services/pipeline-write-service.js", () => ({
  PipelineWriteService: class {
    onNodeRollupRequested = onNodeRollupRequestedMock;

    async onDraftUpdated() {
      return { bundleId: "bundle:unused", schemaVersion: 1 };
    }

    async onBundleCreated() {
      return { outlineVersion: 1, changedNodeIds: ["node-1"], descRef: "x", reissuedAtomIds: [] };
    }

    async onBundleDescribed() {}

    async onOutlineUpdated() {}

    async onTopicSchemaUpdated() {}
  },
}));

function makeEnvelope(payload: Record<string, unknown>): EventEnvelope {
  return {
    schemaVersion: "1",
    type: "node.rollup_requested",
    traceId: "trace-1",
    workspaceId: "ws-1",
    topicId: "topic-1",
    idempotencyKey: "idem-1",
    emittedAt: "2026-01-01T00:00:00+00:00",
    payload,
  };
}

describe("NodeRollupRequestedHandler", () => {
  beforeEach(() => {
    onNodeRollupRequestedMock.mockReset();
  });

  it("emits node.rollup.updated after rollup generation", async () => {
    onNodeRollupRequestedMock.mockResolvedValue({
      topicId: "topic-1",
      nodeId: "node-42",
    });

    const { pipelineHandlers } = await import("../src/agents/handlers/pipeline-handlers.js");
    const handler = pipelineHandlers.find((h) => h.eventType === "node.rollup_requested");
    expect(handler).toBeDefined();

    const envelope = makeEnvelope({ nodeId: "node-42", generation: 3 });
    const result = await handler!.handle({ envelope, attributes: {} });

    expect(onNodeRollupRequestedMock).toHaveBeenCalledWith(envelope, "node-42", 3);
    expect(result.emittedEvents).toEqual([
      {
        type: "node.rollup.updated",
        topicId: "topic-1",
        idempotencyKey: "type:node.rollup.updated/topicId:topic-1/nodeId:node-42/generation:3",
        payload: {
          topicId: "topic-1",
          nodeId: "node-42",
        },
      },
    ]);
  });
});
