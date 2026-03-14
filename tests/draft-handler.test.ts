import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EventEnvelope } from "../src/models/envelope.js";

const onDraftUpdatedMock = vi.fn();

vi.mock("../src/services/pipeline-write-service.js", () => ({
  PipelineWriteService: class {
    onDraftUpdated = onDraftUpdatedMock;

    async onBundleCreated() {
      return { outlineVersion: 1, changedNodeIds: [], descRef: "x", reissuedAtomIds: [] };
    }

    async onBundleDescribed() {}

    async onOutlineUpdated() {}

    async onNodeRollupRequested() {
      return { topicId: "topic-1", nodeId: "node-1", skipped: false };
    }

    async onTopicSchemaUpdated() {}
  },
}));

function makeEnvelope(payload: Record<string, unknown>): EventEnvelope {
  return {
    schemaVersion: "1",
    type: "draft.updated",
    traceId: "trace-1",
    workspaceId: "ws-1",
    topicId: "topic-1",
    idempotencyKey: "idem-1",
    emittedAt: "2026-01-01T00:00:00+00:00",
    payload,
  };
}

describe("DraftUpdatedHandler", () => {
  beforeEach(() => {
    onDraftUpdatedMock.mockReset();
  });

  it("emits topic.schema_updated when proposed schema version increases", async () => {
    onDraftUpdatedMock.mockResolvedValue({ bundleId: "bundle-1", schemaVersion: 3 });

    const { pipelineHandlers } = await import("../src/agents/handlers/pipeline-handlers.js");
    const handler = pipelineHandlers.find((h) => h.eventType === "draft.updated");
    expect(handler).toBeDefined();

    const envelope = makeEnvelope({
      draftVersion: 7,
      appendedAtomIds: ["atom-1"],
      inputId: "input-1",
      proposedSchemaVersion: 4,
    });

    const result = await handler!.handle({ envelope, attributes: {} });

    expect(onDraftUpdatedMock).toHaveBeenCalledWith(envelope, 7, ["atom-1"], "input-1");
    expect(result.emittedEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "bundle.created",
          payload: expect.objectContaining({ bundleId: "bundle-1" }),
        }),
        {
          type: "topic.schema_updated",
          topicId: "topic-1",
          orderingKey: "topic-1",
          idempotencyKey: "type:topic.schema_updated/topicId:topic-1/schemaVersion:4",
          payload: {
            topicId: "topic-1",
            schemaVersion: 4,
          },
        },
      ]),
    );
  });

  it("does not emit topic.schema_updated when proposed schema does not increase", async () => {
    onDraftUpdatedMock.mockResolvedValue({ bundleId: "bundle-2", schemaVersion: 5 });

    const { pipelineHandlers } = await import("../src/agents/handlers/pipeline-handlers.js");
    const handler = pipelineHandlers.find((h) => h.eventType === "draft.updated");
    expect(handler).toBeDefined();

    const envelope = makeEnvelope({
      draftVersion: 8,
      appendedAtomIds: ["atom-2"],
      inputId: "input-2",
      proposedSchemaVersion: 5,
    });

    const result = await handler!.handle({ envelope, attributes: {} });

    expect(result.emittedEvents.some((e) => e.type === "topic.schema_updated")).toBe(false);
  });
});
