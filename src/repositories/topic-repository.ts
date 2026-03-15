import { FieldValue, type Firestore, type Transaction } from "@google-cloud/firestore";
import { getFirestore } from "../core/firestore.js";

export type TopicRecord = {
  workspaceId: string;
  topicId: string;
  title?: string;
  status?: string;
};

export type TopicCandidate = {
  topicId: string;
  title: string;
  status: string;
};

export class TopicRepository {
  private readonly firestore = getFirestore();

  docPath(workspaceId: string, topicId: string) {
    return `workspaces/${workspaceId}/topics/${topicId}`;
  }

  docRef(workspaceId: string, topicId: string) {
    return this.firestore.doc(this.docPath(workspaceId, topicId));
  }

  schemaDocPath(workspaceId: string, topicId: string, version: number) {
    return `${this.docPath(workspaceId, topicId)}/schemas/${version}`;
  }

  schemaDocRef(workspaceId: string, topicId: string, version: number) {
    return this.firestore.doc(this.schemaDocPath(workspaceId, topicId, version));
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

  async get(workspaceId: string, topicId: string): Promise<TopicCandidate | null> {
    const snapshot = await this.docRef(workspaceId, topicId).get();
    if (!snapshot.exists) {
      return null;
    }

    return {
      topicId,
      title: typeof snapshot.get("title") === "string" ? snapshot.get("title") : topicId,
      status: typeof snapshot.get("status") === "string" ? snapshot.get("status") : "active",
    };
  }

  async listCandidates(workspaceId: string, limit = 5): Promise<TopicCandidate[]> {
    const snapshot = await this.firestore
      .collection(`workspaces/${workspaceId}/topics`)
      .limit(Math.max(limit * 3, limit))
      .get();

    const ALLOWED_STATES = new Set(["active", "split_child"]);

    return snapshot.docs
      .map((doc) => ({
        topicId: doc.id,
        title: typeof doc.get("title") === "string" ? doc.get("title") : doc.id,
        status: typeof doc.get("status") === "string" ? doc.get("status") : "active",
      }))
      .filter((topic) => ALLOWED_STATES.has(topic.status))
      .slice(0, limit);
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
