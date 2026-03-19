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
      .doc(`workspaces/${record.workspaceId}/atoms/${record.atomId}`)
      .set(
        {
          topicId: record.topicId,
          sourceInputId: record.sourceInputId,
          claimIndex: record.claimIndex,
          title: record.title,
          claim: record.claim,
          kind: record.kind,
          confidence: record.confidence,
          reissueCount: FieldValue.increment(0),
          updatedAt: FieldValue.serverTimestamp(),
          createdAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
  }

  async getByIds(workspaceId: string, _topicId: string, atomIds: string[]) {
    const snapshots = await Promise.all(
      atomIds.map((atomId) =>
        this.firestore.doc(`workspaces/${workspaceId}/atoms/${atomId}`).get(),
      ),
    );

    return snapshots.flatMap((snapshot, index) => {
      if (!snapshot.exists) {
        return [];
      }

      return [
        {
          atomId: atomIds[index],
          title: typeof snapshot.get("title") === "string" ? snapshot.get("title") : atomIds[index],
          claim: typeof snapshot.get("claim") === "string" ? snapshot.get("claim") : "",
          kind: typeof snapshot.get("kind") === "string" ? snapshot.get("kind") : "fact",
          confidence: typeof snapshot.get("confidence") === "number" ? snapshot.get("confidence") : 0,
          sourceInputId:
            typeof snapshot.get("sourceInputId") === "string" ? snapshot.get("sourceInputId") : undefined,
        },
      ];
    });
  }
}
