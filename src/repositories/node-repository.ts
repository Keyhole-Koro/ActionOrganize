import { FieldValue, type Transaction } from "@google-cloud/firestore";
import { getFirestore } from "../core/firestore.js";

export type NodeRecord = {
  workspaceId: string;
  topicId: string;
  nodeId: string;
  kind: string;
  title: string;
  parentId?: string | null;
  schemaVersion?: number;
  contextSummary?: string;
  detailHtml?: string;
  rollupRef?: string;
  rollupWatermark?: number;
};

export class NodeRepository {
  private readonly firestore = getFirestore();

  docRef(workspaceId: string, topicId: string, nodeId: string) {
    return this.firestore.doc(`workspaces/${workspaceId}/topics/${topicId}/nodes/${nodeId}`);
  }

  write(tx: Transaction, record: NodeRecord) {
    tx.set(
      this.docRef(record.workspaceId, record.topicId, record.nodeId),
      {
        topicId: record.topicId,
        nodeId: record.nodeId,
        kind: record.kind,
        title: record.title,
        parentId: record.parentId ?? null,
        schemaVersion: record.schemaVersion,
        contextSummary: record.contextSummary,
        detailHtml: record.detailHtml,
        rollupRef: record.rollupRef,
        rollupWatermark: record.rollupWatermark,
        updatedAt: FieldValue.serverTimestamp(),
        createdAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
  }

  async upsert(record: NodeRecord) {
    await this.docRef(record.workspaceId, record.topicId, record.nodeId).set(
      {
        topicId: record.topicId,
        nodeId: record.nodeId,
        kind: record.kind,
        title: record.title,
        parentId: record.parentId ?? null,
        schemaVersion: record.schemaVersion,
        contextSummary: record.contextSummary,
        detailHtml: record.detailHtml,
        rollupRef: record.rollupRef,
        rollupWatermark: record.rollupWatermark,
        updatedAt: FieldValue.serverTimestamp(),
        createdAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
  }
}
