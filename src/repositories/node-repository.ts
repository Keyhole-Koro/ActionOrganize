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

export type NodeCandidate = {
  nodeId: string;
  title: string;
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

  async listClaimNodes(workspaceId: string, topicId: string, limit = 500): Promise<NodeCandidate[]> {
    const snapshot = await this.firestore
      .collection(`workspaces/${workspaceId}/topics/${topicId}/nodes`)
      .where("kind", "==", "claim")
      .limit(limit)
      .get();

    return snapshot.docs.map((doc) => ({
      nodeId: doc.id,
      title: typeof doc.get("title") === "string" ? doc.get("title") : doc.id,
    }));
  }
}
