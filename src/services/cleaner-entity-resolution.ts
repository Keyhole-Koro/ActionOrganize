import type { NodeCandidate } from "../repositories/node-repository.js";

function normalizeTitle(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function tokenize(input: string): Set<string> {
  return new Set(
    normalizeTitle(input)
      .split(" ")
      .map((token) => token.trim())
      .filter((token) => token.length >= 3),
  );
}

function jaccard(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) {
    return 0;
  }
  let intersection = 0;
  for (const token of left) {
    if (right.has(token)) {
      intersection += 1;
    }
  }
  const union = new Set([...left, ...right]).size;
  return union === 0 ? 0 : intersection / union;
}

type ResolveOptions = {
  atomTitle: string;
  atomClaim: string;
  fallbackNodeId: string;
  schemaVersion?: number;
};

export type ResolvedNode = {
  nodeId: string;
  isMerged: boolean;
  similarity: number;
};

export function resolveNode(
  existingNodes: NodeCandidate[],
  options: ResolveOptions,
): ResolvedNode {
  const titleTarget = normalizeTitle(options.atomTitle);
  if (!titleTarget) {
    return { nodeId: options.fallbackNodeId, isMerged: false, similarity: 0 };
  }

  const titleTokens = tokenize(options.atomTitle);
  const claimTokens = tokenize(options.atomClaim);

  let best: { nodeId: string; score: number } | null = null;
  for (const node of existingNodes) {
    if (
      typeof options.schemaVersion === "number" &&
      typeof node.schemaVersion === "number" &&
      node.schemaVersion !== options.schemaVersion
    ) {
      continue;
    }

    const titleScore = jaccard(titleTokens, tokenize(node.title));
    const contextScore = jaccard(claimTokens, tokenize(node.contextSummary ?? ""));
    const combined = titleScore * 0.75 + contextScore * 0.25;
    if (!best || combined > best.score) {
      best = { nodeId: node.nodeId, score: combined };
    }
  }

  if (best && best.score >= 0.55) {
    return { nodeId: best.nodeId, isMerged: true, similarity: best.score };
  }

  return { nodeId: options.fallbackNodeId, isMerged: false, similarity: best?.score ?? 0 };
}

export function dedupeNodeIds(nodeIds: string[]): string[] {
  return [...new Set(nodeIds.filter((value) => value.length > 0))];
}
