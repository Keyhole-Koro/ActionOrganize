import { FieldValue, type Transaction } from "@google-cloud/firestore";
import { getFirestore } from "../core/firestore.js";

export type DraftRecord = {
  workspaceId: string;
  topicId: string;
  version: number;
  sourceAtomIds: string[];
  summaryMd: string;
};

export class DraftRepository {
  private readonly firestore = getFirestore();

  docRef(workspaceId: string, _topicId: string, version: number) {
    return this.firestore.doc(`workspaces/${workspaceId}/drafts/${version}`);
  }

  write(tx: Transaction, record: DraftRecord) {
    tx.set(
      this.docRef(record.workspaceId, record.topicId, record.version),
      {
        topicId: record.topicId,
        version: record.version,
        sourceAtomIds: record.sourceAtomIds,
        summaryMd: record.summaryMd,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
  }
}
