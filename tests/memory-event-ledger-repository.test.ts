import { afterEach, describe, expect, it } from "vitest";
import { DuplicateEventError, TemporaryDependencyError } from "../src/core/errors.js";
import { type EventEnvelope } from "../src/models/envelope.js";
import {
  MemoryEventLedgerRepository,
  resetMemoryEventLedgerStore,
} from "../src/repositories/memory-event-ledger-repository.js";

function makeEnvelope(): EventEnvelope {
  return {
    schemaVersion: "1",
    type: "media.received",
    traceId: "trace-1",
    workspaceId: "ws-1",
    topicId: "topic-1",
    uid: "user-1",
    idempotencyKey: "idem-1",
    emittedAt: "2026-01-01T00:00:00Z",
    payload: {
      inputId: "in-1",
    },
  };
}

describe("MemoryEventLedgerRepository", () => {
  afterEach(() => {
    resetMemoryEventLedgerStore();
  });

  it("blocks concurrent reserve while started", async () => {
    const repo = new MemoryEventLedgerRepository();
    const envelope = makeEnvelope();

    await repo.reserve(envelope);

    await expect(repo.reserve(envelope)).rejects.toBeInstanceOf(TemporaryDependencyError);
  });

  it("allows retry after markFailed", async () => {
    const repo = new MemoryEventLedgerRepository();
    const envelope = makeEnvelope();

    await repo.reserve(envelope);
    await repo.markFailed(envelope.workspaceId, envelope.idempotencyKey, "ERR", "boom");

    await expect(repo.reserve(envelope)).resolves.toBeUndefined();
  });

  it("rejects duplicate after markSucceeded", async () => {
    const repo = new MemoryEventLedgerRepository();
    const envelope = makeEnvelope();

    await repo.reserve(envelope);
    await repo.markSucceeded(envelope.workspaceId, envelope.idempotencyKey);

    await expect(repo.reserve(envelope)).rejects.toBeInstanceOf(DuplicateEventError);
  });
});
