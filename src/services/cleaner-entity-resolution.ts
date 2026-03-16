import type { NodeCandidate } from "../repositories/node-repository.js";
import { callGemini } from "../lib/gemini-client.js";
import { logger } from "../lib/logger.js";

function normalizeTitle(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9\u3040-\u309f\u30a0-\u30ff\u4e00-\u9fff]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function tokenize(input: string): Set<string> {
  return new Set(
    normalizeTitle(input)
      .split(" ")
      .map((token) => token.trim())
      .filter((token) => token.length >= 2),
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

const MERGE_THRESHOLD = 0.85;
const AMBIGUOUS_LOW = 0.55;

/**
 * Resolves whether an atom should merge into an existing node or create a new one.
 *
 * Three zones:
 * - score >= 0.85 → auto-merge (high confidence)
 * - 0.55 <= score < 0.85 → ambiguous → ask Gemini if available
 * - score < 0.55 → create new node
 */
export async function resolveNodeAsync(
  existingNodes: NodeCandidate[],
  options: ResolveOptions,
): Promise<ResolvedNode> {
  const titleTarget = normalizeTitle(options.atomTitle);
  if (!titleTarget) {
    return { nodeId: options.fallbackNodeId, isMerged: false, similarity: 0 };
  }

  const titleTokens = tokenize(options.atomTitle);
  const claimTokens = tokenize(options.atomClaim);

  // Score all candidates
  const scored: Array<{ node: NodeCandidate; score: number }> = [];
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
    scored.push({ node, score: combined });
  }

  scored.sort((a, b) => b.score - a.score);
  const best = scored[0] ?? null;

  if (!best || best.score < AMBIGUOUS_LOW) {
    return { nodeId: options.fallbackNodeId, isMerged: false, similarity: best?.score ?? 0 };
  }

  if (best.score >= MERGE_THRESHOLD) {
    return { nodeId: best.node.nodeId, isMerged: true, similarity: best.score };
  }

  // Ambiguous zone — ask Gemini
  const topCandidates = scored.slice(0, 5);
  const geminiResult = await resolveWithGemini(options, topCandidates);
  if (geminiResult.decision === "merge" && geminiResult.targetNodeId) {
    const target = topCandidates.find((c) => c.node.nodeId === geminiResult.targetNodeId);
    return {
      nodeId: geminiResult.targetNodeId,
      isMerged: true,
      similarity: target?.score ?? best.score,
    };
  }
  return { nodeId: options.fallbackNodeId, isMerged: false, similarity: best.score };
}

/**
 * Synchronous fallback (kept for backward compatibility).
 */
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

// ── Gemini helper ───────────────────────────────────────────────────────────

interface GeminiEntityResolution {
  decision: "merge" | "create";
  targetNodeId?: string;
  confidence: number;
  reason: string;
}

async function resolveWithGemini(
  atom: ResolveOptions,
  candidates: Array<{ node: NodeCandidate; score: number }>,
): Promise<GeminiEntityResolution> {
  const candidateList = candidates
    .map(
      (c) =>
        `- nodeId: "${c.node.nodeId}", title: "${c.node.title}", context: "${c.node.contextSummary ?? ""}", jaccard: ${c.score.toFixed(2)}`,
    )
    .join("\n");

  const prompt = `You are an entity resolution agent for a knowledge graph. Decide whether the new atom should merge into an existing node or create a new one.

New atom:
- title: "${atom.atomTitle}"
- claim: "${atom.atomClaim}"

Existing node candidates (sorted by similarity):
${candidateList}

Return a JSON object:
{
  "decision": "merge" or "create",
  "targetNodeId": "the nodeId to merge into (only if merge)",
  "confidence": 0.0 to 1.0,
  "reason": "brief explanation"
}

Merge if the atom is about the same entity/concept as an existing node. Create if it represents a genuinely new concept.
Return ONLY the JSON object, no other text.`;

  const { parsed } = await callGemini<GeminiEntityResolution>(prompt, (value) => {
    const obj = value as Record<string, unknown>;
    if (obj.decision !== "merge" && obj.decision !== "create") {
      throw new Error(`Gemini entity resolution: invalid decision "${obj.decision}"`);
    }
    if (typeof obj.confidence !== "number" || !Number.isFinite(obj.confidence)) {
      throw new Error("Gemini entity resolution: confidence is not a finite number");
    }
    if (typeof obj.reason !== "string" || obj.reason.trim().length === 0) {
      throw new Error("Gemini entity resolution: reason is missing or empty");
    }
    return {
      decision: obj.decision,
      targetNodeId: typeof obj.targetNodeId === "string" ? obj.targetNodeId : undefined,
      confidence: obj.confidence,
      reason: obj.reason,
    };
  }, { modelTier: "quality" });

  return parsed;
}

