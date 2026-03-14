import { FieldValue, type Transaction } from "@google-cloud/firestore";
import { getFirestore } from "../core/firestore.js";

export type OutlineRecord = {
  workspaceId: string;
  topicId: string;
  version: number;
  summaryMd: string;
  mapMd: string;
};

export class OutlineRepository {
  private readonly firestore = getFirestore();

  docRef(workspaceId: string, topicId: string, version: number) {
    return this.firestore.doc(`workspaces/${workspaceId}/topics/${topicId}/outlines/${version}`);
  }

  write(tx: Transaction, record: OutlineRecord) {
    tx.set(
      this.docRef(record.workspaceId, record.topicId, record.version),
      {
        topicId: record.topicId,
        version: record.version,
        summaryMd: record.summaryMd,
        mapMd: record.mapMd,
        publishedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
  }
}
