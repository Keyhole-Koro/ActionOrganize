import { FieldValue } from "@google-cloud/firestore";
import { env } from "../config/env.js";
import { TemporaryDependencyError } from "../core/errors.js";
import { getPubsub } from "../core/pubsub-client.js";
import { getFirestore } from "../core/firestore.js";
import type { EventEnvelope } from "../models/envelope.js";
import type { AgentResult } from "../agents/types.js";

type PublishContext = {
  sourceEnvelope: EventEnvelope;
  result: AgentResult;
};

export class EventPublisher {
  private readonly pubsub = getPubsub();
  private readonly firestore = getFirestore();

  async publish(context: PublishContext) {
    if (!env.PUBSUB_PUBLISH_ENABLED || !context.result.emittedEvents?.length) {
      return;
    }

    const topic = this.pubsub.topic(env.PUBSUB_TOPIC_NAME, {
      messageOrdering: true,
    });

    for (const emittedEvent of context.result.emittedEvents) {
      const envelope: EventEnvelope = {
        schemaVersion: context.sourceEnvelope.schemaVersion,
        type: emittedEvent.type,
        traceId: context.sourceEnvelope.traceId,
        workspaceId: context.sourceEnvelope.workspaceId,
        topicId: emittedEvent.topicId,
        uid: context.sourceEnvelope.uid,
        idempotencyKey: `${emittedEvent.type}/source:${context.sourceEnvelope.idempotencyKey}`,
        emittedAt: new Date().toISOString(),
        payload: emittedEvent.payload,
      };

      try {
        await topic.publishMessage({
          json: envelope,
          orderingKey: emittedEvent.orderingKey,
          attributes: {
            type: envelope.type,
            schemaVersion: envelope.schemaVersion,
            workspaceId: envelope.workspaceId,
            topicId: envelope.topicId,
          },
        });
      } catch (error) {
        throw new TemporaryDependencyError(
          `failed to publish ${emittedEvent.type}: ${error instanceof Error ? error.message : "unknown error"}`,
        );
      }
    }

    await this.firestore
      .doc(`workspaces/${context.sourceEnvelope.workspaceId}/topics/${context.sourceEnvelope.topicId}`)
      .set(
        {
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
  }
}
