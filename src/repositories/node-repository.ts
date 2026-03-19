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
  sourceInputIds?: string[];
  sourceChunkIds?: string[];
  sourceThreadIds?: string[];
  evidenceAtomIds?: string[];
};

export type NodeCandidate = {
  nodeId: string;
  title: string;
  contextSummary?: string;
  schemaVersion?: number;
};

export class NodeRepository {
  private readonly firestore = getFirestore();

  docRef(workspaceId: string, topicId: string, nodeId: string) {
    return this.firestore.doc(`workspaces/${workspaceId}/nodes/${nodeId}`);
  }

  write(tx: Transaction, record: NodeRecord) {
    const data: any = {
      topicId: record.topicId,
      workspaceId: record.workspaceId,
      nodeId: record.nodeId,
      kind: record.kind,
      title: record.title,
      schemaVersion: record.schemaVersion,
      contextSummary: record.contextSummary,
      detailHtml: record.detailHtml,
      rollupRef: record.rollupRef,
      rollupWatermark: record.rollupWatermark,
      sourceInputIds: record.sourceInputIds,
      sourceChunkIds: record.sourceChunkIds,
      sourceThreadIds: record.sourceThreadIds,
      evidenceAtomIds: record.evidenceAtomIds,
      updatedAt: FieldValue.serverTimestamp(),
      createdAt: FieldValue.serverTimestamp(),
    };

    if (record.parentId !== undefined) {
      data.parentId = record.parentId;
    }

    tx.set(
      this.docRef(record.workspaceId, record.topicId, record.nodeId),
      data,
      { merge: true },
    );
  }

  async upsert(record: NodeRecord) {
    const data: any = {
      topicId: record.topicId,
      workspaceId: record.workspaceId,
      nodeId: record.nodeId,
      kind: record.kind,
      title: record.title,
      schemaVersion: record.schemaVersion,
      contextSummary: record.contextSummary,
      detailHtml: record.detailHtml,
      rollupRef: record.rollupRef,
      rollupWatermark: record.rollupWatermark,
      sourceInputIds: record.sourceInputIds,
      sourceChunkIds: record.sourceChunkIds,
      sourceThreadIds: record.sourceThreadIds,
      evidenceAtomIds: record.evidenceAtomIds,
      updatedAt: FieldValue.serverTimestamp(),
      createdAt: FieldValue.serverTimestamp(),
    };

    if (record.parentId !== undefined) {
      data.parentId = record.parentId;
    }

    await this.docRef(record.workspaceId, record.topicId, record.nodeId).set(
      data,
      { merge: true },
    );
  }

  async listClaimNodes(workspaceId: string, topicId: string, limit = 500): Promise<NodeCandidate[]> {
    const snapshot = await this.firestore
      .collection(`workspaces/${workspaceId}/nodes`)
      .where("kind", "==", "claim")
      .limit(limit)
      .get();

    return snapshot.docs.map((doc) => ({
      nodeId: doc.id,
      title: typeof doc.get("title") === "string" ? doc.get("title") : doc.id,
      contextSummary:
        typeof doc.get("contextSummary") === "string" ? doc.get("contextSummary") : undefined,
      schemaVersion: typeof doc.get("schemaVersion") === "number" ? doc.get("schemaVersion") : undefined,
    }));
  }

  async listByParent(workspaceId: string, topicId: string, parentId: string, limit = 200): Promise<NodeCandidate[]> {
    const snapshot = await this.firestore
      .collection(`workspaces/${workspaceId}/nodes`)
      .where("parentId", "==", parentId)
      .limit(limit)
      .get();

    return snapshot.docs.map((doc) => ({
      nodeId: doc.id,
      title: typeof doc.get("title") === "string" ? doc.get("title") : doc.id,
      contextSummary:
        typeof doc.get("contextSummary") === "string" ? doc.get("contextSummary") : undefined,
      schemaVersion: typeof doc.get("schemaVersion") === "number" ? doc.get("schemaVersion") : undefined,
    }));
  }
}
