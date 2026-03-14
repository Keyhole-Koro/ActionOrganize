import { describe, it, expect, vi, beforeEach } from "vitest";
import type { EventEnvelope } from "../src/models/envelope.js";

const onBundleCreatedMock = vi.fn();
const onBundleDescribedMock = vi.fn();

vi.mock("../src/services/pipeline-write-service.js", () => ({
  PipelineWriteService: class {
    onBundleCreated = onBundleCreatedMock;
    onBundleDescribed = onBundleDescribedMock;

    async onDraftUpdated() {
      return { bundleId: "bundle:unused", schemaVersion: 1 };
    }

    async onOutlineUpdated() {}

    async onNodeRollupRequested() {}

    async onTopicSchemaUpdated() {}
  },
}));

function makeEnvelope(type: string, payload: Record<string, unknown>): EventEnvelope {
  return {
    schemaVersion: "1",
    type,
    traceId: "trace-1",
    workspaceId: "ws-1",
    topicId: "topic-1",
    idempotencyKey: `idem-${type}`,
    emittedAt: "2026-01-01T00:00:00+00:00",
    payload,
  };
}

describe("bundle handlers", () => {
  beforeEach(() => {
    onBundleCreatedMock.mockReset();
    onBundleDescribedMock.mockReset();
  });

  it("emits bundle.described with descRef from bundle.created", async () => {
    onBundleCreatedMock.mockResolvedValue({
      outlineVersion: 7,
      changedNodeIds: ["node-1"],
      descRef: "mind/bundle_desc/bundle-1/v7.html",
    });

    const { pipelineHandlers } = await import("../src/agents/handlers/pipeline-handlers.js");
    const handler = pipelineHandlers.find((h) => h.eventType === "bundle.created");
    expect(handler).toBeDefined();

    const envelope = makeEnvelope("bundle.created", {
      bundleId: "bundle-1",
      sourceDraftVersion: 7,
      inputId: "input-1",
    });

    const result = await handler!.handle({ envelope, attributes: {} });

    expect(onBundleCreatedMock).toHaveBeenCalledWith(envelope, "bundle-1", 7, "input-1");

    expect(result.emittedEvents[0]).toEqual({
      type: "bundle.described",
      topicId: "topic-1",
      idempotencyKey: "type:bundle.described/topicId:topic-1/bundleId:bundle-1",
      payload: {
        topicId: "topic-1",
        bundleId: "bundle-1",
        descRef: "mind/bundle_desc/bundle-1/v7.html",
      },
    });
  });

  it("persists descRef when handling bundle.described", async () => {
    onBundleDescribedMock.mockResolvedValue(undefined);

    const { pipelineHandlers } = await import("../src/agents/handlers/pipeline-handlers.js");
    const handler = pipelineHandlers.find((h) => h.eventType === "bundle.described");
    expect(handler).toBeDefined();

    const envelope = makeEnvelope("bundle.described", {
      bundleId: "bundle-9",
      descRef: "mind/bundle_desc/bundle-9/v9.html",
    });

    const result = await handler!.handle({ envelope, attributes: {} });

    expect(onBundleDescribedMock).toHaveBeenCalledWith(
      envelope,
      "bundle-9",
      "mind/bundle_desc/bundle-9/v9.html",
    );
    expect(result).toEqual({ ack: true, emittedEvents: [] });
  });

  it("emits atom.reissued when cleaner flags unresolved atoms", async () => {
    onBundleCreatedMock.mockResolvedValue({
      outlineVersion: 8,
      changedNodeIds: ["node-1"],
      descRef: "mind/bundle_desc/bundle-2/v8.html",
      reissuedAtomIds: ["atom-9"],
    });

    const { pipelineHandlers } = await import("../src/agents/handlers/pipeline-handlers.js");
    const handler = pipelineHandlers.find((h) => h.eventType === "bundle.created");
    expect(handler).toBeDefined();

    const envelope = makeEnvelope("bundle.created", {
      bundleId: "bundle-2",
      sourceDraftVersion: 8,
      inputId: "input-2",
    });

    const result = await handler!.handle({ envelope, attributes: {} });

    expect(result.emittedEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "atom.reissued",
          topicId: "topic-1",
          payload: expect.objectContaining({
            atomId: "atom-9",
            reason: "schema_incompatible_or_low_confidence",
          }),
        }),
      ]),
    );
  });
});
