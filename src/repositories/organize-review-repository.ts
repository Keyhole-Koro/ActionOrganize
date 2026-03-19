import { FieldValue } from "@google-cloud/firestore";
import { getFirestore } from "../core/firestore.js";

export type OrganizeReviewRecord = {
  workspaceId: string;
  reviewId: string;
  reviewType: string;
  topicId: string;
  status?: "open" | "resolved" | "ignored";
  sourceInputId?: string;
  sourceBatchId?: string;
  sourceThreadId?: string;
  sourceChunkId?: string;
  candidateTopicIds?: string[];
  reason: string;
  metadata?: Record<string, unknown>;
};

export class OrganizeReviewRepository {
  private readonly firestore = getFirestore();

  private docRef(workspaceId: string, reviewId: string) {
    return this.firestore.doc(`workspaces/${workspaceId}/organizeReviews/${reviewId}`);
  }

  async upsert(record: OrganizeReviewRecord) {
    await this.docRef(record.workspaceId, record.reviewId).set(
      {
        workspaceId: record.workspaceId,
        reviewId: record.reviewId,
        reviewType: record.reviewType,
        topicId: record.topicId,
        status: record.status ?? "open",
        sourceInputId: record.sourceInputId,
        sourceBatchId: record.sourceBatchId,
        sourceThreadId: record.sourceThreadId,
        sourceChunkId: record.sourceChunkId,
        candidateTopicIds: record.candidateTopicIds,
        reason: record.reason,
        metadata: record.metadata,
        updatedAt: FieldValue.serverTimestamp(),
        createdAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
  }
}
