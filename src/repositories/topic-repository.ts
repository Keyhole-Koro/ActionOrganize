import { FieldValue, type Firestore, type Transaction } from "@google-cloud/firestore";
import { getFirestore } from "../core/firestore.js";

export type TopicRecord = {
  workspaceId: string;
  topicId: string;
  title?: string;
  status?: string;
};

export class TopicRepository {
  private readonly firestore = getFirestore();

  docPath(workspaceId: string, topicId: string) {
    return `workspaces/${workspaceId}/topics/${topicId}`;
  }

  docRef(workspaceId: string, topicId: string) {
    return this.firestore.doc(this.docPath(workspaceId, topicId));
  }

  async ensure(record: TopicRecord) {
    await this.docRef(record.workspaceId, record.topicId).set(
      {
        workspaceId: record.workspaceId,
        topicId: record.topicId,
        title: record.title ?? record.topicId,
        status: record.status ?? "active",
        schemaVersion: 1,
        updatedAt: FieldValue.serverTimestamp(),
        createdAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
  }

  async getNextDraftVersion(
    tx: Transaction,
    workspaceId: string,
    topicId: string,
  ): Promise<number> {
    const ref = this.docRef(workspaceId, topicId);
    const snapshot = await tx.get(ref);
    const current = snapshot.get("latestDraftVersion");
    return typeof current === "number" ? current + 1 : 1;
  }

  get firestoreClient(): Firestore {
    return this.firestore;
  }
}
