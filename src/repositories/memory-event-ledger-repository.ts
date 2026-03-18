import { createHash } from "node:crypto";
import { DuplicateEventError, EventInProgressError } from "../core/errors.js";
import type { EventEnvelope } from "../models/envelope.js";
import type { EventLedgerPort } from "./contracts.js";

type LedgerStatus = {
  status: "started" | "succeeded" | "failed";
  errorCode?: string;
  errorMessage?: string;
};

const store = new Map<string, LedgerStatus>();

function ledgerKey(workspaceId: string, idempotencyKey: string) {
  return `${workspaceId}:${createHash("sha256").update(idempotencyKey).digest("hex")}`;
}

export class MemoryEventLedgerRepository implements EventLedgerPort {
  async reserve(envelope: EventEnvelope): Promise<void> {
    const key = ledgerKey(envelope.workspaceId, envelope.idempotencyKey);
    const current = store.get(key);
    if (current?.status === "succeeded") {
      throw new DuplicateEventError("event already processed");
    }
    if (current?.status === "started") {
      throw new EventInProgressError("event is already in progress");
    }
    store.set(key, { status: "started" });
  }

  async markSucceeded(workspaceId: string, idempotencyKey: string): Promise<void> {
    store.set(ledgerKey(workspaceId, idempotencyKey), { status: "succeeded" });
  }

  async markFailed(
    workspaceId: string,
    idempotencyKey: string,
    errorCode: string,
    errorMessage: string,
  ): Promise<void> {
    store.set(ledgerKey(workspaceId, idempotencyKey), {
      status: "failed",
      errorCode,
      errorMessage,
    });
  }
}

export function resetMemoryEventLedgerStore() {
  store.clear();
}
