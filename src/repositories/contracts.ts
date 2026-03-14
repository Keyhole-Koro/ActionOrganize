import type { EventEnvelope } from "../models/envelope.js";

export interface EventLedgerPort {
  reserve(envelope: EventEnvelope, agentName: string): Promise<unknown>;
  markSucceeded(workspaceId: string, idempotencyKey: string): Promise<void>;
  markFailed(
    workspaceId: string,
    idempotencyKey: string,
    errorCode: string,
    errorMessage: string,
  ): Promise<void>;
}

export interface LeasePort {
  acquire(workspaceId: string, topicId: string, resourceKey: string, owner: string): Promise<void>;
  release(workspaceId: string, resourceKey: string, owner: string): Promise<void>;
}
