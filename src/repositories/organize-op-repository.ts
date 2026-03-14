import { FieldValue } from "@google-cloud/firestore";
import { getFirestore } from "../core/firestore.js";

export type OrganizeOpRecord = {
  workspaceId: string;
  topicId: string;
  opId: string;
  opType: "rebalance";
  sourceEventType: string;
  traceId: string;
  idempotencyKey: string;
  nodeIds: string[];
  generation: number;
  metrics: Record<string, unknown>;
};

export class OrganizeOpRepository {
  private readonly firestore = getFirestore();

  docRef(workspaceId: string, topicId: string, opId: string) {
    return this.firestore.doc(`workspaces/${workspaceId}/topics/${topicId}/organizeOps/${opId}`);
  }

  async upsert(record: OrganizeOpRecord) {
    await this.docRef(record.workspaceId, record.topicId, record.opId).set(
      {
        opType: record.opType,
        sourceEventType: record.sourceEventType,
        traceId: record.traceId,
        idempotencyKey: record.idempotencyKey,
        topicId: record.topicId,
        nodeIds: record.nodeIds,
        generation: record.generation,
        metrics: record.metrics,
        status: "proposed",
        updatedAt: FieldValue.serverTimestamp(),
        createdAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
  }
}
