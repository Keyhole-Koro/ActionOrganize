import { createHash } from "node:crypto";
import { FieldValue } from "@google-cloud/firestore";
import { DuplicateEventError, TemporaryDependencyError } from "../core/errors.js";
import { getFirestore } from "../core/firestore.js";
import type { EventEnvelope } from "../models/envelope.js";
import type { EventLedgerPort } from "./contracts.js";

export class EventLedgerRepository implements EventLedgerPort {
  private readonly firestore = getFirestore();

  private docRef(workspaceId: string, idempotencyKey: string) {
    const ledgerId = createHash("sha256").update(idempotencyKey).digest("hex");
    return this.firestore.doc(`workspaces/${workspaceId}/eventLedger/${ledgerId}`);
  }

  async reserve(envelope: EventEnvelope, agentName: string) {
    const ref = this.docRef(envelope.workspaceId, envelope.idempotencyKey);

    await this.firestore.runTransaction(async (tx) => {
      const snapshot = await tx.get(ref);
      if (snapshot.exists) {
        const data = snapshot.data();
        if (data?.status === "succeeded") {
          throw new DuplicateEventError("event already processed");
        }
        throw new TemporaryDependencyError("event is already in progress");
      }

      tx.create(ref, {
        agent: agentName,
        topicId: envelope.topicId,
        type: envelope.type,
        traceId: envelope.traceId,
        idempotencyKeyHash: createHash("sha256").update(envelope.idempotencyKey).digest("hex"),
        status: "started",
        startedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
    });

    return ref;
  }

  async markSucceeded(workspaceId: string, idempotencyKey: string) {
    await this.docRef(workspaceId, idempotencyKey).set(
      {
        status: "succeeded",
        finishedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
  }

  async markFailed(workspaceId: string, idempotencyKey: string, errorCode: string, errorMessage: string) {
    await this.docRef(workspaceId, idempotencyKey).set(
      {
        status: "failed",
        errorCode,
        errorMessage,
        finishedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
  }
}
