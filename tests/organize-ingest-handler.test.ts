import { afterEach, describe, expect, it, vi } from "vitest";
import { getAgentHandler } from "../src/agents/registry.js";
import type { AgentContext } from "../src/agents/types.js";
import { A0A1WriteService } from "../src/services/a0-a1-write-service.js";

function makeContext(payload: Record<string, unknown>): AgentContext {
  return {
    envelope: {
      schemaVersion: "1",
      type: "organize.ingest.received",
      traceId: "trace-1",
      workspaceId: "ws-1",
      topicId: "topic-1",
      idempotencyKey: "idem-1",
      emittedAt: "2026-01-01T00:00:00+00:00",
      payload,
    },
    attributes: {
      type: "organize.ingest.received",
      schemaVersion: "1",
      workspaceId: "ws-1",
      topicId: "topic-1",
      inputId: "input-1",
      batchId: "batch-1",
      conversationId: "conv-1",
      threadId: "thread-1",
      chunkId: "chunk-1",
    },
  };
}

describe("OrganizeIngestReceivedHandler", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("bridges ingest job to canonical input.received", async () => {
    const writeSpy = vi
      .spyOn(A0A1WriteService.prototype, "onOrganizeIngestReceived")
      .mockResolvedValue();

    const handler = getAgentHandler("organize.ingest.received");
    const result = await handler.handle(
      makeContext({
        sourceType: "chat_history",
        batchId: "batch-1",
        conversationId: "conv-1",
        threadId: "thread-1",
        chunkId: "chunk-1",
        chunkIndex: 0,
        inputId: "input-1",
        estimatedInputTokens: 120,
        reservedOutputTokens: 512,
        priority: "normal",
        timeRange: {
          start: "2026-01-01T00:00:00+00:00",
          end: "2026-01-01T01:00:00+00:00",
        },
        messageIds: ["m1", "m2"],
        text: "hello world",
        assetRefs: [],
      }),
    );

    expect(writeSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "organize.ingest.received",
        topicId: "topic-1",
      }),
      expect.objectContaining({
        chunkId: "chunk-1",
        inputId: "input-1",
      }),
    );

    expect(result).toEqual({
      ack: true,
      emittedEvents: [
        {
          type: "input.received",
          topicId: "topic-1",
          idempotencyKey: "type:input.received/topicId:topic-1/chunkId:chunk-1",
          payload: {
            topicId: "topic-1",
            inputId: "input-1",
            text: "hello world",
            contentType: "text/plain",
            sourceType: "chat_history",
            batchId: "batch-1",
            conversationId: "conv-1",
            threadId: "thread-1",
            chunkId: "chunk-1",
            chunkIndex: 0,
            estimatedInputTokens: 120,
            reservedOutputTokens: 512,
            priority: "normal",
            timeRange: {
              start: "2026-01-01T00:00:00+00:00",
              end: "2026-01-01T01:00:00+00:00",
            },
            messageIds: ["m1", "m2"],
            assetRefs: [],
          },
        },
      ],
    });
  });
});
