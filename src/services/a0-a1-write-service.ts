import { env } from "../config/env.js";
import { InputRepository } from "../repositories/input-repository.js";
import { InputProgressRepository } from "../repositories/input-progress-repository.js";
import { AtomRepository } from "../repositories/atom-repository.js";
import type { EventEnvelope } from "../models/envelope.js";

export class A0A1WriteService {
  private readonly inputRepository = new InputRepository();
  private readonly inputProgressRepository = new InputProgressRepository();
  private readonly atomRepository = new AtomRepository();

  private isFirestoreBackend() {
    return env.STATE_BACKEND === "firestore";
  }

  async onMediaReceived(envelope: EventEnvelope, inputId: string) {
    if (!this.isFirestoreBackend()) {
      return;
    }

    await this.inputRepository.upsert({
      workspaceId: envelope.workspaceId,
      topicId: envelope.topicId,
      inputId,
      status: "received",
      contentType:
        typeof envelope.payload.contentType === "string" ? envelope.payload.contentType : "text/plain",
      rawRef: typeof envelope.payload.rawRef === "string" ? envelope.payload.rawRef : undefined,
    });

    await this.inputProgressRepository.advance({
      workspaceId: envelope.workspaceId,
      topicId: envelope.topicId,
      inputId,
      status: "extracting",
      currentPhase: "A0_MEDIA_INTERPRETER",
      lastEventType: envelope.type,
      traceId: envelope.traceId,
    });
  }

  async onInputReceived(envelope: EventEnvelope, inputId: string, atomIds: string[]) {
    if (!this.isFirestoreBackend()) {
      return;
    }

    await this.inputRepository.upsert({
      workspaceId: envelope.workspaceId,
      topicId: envelope.topicId,
      inputId,
      status: "extracted",
      contentType:
        typeof envelope.payload.contentType === "string" ? envelope.payload.contentType : "text/plain",
      extractedRef:
        typeof envelope.payload.extractedRef === "string" ? envelope.payload.extractedRef : undefined,
    });

    await Promise.all(
      atomIds.map((atomId, index) =>
        this.atomRepository.upsert({
          workspaceId: envelope.workspaceId,
          topicId: envelope.topicId,
          atomId,
          sourceInputId: inputId,
          claimIndex: index,
          title: `Atom ${index + 1}`,
          claim:
            typeof envelope.payload.text === "string"
              ? envelope.payload.text
              : `Derived claim for ${inputId} #${index + 1}`,
          kind: "fact",
          confidence: 0.6,
        }),
      ),
    );

    await this.inputProgressRepository.advance({
      workspaceId: envelope.workspaceId,
      topicId: envelope.topicId,
      inputId,
      status: "resolving_topic",
      currentPhase: "A1_ATOMIZER",
      lastEventType: "atom.created",
      traceId: envelope.traceId,
    });
  }

  async onTopicResolved(
    envelope: EventEnvelope,
    inputId: string,
    resolvedTopicId: string,
    resolutionMode: string,
  ) {
    if (!this.isFirestoreBackend()) {
      return;
    }

    await this.inputProgressRepository.advance({
      workspaceId: envelope.workspaceId,
      topicId: envelope.topicId,
      inputId,
      status: "updating_draft",
      currentPhase: "TOPIC_RESOLVER",
      lastEventType: envelope.type,
      traceId: envelope.traceId,
      resolvedTopicId,
      resolutionMode,
    });
  }
}
