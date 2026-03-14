import type { NodeCandidate } from "../repositories/node-repository.js";

function normalizeTitle(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function resolveNodeId(
  existingNodes: NodeCandidate[],
  atomTitle: string,
  fallbackNodeId: string,
): string {
  const target = normalizeTitle(atomTitle);
  if (!target) {
    return fallbackNodeId;
  }

  const match = existingNodes.find((node) => normalizeTitle(node.title) === target);
  return match ? match.nodeId : fallbackNodeId;
}

export function dedupeNodeIds(nodeIds: string[]): string[] {
  return [...new Set(nodeIds.filter((value) => value.length > 0))];
}
