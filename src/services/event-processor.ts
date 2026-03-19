import { getLeaseResourceKey } from "../core/resource-policy.js";
import { getAgentHandler } from "../agents/registry.js";
import type { DecodedPushEvent } from "../core/pubsub.js";
import { EventPublisher } from "./event-publisher.js";
import { createEventLedgerRepository, createLeaseRepository } from "../repositories/index.js";
import { InputProgressRepository } from "../repositories/input-progress-repository.js";

export class EventProcessor {
  private readonly ledgerRepository = createEventLedgerRepository();
  private readonly leaseRepository = createLeaseRepository();
  private readonly inputProgressRepository = new InputProgressRepository();
  private readonly publisher = new EventPublisher();

  async process(decoded: DecodedPushEvent) {
    const handler = getAgentHandler(decoded.envelope.type);
    const owner = `${decoded.envelope.type}:${decoded.envelope.traceId}`;
    const leaseResourceKey = getLeaseResourceKey(decoded.envelope);

    await this.ledgerRepository.reserve(decoded.envelope, handler.eventType);

    try {
      if (leaseResourceKey) {
        await this.leaseRepository.acquire(
          decoded.envelope.workspaceId,
          decoded.envelope.topicId,
          leaseResourceKey,
          owner,
        );
      }

      const result = await handler.handle({
        envelope: decoded.envelope,
        attributes: decoded.attributes,
      });

      await this.publisher.publish({
        sourceEnvelope: decoded.envelope,
        result,
      });

      await this.ledgerRepository.markSucceeded(
        decoded.envelope.workspaceId,
        decoded.envelope.idempotencyKey,
      );

      if (leaseResourceKey) {
        await this.leaseRepository.release(decoded.envelope.workspaceId, leaseResourceKey, owner);
      }

      return result;
    } catch (error) {
      const errorName = error instanceof Error ? error.name : "UnknownError";
      const errorMessage = error instanceof Error ? error.message : "unknown error";

      await this.ledgerRepository.markFailed(
        decoded.envelope.workspaceId,
        decoded.envelope.idempotencyKey,
        errorName,
        errorMessage,
      );

      // Attempt to update input progress if inputId is available in payload
      const inputId = decoded.envelope.payload.inputId;
      if (typeof inputId === "string" && inputId.length > 0) {
        try {
          await this.inputProgressRepository.advance({
            workspaceId: decoded.envelope.workspaceId,
            topicId: decoded.envelope.topicId,
            inputId,
            status: "failed",
            currentPhase: decoded.envelope.type,
            lastEventType: decoded.envelope.type,
            traceId: decoded.envelope.traceId,
            errorCode: errorName,
            errorMessage: errorMessage,
          });
        } catch (ipError) {
          // Log but don't crash if progress update fails
          console.error("Failed to update input progress on error:", ipError);
        }
      }

      if (leaseResourceKey) {
        await this.leaseRepository.release(decoded.envelope.workspaceId, leaseResourceKey, owner);
      }

      throw error;
    }
  }
}
