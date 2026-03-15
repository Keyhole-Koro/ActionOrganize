import { FieldValue } from "@google-cloud/firestore";
import { getFirestore } from "../core/firestore.js";

export type InputProgressStatus =
  | "uploaded"
  | "extracting"
  | "atomizing"
  | "resolving_topic"
  | "updating_draft"
  | "completed"
  | "failed";

type InputProgressRecord = {
  workspaceId: string;
  topicId: string;
  inputId: string;
  status: InputProgressStatus;
  currentPhase: string;
  lastEventType: string;
  traceId: string;
  resolutionMode?: string;
  resolvedTopicId?: string;
  errorCode?: string;
  errorMessage?: string;
  completedAt?: boolean;
};

const statusOrder: Record<InputProgressStatus, number> = {
  uploaded: 1,
  extracting: 2,
  atomizing: 3,
  resolving_topic: 4,
  updating_draft: 5,
  completed: 6,
  failed: 7,
};

export class InputProgressRepository {
  private readonly firestore = getFirestore();

  private docPath(workspaceId: string, topicId: string, inputId: string) {
    return `workspaces/${workspaceId}/topics/${topicId}/inputProgress/${inputId}`;
  }

  async advance(record: InputProgressRecord) {
    const ref = this.firestore.doc(this.docPath(record.workspaceId, record.topicId, record.inputId));

    await this.firestore.runTransaction(async (tx) => {
      const snapshot = await tx.get(ref);
      const currentStatus = snapshot.get("status") as InputProgressStatus | undefined;
      const nextStatus =
        currentStatus && statusOrder[currentStatus] > statusOrder[record.status]
          ? currentStatus
          : record.status;

      tx.set(
        ref,
        {
          workspaceId: record.workspaceId,
          topicId: record.topicId,
          inputId: record.inputId,
          status: nextStatus,
          currentPhase: record.currentPhase,
          lastEventType: record.lastEventType,
          traceId: record.traceId,
          resolutionMode: record.resolutionMode,
          resolvedTopicId: record.resolvedTopicId,
          errorCode: record.errorCode,
          errorMessage: record.errorMessage,
          phaseUpdatedAt: FieldValue.serverTimestamp(),
          completedAt: record.completedAt ? FieldValue.serverTimestamp() : snapshot.get("completedAt"),
          updatedAt: FieldValue.serverTimestamp(),
          createdAt: snapshot.exists ? snapshot.get("createdAt") : FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
    });
  }

  async advanceMany(record: InputProgressRecord, topicIds: string[]) {
    const uniqueTopicIds = [...new Set(topicIds.filter((topicId) => topicId.length > 0))];
    await Promise.all(
      uniqueTopicIds.map((topicId) =>
        this.advance({
          ...record,
          topicId,
        }),
      ),
    );
  }
}
