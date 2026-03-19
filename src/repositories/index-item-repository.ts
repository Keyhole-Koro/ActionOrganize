import { FieldValue } from "@google-cloud/firestore";
import { getFirestore } from "../core/firestore.js";

export type IndexItemRecord = {
  workspaceId: string;
  topicId: string;
  indexItemId: string;
  nodeId: string;
  schemaVersion: number;
  outlineVersion: number;
  relationImportance: number;
  recency: number;
  confidence: number;
  evidenceCount: number;
  edgeCount: number;
  depth: number;
};

export class IndexItemRepository {
  private readonly firestore = getFirestore();

  async upsert(record: IndexItemRecord) {
    await this.firestore
      .doc(`workspaces/${record.workspaceId}/indexItems/${record.indexItemId}`)
      .set(
        {
          workspaceId: record.workspaceId,
          topicId: record.topicId,
          nodeId: record.nodeId,
          schemaVersion: record.schemaVersion,
          outlineVersion: record.outlineVersion,
          relationImportance: record.relationImportance,
          recency: record.recency,
          confidence: record.confidence,
          evidenceCount: record.evidenceCount,
          edgeCount: record.edgeCount,
          depth: record.depth,
          updatedAt: FieldValue.serverTimestamp(),
          createdAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
  }
}
