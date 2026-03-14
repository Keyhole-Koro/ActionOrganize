import { FieldValue } from "@google-cloud/firestore";
import { getFirestore } from "../core/firestore.js";

export type AtomRecord = {
  workspaceId: string;
  topicId: string;
  atomId: string;
  sourceInputId: string;
  claimIndex: number;
  title: string;
  claim: string;
  kind: "fact" | "definition" | "relation" | "opinion" | "temporal";
  confidence: number;
};

export class AtomRepository {
  private readonly firestore = getFirestore();

  async upsert(record: AtomRecord) {
    await this.firestore
      .doc(`workspaces/${record.workspaceId}/topics/${record.topicId}/atoms/${record.atomId}`)
      .set(
        {
          topicId: record.topicId,
          sourceInputId: record.sourceInputId,
          claimIndex: record.claimIndex,
          title: record.title,
          claim: record.claim,
          kind: record.kind,
          confidence: record.confidence,
          reissueCount: 0,
          updatedAt: FieldValue.serverTimestamp(),
          createdAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
  }
}
