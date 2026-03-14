import { FieldValue } from "@google-cloud/firestore";
import { env } from "../config/env.js";
import { DraftRepository } from "../repositories/draft-repository.js";
import { InputProgressRepository } from "../repositories/input-progress-repository.js";
import { TopicRepository } from "../repositories/topic-repository.js";
import type { EventEnvelope } from "../models/envelope.js";

export type DraftAppendResult = {
  draftVersion: number;
};

export class A2DraftAppenderService {
  private readonly topicRepository = new TopicRepository();
  private readonly draftRepository = new DraftRepository();
  private readonly inputProgressRepository = new InputProgressRepository();

  private isFirestoreBackend() {
    return env.STATE_BACKEND === "firestore";
  }

  async appendDraft(
    envelope: EventEnvelope,
    resolvedTopicId: string,
    inputId: string,
    atomIds: string[],
    resolutionMode: string,
  ): Promise<DraftAppendResult> {
    if (!this.isFirestoreBackend()) {
      return { draftVersion: 1 };
    }

    await this.topicRepository.ensure({
      workspaceId: envelope.workspaceId,
      topicId: resolvedTopicId,
      title: resolvedTopicId,
    });

    const firestore = this.topicRepository.firestoreClient;
    const topicRef = this.topicRepository.docRef(envelope.workspaceId, resolvedTopicId);

    const draftVersion = await firestore.runTransaction(async (tx) => {
      const nextVersion = await this.topicRepository.getNextDraftVersion(
        tx,
        envelope.workspaceId,
        resolvedTopicId,
      );

      this.draftRepository.write(tx, {
        workspaceId: envelope.workspaceId,
        topicId: resolvedTopicId,
        version: nextVersion,
        sourceAtomIds: atomIds,
        summaryMd: this.toDraftMarkdown(resolvedTopicId, inputId, atomIds),
      });

      tx.set(
        topicRef,
        {
          workspaceId: envelope.workspaceId,
          topicId: resolvedTopicId,
          latestDraftVersion: nextVersion,
          updatedAt: FieldValue.serverTimestamp(),
          createdAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );

      return nextVersion;
    });

    await this.inputProgressRepository.advance({
      workspaceId: envelope.workspaceId,
      topicId: envelope.topicId,
      inputId,
      status: "updating_draft",
      currentPhase: "A2_DRAFT_APPENDER",
      lastEventType: "draft.updated",
      traceId: envelope.traceId,
      resolvedTopicId,
      resolutionMode,
    });

    return { draftVersion };
  }

  private toDraftMarkdown(topicId: string, inputId: string, atomIds: string[]) {
    const lines = [
      `# Draft ${topicId}`,
      "",
      `Source input: ${inputId}`,
      "",
      "## Appended atoms",
      ...atomIds.map((atomId) => `- ${atomId}`),
    ];
    return lines.join("\n");
  }
}
