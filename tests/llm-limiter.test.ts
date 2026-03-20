import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { env } from "../src/config/env.js";
import {
  InMemoryLlmLimiterBackend,
  acquireLlmPermit,
  releaseLlmPermit,
  setLlmLimiterBackendForTests,
} from "../src/lib/llm-limiter.js";

describe("llm limiter", () => {
  let savedMaxConcurrency: number;
  let savedTargetRpm: number;
  let savedTargetTpm: number;

  beforeEach(() => {
    savedMaxConcurrency = env.LLM_LIMITER_MAX_CONCURRENCY;
    savedTargetRpm = env.LLM_LIMITER_TARGET_RPM;
    savedTargetTpm = env.LLM_LIMITER_TARGET_TPM;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    setLlmLimiterBackendForTests(null);
    env.LLM_LIMITER_MAX_CONCURRENCY = savedMaxConcurrency;
    env.LLM_LIMITER_TARGET_RPM = savedTargetRpm;
    env.LLM_LIMITER_TARGET_TPM = savedTargetTpm;
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

  it("denies when rpm limit is reached", async () => {
    // HEADROOM_RATIO=0.5: effective rpm = Math.max(1, floor(2*0.5)) = 1
    env.LLM_LIMITER_TARGET_RPM = 2;

    const backend = new InMemoryLlmLimiterBackend();
    setLlmLimiterBackendForTests(backend);

    const first = await acquireLlmPermit({
      model: "gemini-3-flash-preview",
      estimatedInputTokens: 10,
      reservedOutputTokens: 0,
      requestId: "req-rpm-1",
    });
    expect(first.granted).toBe(true);

    const second = await acquireLlmPermit({
      model: "gemini-3-flash-preview",
      estimatedInputTokens: 10,
      reservedOutputTokens: 0,
      requestId: "req-rpm-2",
    });
    expect(second.granted).toBe(false);
    expect(second.retryAfterMs).toBeGreaterThan(0);
  });

  it("denies when tpm limit is reached", async () => {
    // HEADROOM_RATIO=0.5: effective tpm = Math.max(1, floor(20*0.5)) = 10
    env.LLM_LIMITER_TARGET_TPM = 20;

    const backend = new InMemoryLlmLimiterBackend();
    setLlmLimiterBackendForTests(backend);

    // reservedTokens = estimatedInput(10) + reservedOutput(0) = 10; exactly fills tpm
    const first = await acquireLlmPermit({
      model: "gemini-3-flash-preview",
      estimatedInputTokens: 10,
      reservedOutputTokens: 0,
      requestId: "req-tpm-1",
    });
    expect(first.granted).toBe(true);

    const second = await acquireLlmPermit({
      model: "gemini-3-flash-preview",
      estimatedInputTokens: 10,
      reservedOutputTokens: 0,
      requestId: "req-tpm-2",
    });
    expect(second.granted).toBe(false);
    expect(second.retryAfterMs).toBeGreaterThan(0);
  });

  it("idempotent: same requestId is granted without consuming extra capacity", async () => {
    env.LLM_LIMITER_MAX_CONCURRENCY = 2; // effective = 1

    const backend = new InMemoryLlmLimiterBackend();
    setLlmLimiterBackendForTests(backend);

    const req = {
      model: "gemini-3-flash-preview",
      estimatedInputTokens: 10,
      reservedOutputTokens: 0,
      requestId: "req-idem",
    };

    const first = await acquireLlmPermit(req);
    expect(first.granted).toBe(true);

    // Same requestId should be granted without adding to inflight
    const second = await acquireLlmPermit(req);
    expect(second.granted).toBe(true);

    // A different requestId should still be denied (inflight=1, limit=1)
    const third = await acquireLlmPermit({ ...req, requestId: "req-idem-other" });
    expect(third.granted).toBe(false);
  });

  it("corrects tpm to actual tokens on release", async () => {
    // HEADROOM_RATIO=0.5: effective tpm = floor(20*0.5) = 10
    env.LLM_LIMITER_TARGET_TPM = 20;

    const backend = new InMemoryLlmLimiterBackend();
    setLlmLimiterBackendForTests(backend);

    // estimatedInputTokens=10 fills the tpm bucket to the limit
    await acquireLlmPermit({
      model: "gemini-3-flash-preview",
      estimatedInputTokens: 10,
      reservedOutputTokens: 0,
      requestId: "req-tpm-correct",
    });

    // Release with actual=2 tokens; tpm bucket corrects from 10 → 2
    await releaseLlmPermit({
      model: "gemini-3-flash-preview",
      requestId: "req-tpm-correct",
      actualInputTokens: 2,
      actualOutputTokens: 0,
      status: "ok",
    });

    // Now 8 more tokens fit (2 + 8 = 10 = effective limit)
    const result = await acquireLlmPermit({
      model: "gemini-3-flash-preview",
      estimatedInputTokens: 8,
      reservedOutputTokens: 0,
      requestId: "req-tpm-after",
    });
    expect(result.granted).toBe(true);
  });
});
