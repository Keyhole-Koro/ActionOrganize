import type { EventEnvelope } from "../models/envelope.js";

export function getLeaseResourceKey(envelope: EventEnvelope): string | null {
  switch (envelope.type) {
    case "topic.resolved":
    case "draft.updated":
    case "bundle.created":
    case "outline.updated":
    case "topic.metrics.updated":
      return `topic:${envelope.topicId}`;
    case "topic.node_changed":
    case "node.rollup_requested": {
      const nodeId = envelope.payload.nodeId;
      return typeof nodeId === "string" && nodeId.length > 0 ? `node:${nodeId}` : null;
    }
    default:
      return null;
  }
}

