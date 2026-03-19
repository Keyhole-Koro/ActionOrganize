import { describe, expect, it, vi, afterEach } from "vitest";
import { env } from "../src/config/env.js";
import {
  InMemoryLlmLimiterBackend,
  acquireLlmPermit,
  releaseLlmPermit,
  setLlmLimiterBackendForTests,
} from "../src/lib/llm-limiter.js";

describe("llm limiter", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    setLlmLimiterBackendForTests(null);
    env.LLM_LIMITER_MAX_CONCURRENCY = 50;
  });

  it("grants a permit within limits", async () => {
    setLlmLimiterBackendForTests(new InMemoryLlmLimiterBackend());

    const result = await acquireLlmPermit({
      model: "gemini-3-flash-preview",
      estimatedInputTokens: 100,
      reservedOutputTokens: 100,
      requestId: "req-1",
    });

    expect(result).toEqual({ granted: true });
  });

  it("denies when concurrency is exceeded", async () => {
    env.LLM_LIMITER_MAX_CONCURRENCY = 1;

    const backend = new InMemoryLlmLimiterBackend();
    setLlmLimiterBackendForTests(backend);

    await acquireLlmPermit({
      model: "gemini-3-flash-preview",
      estimatedInputTokens: 10,
      reservedOutputTokens: 10,
      requestId: "req-1",
    });

    const result = await acquireLlmPermit({
      model: "gemini-3-flash-preview",
      estimatedInputTokens: 10,
      reservedOutputTokens: 10,
      requestId: "req-2",
    });

    expect(result.granted).toBe(false);
    expect(result.retryAfterMs).toBeGreaterThan(0);
  });

  it("releases inflight capacity", async () => {
    env.LLM_LIMITER_MAX_CONCURRENCY = 2;

    const backend = new InMemoryLlmLimiterBackend();
    setLlmLimiterBackendForTests(backend);

    await acquireLlmPermit({
      model: "gemini-3-flash-preview",
      estimatedInputTokens: 10,
      reservedOutputTokens: 10,
      requestId: "req-1",
    });

    await releaseLlmPermit({
      model: "gemini-3-flash-preview",
      requestId: "req-1",
      actualInputTokens: 8,
      actualOutputTokens: 5,
      status: "ok",
    });

    const result = await acquireLlmPermit({
      model: "gemini-3-flash-preview",
      estimatedInputTokens: 10,
      reservedOutputTokens: 10,
      requestId: "req-2",
    });

    expect(result.granted).toBe(true);
  });
});
