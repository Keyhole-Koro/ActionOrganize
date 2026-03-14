import { afterEach, describe, expect, it, vi } from "vitest";
import { env } from "../src/config/env.js";
import { TemporaryDependencyError } from "../src/core/errors.js";
import type { EventEnvelope } from "../src/models/envelope.js";
import { TopicResolverService } from "../src/services/topic-resolver-service.js";

function makeEnvelope(payload: Record<string, unknown> = {}): EventEnvelope {
  return {
    schemaVersion: "1",
    type: "atom.created",
    traceId: "trace-1",
    workspaceId: "ws-1",
    topicId: "topic-hint",
    idempotencyKey: "idem-1",
    emittedAt: "2026-01-01T00:00:00+00:00",
    payload,
  };
}

describe("TopicResolverService", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    env.VERTEX_USE_REAL_API = false;
    env.GEMINI_API_KEY = undefined;
  });

  it("uses deterministic resolution when real API is disabled", async () => {
    env.VERTEX_USE_REAL_API = false;

    const service = new TopicResolverService();
    (
      service as unknown as {
        topicRepository: { listCandidates: (workspaceId: string, limit: number) => Promise<unknown[]> };
        atomRepository: { getByIds: () => Promise<unknown[]> };
      }
    ).topicRepository = {
      listCandidates: vi.fn().mockResolvedValue([
        { topicId: "tp-ai", title: "AI architecture", status: "active" },
        { topicId: "tp-music", title: "music theory", status: "active" },
      ]),
    };
    (
      service as unknown as {
        atomRepository: { getByIds: () => Promise<unknown[]> };
      }
    ).atomRepository = {
      getByIds: vi.fn().mockResolvedValue([{ title: "design", claim: "AI architecture" }]),
    };

    const result = await service.resolve(makeEnvelope({ text: "AI architecture design" }), "input-1", ["a1"]);

    expect(result.resolutionMode).toBe("existing");
    expect(result.resolvedTopicId).toBe("tp-ai");
  });

  it("uses Gemini decision when real API is enabled", async () => {
    env.VERTEX_USE_REAL_API = true;
    env.GEMINI_API_KEY = "dummy-key";

    const service = new TopicResolverService();
    (
      service as unknown as {
        topicRepository: { listCandidates: () => Promise<unknown[]> };
        atomRepository: { getByIds: () => Promise<unknown[]> };
      }
    ).topicRepository = {
      listCandidates: vi.fn().mockResolvedValue([
        { topicId: "tp-1", title: "Product strategy", status: "active" },
        { topicId: "tp-2", title: "Backend APIs", status: "active" },
      ]),
    };
    (
      service as unknown as {
        atomRepository: { getByIds: () => Promise<unknown[]> };
      }
    ).atomRepository = {
      getByIds: vi.fn().mockResolvedValue([{ title: "strategy", claim: "product roadmap" }]),
    };

    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        candidates: [
          {
            content: {
              parts: [
                {
                  text: JSON.stringify({
                    decision: "attach_existing",
                    resolvedTopicId: "tp-1",
                    confidence: 0.91,
                    reason: "same target and long-lived scope",
                  }),
                },
              ],
            },
          },
        ],
      }),
    } as Response);

    const result = await service.resolve(makeEnvelope({ text: "product roadmap planning" }), "input-2", ["a2"]);

    expect(fetchMock).toHaveBeenCalled();
    expect(result.resolutionMode).toBe("existing");
    expect(result.resolvedTopicId).toBe("tp-1");
    expect(result.resolutionConfidence).toBe(0.91);
  });

  it("throws retryable error when Gemini request fails", async () => {
    env.VERTEX_USE_REAL_API = true;
    env.GEMINI_API_KEY = "dummy-key";

    const service = new TopicResolverService();
    (
      service as unknown as {
        topicRepository: { listCandidates: () => Promise<unknown[]> };
        atomRepository: { getByIds: () => Promise<unknown[]> };
      }
    ).topicRepository = {
      listCandidates: vi.fn().mockResolvedValue([{ topicId: "tp-1", title: "Topic 1", status: "active" }]),
    };
    (
      service as unknown as {
        atomRepository: { getByIds: () => Promise<unknown[]> };
      }
    ).atomRepository = {
      getByIds: vi.fn().mockResolvedValue([{ title: "x", claim: "y" }]),
    };

    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));

    await expect(service.resolve(makeEnvelope({ text: "anything" }), "input-3", ["a3"])).rejects.toBeInstanceOf(
      TemporaryDependencyError,
    );
  });
});
