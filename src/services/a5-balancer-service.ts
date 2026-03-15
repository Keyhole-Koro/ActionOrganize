import { env } from "../config/env.js";
import type { EventEnvelope } from "../models/envelope.js";
import { OrganizeOpRepository } from "../repositories/organize-op-repository.js";
import { NodeRepository } from "../repositories/node-repository.js";
import { logger } from "../lib/logger.js";

export type A5BalanceResult = {
  topicId: string;
  nodeIds: string[];
  generation: number;
  metrics: {
    imbalance: number;
    unresolvedRate: number;
    redundancy: number;
  };
};

export class A5BalancerService {
  private readonly organizeOpRepository = new OrganizeOpRepository();
  private readonly nodeRepository = new NodeRepository();

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

    // Compute real metrics if Firestore is available
    let imbalance = 0;
    let unresolvedRate = 0;
    let redundancy = 0;

    if (this.isFirestoreBackend()) {
      try {
        // Compute imbalance: ratio of max/min child counts across root children
        const rootNodeId = `node:${topicId}:root`;
        const rootChildren = await this.nodeRepository.listByParent(
          envelope.workspaceId,
          topicId,
          rootNodeId,
          100,
        );

        if (rootChildren.length > 1) {
          const childCounts = await Promise.all(
            rootChildren.map(async (child) => {
              const grandchildren = await this.nodeRepository.listByParent(
                envelope.workspaceId,
                topicId,
                child.nodeId,
                500,
              );
              return grandchildren.length;
            }),
          );
          const maxCount = Math.max(...childCounts, 1);
          const minCount = Math.min(...childCounts, 0);
          imbalance = minCount === 0 ? 1 : Math.min(1, (maxCount - minCount) / maxCount);
        }

        // Compute unresolved rate from claim nodes
        const claimNodes = await this.nodeRepository.listClaimNodes(
          envelope.workspaceId,
          topicId,
          500,
        );
        const lowConfidenceClaims = claimNodes.filter((n) => {
          const summary = n.contextSummary ?? "";
          return summary.includes("score=0.") || summary.includes("Merged");
        });
        unresolvedRate = claimNodes.length > 0 ? lowConfidenceClaims.length / claimNodes.length : 0;

        // Compute redundancy from title similarity
        const titles = claimNodes.map((n) => n.title.toLowerCase());
        let duplicatePairs = 0;
        for (let i = 0; i < titles.length && i < 50; i++) {
          for (let j = i + 1; j < titles.length && j < 50; j++) {
            if (titles[i] === titles[j]) duplicatePairs++;
          }
        }
        redundancy = titles.length > 1 ? Math.min(1, duplicatePairs / titles.length) : 0;
      } catch (error) {
        logger.warn({ error, topicId }, "A5: failed to compute metrics, using defaults");
      }

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
        metrics: { imbalance, unresolvedRate, redundancy, ...envelope.payload },
      });
    }

    return { topicId, nodeIds, generation, metrics: { imbalance, unresolvedRate, redundancy } };
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
