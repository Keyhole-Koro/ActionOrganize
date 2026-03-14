import { FieldValue, type Transaction } from "@google-cloud/firestore";
import { getFirestore } from "../core/firestore.js";

export type EdgeRecord = {
  workspaceId: string;
  topicId: string;
  edgeId: string;
  sourceNodeId: string;
  targetNodeId: string;
  relationType: string;
  schemaVersion?: number;
};

export class EdgeRepository {
  private readonly firestore = getFirestore();

  docRef(workspaceId: string, topicId: string, edgeId: string) {
    return this.firestore.doc(`workspaces/${workspaceId}/topics/${topicId}/edges/${edgeId}`);
  }

  write(tx: Transaction, record: EdgeRecord) {
    tx.set(
      this.docRef(record.workspaceId, record.topicId, record.edgeId),
      {
        topicId: record.topicId,
        edgeId: record.edgeId,
        sourceNodeId: record.sourceNodeId,
        targetNodeId: record.targetNodeId,
        relationType: record.relationType,
        schemaVersion: record.schemaVersion,
        updatedAt: FieldValue.serverTimestamp(),
        createdAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
  }
}
