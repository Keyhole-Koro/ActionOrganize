import { afterEach, describe, expect, it, vi } from "vitest";
import { getAgentHandler } from "../src/agents/registry.js";
import type { AgentContext } from "../src/agents/types.js";
import { TopicResolverService } from "../src/services/topic-resolver-service.js";

function makeContext(payload: Record<string, unknown> = {}): AgentContext {
  return {
    envelope: {
      schemaVersion: "1",
      type: "atom.created",
      traceId: "trace-1",
      workspaceId: "ws-1",
      topicId: "topic-hint",
      idempotencyKey: "idem-1",
      emittedAt: "2026-01-01T00:00:00+00:00",
      payload,
    },
    attributes: {
      type: "atom.created",
      schemaVersion: "1",
      workspaceId: "ws-1",
      topicId: "topic-hint",
    },
  };
}

describe("AtomCreatedHandler", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses TopicResolverService and emits resolved payload", async () => {
    const resolveSpy = vi.spyOn(TopicResolverService.prototype, "resolve").mockResolvedValue({
      resolvedTopicId: "tp-ai",
      resolutionMode: "existing",
      resolutionConfidence: 0.92,
      resolutionReason: "semantic match",
      topicLifecycleStateAtResolution: "active",
      candidateTopicIds: ["tp-ai", "tp-other"],
      candidateTopicStates: {
        "tp-ai": "active",
        "tp-other": "active",
      },
      shouldReview: false,
      scoreGap: 0.42,
    });

    const handler = getAgentHandler("atom.created");
    const result = await handler.handle(
      makeContext({
        inputId: "input-1",
        atomIds: ["a1", "a2"],
      }),
    );

    expect(resolveSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "atom.created",
        topicId: "topic-hint",
      }),
      "input-1",
      ["a1", "a2"],
    );
    expect(result).toEqual({
      ack: true,
      emittedEvents: [
        {
          type: "topic.resolved",
          topicId: "tp-ai",
          orderingKey: "tp-ai",
          idempotencyKey: "type:topic.resolved/topicId:tp-ai/inputId:input-1",
          payload: {
            resolvedTopicId: "tp-ai",
            inputId: "input-1",
            atomIds: ["a1", "a2"],
            resolutionMode: "existing",
            resolutionConfidence: 0.92,
            resolutionReason: "semantic match",
            topicLifecycleStateAtResolution: "active",
            candidateTopicIds: ["tp-ai", "tp-other"],
            candidateTopicStates: {
              "tp-ai": "active",
              "tp-other": "active",
            },
            shouldReview: false,
            scoreGap: 0.42,
          },
        },
      ],
    });
  });
});
