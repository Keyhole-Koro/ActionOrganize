import { getLeaseResourceKey } from "../core/resource-policy.js";
import { getAgentHandler } from "../agents/registry.js";
import type { DecodedPushEvent } from "../core/pubsub.js";
import { EventPublisher } from "./event-publisher.js";
import { createEventLedgerRepository, createLeaseRepository } from "../repositories/index.js";

export class EventProcessor {
  private readonly ledgerRepository = createEventLedgerRepository();
  private readonly leaseRepository = createLeaseRepository();
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
      await this.ledgerRepository.markFailed(
        decoded.envelope.workspaceId,
        decoded.envelope.idempotencyKey,
        error instanceof Error ? error.name : "UnknownError",
        error instanceof Error ? error.message : "unknown error",
      );

      if (leaseResourceKey) {
        await this.leaseRepository.release(decoded.envelope.workspaceId, leaseResourceKey, owner);
      }

      throw error;
    }
  }
}
