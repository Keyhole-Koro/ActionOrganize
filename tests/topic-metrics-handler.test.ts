import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EventEnvelope } from "../src/models/envelope.js";

const onTopicMetricsUpdatedMock = vi.fn();

vi.mock("../src/services/a5-balancer-service.js", () => ({
  A5BalancerService: class {
    onTopicMetricsUpdated = onTopicMetricsUpdatedMock;
  },
}));

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

describe("TopicMetricsUpdatedHandler", () => {
  beforeEach(() => {
    onTopicMetricsUpdatedMock.mockReset();
  });

  it("emits topic.node_changed for each balanced node", async () => {
    onTopicMetricsUpdatedMock.mockResolvedValue({
      topicId: "topic-9",
      nodeIds: ["node-1", "node-2"],
      generation: 5,
    });

    const { pipelineHandlers } = await import("../src/agents/handlers/pipeline-handlers.js");
    const handler = pipelineHandlers.find((h) => h.eventType === "topic.metrics.updated");
    expect(handler).toBeDefined();

    const envelope = makeEnvelope({ targetNodeIds: ["node-1", "node-2"] });
    const result = await handler!.handle({ envelope, attributes: {} });

    expect(onTopicMetricsUpdatedMock).toHaveBeenCalledWith(envelope);
    expect(result.emittedEvents).toEqual([
      {
        type: "topic.node_changed",
        topicId: "topic-9",
        orderingKey: "node-1",
        idempotencyKey: "type:topic.node_changed/topicId:topic-9/nodeId:node-1/generation:5",
        payload: {
          topicId: "topic-9",
          nodeId: "node-1",
          reason: "topic.metrics.updated",
          generation: 5,
        },
      },
      {
        type: "topic.node_changed",
        topicId: "topic-9",
        orderingKey: "node-2",
        idempotencyKey: "type:topic.node_changed/topicId:topic-9/nodeId:node-2/generation:5",
        payload: {
          topicId: "topic-9",
          nodeId: "node-2",
          reason: "topic.metrics.updated",
          generation: 5,
        },
      },
    ]);
  });
});
