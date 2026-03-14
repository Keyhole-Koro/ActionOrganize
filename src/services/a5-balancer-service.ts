import { env } from "../config/env.js";
import type { EventEnvelope } from "../models/envelope.js";
import { OrganizeOpRepository } from "../repositories/organize-op-repository.js";

export type A5BalanceResult = {
  topicId: string;
  nodeIds: string[];
  generation: number;
};

export class A5BalancerService {
  private readonly organizeOpRepository = new OrganizeOpRepository();

  private isFirestoreBackend() {
    return env.STATE_BACKEND === "firestore";
  }

  async onTopicMetricsUpdated(envelope: EventEnvelope): Promise<A5BalanceResult> {
    const topicId =
      typeof envelope.payload.topicId === "string" && envelope.payload.topicId.length > 0
        ? envelope.payload.topicId
        : envelope.topicId;

    const generation = this.resolveGeneration(envelope.payload.generation);
    const nodeIds = this.resolveNodeIds(topicId, envelope.payload);

    if (this.isFirestoreBackend()) {
      const opId = `op:${envelope.traceId}:${generation}`;
      await this.organizeOpRepository.upsert({
        workspaceId: envelope.workspaceId,
        topicId,
        opId,
        opType: "rebalance",
        sourceEventType: envelope.type,
        traceId: envelope.traceId,
        idempotencyKey: envelope.idempotencyKey,
        nodeIds,
        generation,
        metrics: envelope.payload,
      });
    }

    return { topicId, nodeIds, generation };
  }

  private resolveNodeIds(topicId: string, payload: EventEnvelope["payload"]): string[] {
    const maxNodes =
      typeof payload.maxNodes === "number" && Number.isFinite(payload.maxNodes) && payload.maxNodes > 0
        ? Math.min(10, Math.floor(payload.maxNodes))
        : 3;

    const targetNodeIds = payload.targetNodeIds;
    if (Array.isArray(targetNodeIds)) {
      const filtered = targetNodeIds.filter(
        (value): value is string => typeof value === "string" && value.length > 0,
      );
      if (filtered.length > 0) {
        return [...new Set(filtered)].slice(0, maxNodes);
      }
    }

    if (typeof payload.focusNodeId === "string" && payload.focusNodeId.length > 0) {
      return [payload.focusNodeId];
    }

    return [`node:${topicId}:root`];
  }

  private resolveGeneration(value: unknown): number {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      return Math.floor(value);
    }
    return 1;
  }
}
