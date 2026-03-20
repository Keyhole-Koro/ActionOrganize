/**
 * DiscordNodeService — assigns an incoming Discord message to a knowledge graph node.
 *
 * Uses Gemini to decide:
 *   - Attach to an existing node (topicId + nodeId)
 *   - Create a new node under an existing topic
 *   - Create a new topic + node
 *   - Ignore (off-topic / noise)
 */
import { z } from "zod";
import { Storage } from "@google-cloud/storage";
import { env } from "../config/env.js";
import { callGemini } from "../lib/gemini-client.js";
import { logger } from "../lib/logger.js";
import { NodeRepository } from "../repositories/node-repository.js";
import { TopicRepository } from "../repositories/topic-repository.js";
import { EvidenceRepository } from "../repositories/evidence-repository.js";
import { FieldValue } from "@google-cloud/firestore";
import { getFirestore } from "../core/firestore.js";
import crypto from "node:crypto";

// ── GCS message reader ───────────────────────────────────────────────────────

type DiscordMessage = {
  message_id: string;
  guild_name: string;
  category_name: string | null;
  channel_id: string | null;
  channel_name: string | null;
  thread_id: string | null;
  thread_name: string | null;
  author_name: string;
  content: string;
  timestamp: string;
};

const storage = new Storage();

async function readMessageFromGcs(gcsPath: string): Promise<DiscordMessage> {
  const bucket = storage.bucket(env.ORGANIZE_GCS_BUCKET);
  const [contents] = await bucket.file(gcsPath).download();
  return JSON.parse(contents.toString("utf-8")) as DiscordMessage;
}

// ── Gemini decision schema ───────────────────────────────────────────────────

const decisionSchema = z.object({
  action: z.enum(["attach_existing", "create_node", "ignore"]),
  topicId: z.string().optional(),
  nodeId: z.string().optional(),
  newTopicTitle: z.string().optional(),
  newNodeTitle: z.string().optional(),
  reason: z.string(),
});

type NodeDecision = z.infer<typeof decisionSchema>;

function validateDecision(value: unknown): NodeDecision {
  return decisionSchema.parse(value);
}

// ── Candidate builder ────────────────────────────────────────────────────────

type TopicNodeSummary = {
  topicId: string;
  topicTitle: string;
  nodes: Array<{ nodeId: string; title: string; summary?: string }>;
};

async function listTopicNodeCandidates(workspaceId: string): Promise<TopicNodeSummary[]> {
  const db = getFirestore();
  const topicsSnap = await db
    .collection(`workspaces/${workspaceId}/topics`)
    .where("status", "==", "active")
    .limit(10)
    .get();

  const results: TopicNodeSummary[] = [];
  for (const topicDoc of topicsSnap.docs) {
    const topicId = topicDoc.id;
    const topicTitle = typeof topicDoc.get("title") === "string" ? topicDoc.get("title") : topicId;
    const nodesSnap = await db
      .collection(`workspaces/${workspaceId}/topics/${topicId}/nodes`)
      .where("kind", "==", "claim")
      .limit(20)
      .get();
    const nodes = nodesSnap.docs.map((d) => ({
      nodeId: d.id,
      title: typeof d.get("title") === "string" ? d.get("title") : d.id,
      summary: typeof d.get("contextSummary") === "string" ? d.get("contextSummary") : undefined,
    }));
    results.push({ topicId, topicTitle, nodes });
  }
  return results;
}

// ── Main service ─────────────────────────────────────────────────────────────

export class DiscordNodeService {
  private readonly nodeRepository = new NodeRepository();
  private readonly topicRepository = new TopicRepository();
  private readonly db = getFirestore();

  async processMessage(workspaceId: string, gcsPath: string): Promise<void> {
    const msg = await readMessageFromGcs(gcsPath);
    const candidates = await listTopicNodeCandidates(workspaceId);

    const location = [
      msg.guild_name,
      msg.category_name,
      msg.channel_name,
      msg.thread_name,
    ]
      .filter(Boolean)
      .join(" > ");

    const candidateText =
      candidates.length === 0
        ? "No existing topics yet."
        : candidates
            .map(
              (t) =>
                `Topic "${t.topicTitle}" (id: ${t.topicId}):
` +
                t.nodes
                  .map((n) => `  - Node "${n.title}" (id: ${n.nodeId})${n.summary ? ": " + n.summary : ""}`)
                  .join("\n"),
            )
            .join("\n\n");

    const prompt = `
You are a knowledge graph assistant. Decide how to incorporate a new Discord message into the knowledge graph.

## New Discord message
Location: ${location}
Author: ${msg.author_name}
Time: ${msg.timestamp}
Content: ${msg.content}

## Existing knowledge graph
${candidateText}

## Instructions
Respond with a JSON object with exactly these fields:
- "action": one of "attach_existing" | "create_node" | "ignore"
  - attach_existing: the message adds evidence to an existing node
  - create_node: the message introduces a new concept (may reuse existing topic or create new one)
  - ignore: the message is noise/off-topic (e.g. greetings, emoji-only)
- "topicId": required if action is "attach_existing" or "create_node" with existing topic
- "nodeId": required if action is "attach_existing"
- "newTopicTitle": required if action is "create_node" and no suitable topic exists
- "newNodeTitle": required if action is "create_node"
- "reason": brief explanation (1 sentence)
`.trim();

    const { parsed: decision } = await callGemini(prompt, validateDecision, {
      modelTier: "fast",
      timeoutMs: 8000,
    });

    logger.info(
      { workspaceId, gcsPath, action: decision.action, reason: decision.reason },
      "discord node decision",
    );

    if (decision.action === "ignore") {
      return;
    }

    // Ensure topic exists
    let topicId = decision.topicId;
    if (!topicId) {
      topicId = `discord-${crypto.randomUUID().slice(0, 8)}`;
      await this.topicRepository.ensure({
        workspaceId,
        topicId,
        title: decision.newTopicTitle ?? location,
        status: "active",
      });
    }

    if (decision.action === "attach_existing" && decision.nodeId) {
      // Append message as evidence to existing node
      const evidenceId = `discord-${msg.message_id}`;
      await this.db
        .doc(`workspaces/${workspaceId}/topics/${topicId}/nodes/${decision.nodeId}/evidence/${evidenceId}`)
        .set({
          evidenceId,
          source: "discord",
          gcsPath,
          content: msg.content,
          author: msg.author_name,
          location,
          timestamp: msg.timestamp,
          createdAt: FieldValue.serverTimestamp(),
        }, { merge: true });

      // Bump node updatedAt so rollup picks it up
      await this.nodeRepository.upsert({
        workspaceId,
        topicId,
        nodeId: decision.nodeId,
        kind: "claim",
        title: decision.nodeId, // preserve existing title via merge:true
        contextSummary: undefined,
      });

      logger.info({ workspaceId, topicId, nodeId: decision.nodeId, evidenceId }, "evidence attached");
      return;
    }

    if (decision.action === "create_node") {
      const nodeId = `discord-${crypto.randomUUID().slice(0, 8)}`;
      await this.nodeRepository.upsert({
        workspaceId,
        topicId,
        nodeId,
        kind: "claim",
        title: decision.newNodeTitle ?? msg.content.slice(0, 80),
        contextSummary: msg.content.slice(0, 200),
      });

      // Store message as first evidence
      const evidenceId = `discord-${msg.message_id}`;
      await this.db
        .doc(`workspaces/${workspaceId}/topics/${topicId}/nodes/${nodeId}/evidence/${evidenceId}`)
        .set({
          evidenceId,
          source: "discord",
          gcsPath,
          content: msg.content,
          author: msg.author_name,
          location,
          timestamp: msg.timestamp,
          createdAt: FieldValue.serverTimestamp(),
        });

      logger.info({ workspaceId, topicId, nodeId }, "new node created from discord message");
    }
  }
}
