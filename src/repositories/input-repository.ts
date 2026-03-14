import { FieldValue } from "@google-cloud/firestore";
import { getFirestore } from "../core/firestore.js";

type InputRecord = {
  workspaceId: string;
  topicId: string;
  inputId: string;
  status: "received" | "stored" | "extracted" | "error";
  contentType: string;
  rawRef?: string;
  extractedRef?: string;
};

export class InputRepository {
  private readonly firestore = getFirestore();

  async upsert(record: InputRecord) {
    await this.firestore
      .doc(`workspaces/${record.workspaceId}/topics/${record.topicId}/inputs/${record.inputId}`)
      .set(
        {
          topicId: record.topicId,
          status: record.status,
          contentType: record.contentType,
          rawRef: record.rawRef,
          extractedRef: record.extractedRef,
          updatedAt: FieldValue.serverTimestamp(),
          createdAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
  }
}
