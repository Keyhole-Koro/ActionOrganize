import { FieldValue } from "@google-cloud/firestore";
import { getFirestore } from "../core/firestore.js";

export type InputRecord = {
  workspaceId: string;
  topicId: string;
  inputId: string;
  status: "received" | "stored" | "extracted" | "error";
  contentType: string;
  rawRef?: string;
  extractedRef?: string;
  sourceType?: string;
  sourceBatchId?: string;
  sourceConversationId?: string;
  sourceThreadId?: string;
  sourceChunkId?: string;
  sourceMessageIds?: string[];
  sourceTimeRangeStart?: string;
  sourceTimeRangeEnd?: string;
  estimatedInputTokens?: number;
  reservedOutputTokens?: number;
};

export class InputRepository {
  private readonly firestore = getFirestore();

  async upsert(record: InputRecord) {
    await this.firestore
      .doc(`workspaces/${record.workspaceId}/inputs/${record.inputId}`)
      .set(
        {
          topicId: record.topicId,
          status: record.status,
          contentType: record.contentType,
          rawRef: record.rawRef,
          extractedRef: record.extractedRef,
          sourceType: record.sourceType,
          sourceBatchId: record.sourceBatchId,
          sourceConversationId: record.sourceConversationId,
          sourceThreadId: record.sourceThreadId,
          sourceChunkId: record.sourceChunkId,
          sourceMessageIds: record.sourceMessageIds,
          sourceTimeRangeStart: record.sourceTimeRangeStart,
          sourceTimeRangeEnd: record.sourceTimeRangeEnd,
          estimatedInputTokens: record.estimatedInputTokens,
          reservedOutputTokens: record.reservedOutputTokens,
          updatedAt: FieldValue.serverTimestamp(),
          createdAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
  }
}
