import { InvalidEventError } from "../../core/errors.js";
import type { AgentContext, AgentHandler, AgentResult } from "../types.js";

type Payload = Record<string, unknown>;

function requireString(payload: Payload, key: string): string {
  const value = payload[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new InvalidEventError(`payload.${key} is required`);
  }
  return value;
}

function requireStringArray(payload: Payload, key: string): string[] {
  const value = payload[key];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new InvalidEventError(`payload.${key} must be a string array`);
  }
  return value;
}

function requireNumber(payload: Payload, key: string): number {
  const value = payload[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new InvalidEventError(`payload.${key} must be a number`);
  }
  return value;
}

class MediaReceivedHandler implements AgentHandler {
  readonly eventType = "media.received";

  async handle({ envelope }: AgentContext): Promise<AgentResult> {
    const inputId = requireString(envelope.payload, "inputId");

    return {
      ack: true,
      emittedEvents: [{ type: "input.received", topicId: envelope.topicId, inputId }],
    };
  }
}

class InputReceivedHandler implements AgentHandler {
  readonly eventType = "input.received";

  async handle({ envelope }: AgentContext): Promise<AgentResult> {
    const inputId = requireString(envelope.payload, "inputId");

    return {
      ack: true,
      emittedEvents: [{ type: "atom.created", topicId: envelope.topicId, inputId }],
    };
  }
}

class AtomCreatedHandler implements AgentHandler {
  readonly eventType = "atom.created";

  async handle({ envelope }: AgentContext): Promise<AgentResult> {
    const inputId = requireString(envelope.payload, "inputId");

    return {
      ack: true,
      emittedEvents: [{ type: "topic.resolved", topicId: envelope.topicId, inputId }],
    };
  }
}

class TopicResolvedHandler implements AgentHandler {
  readonly eventType = "topic.resolved";

  async handle({ envelope }: AgentContext): Promise<AgentResult> {
    const resolvedTopicId = requireString(envelope.payload, "resolvedTopicId");
    const inputId = requireString(envelope.payload, "inputId");

    return {
      ack: true,
      emittedEvents: [{ type: "draft.updated", topicId: resolvedTopicId, inputId }],
    };
  }
}

class DraftUpdatedHandler implements AgentHandler {
  readonly eventType = "draft.updated";

  async handle({ envelope }: AgentContext): Promise<AgentResult> {
    const draftVersion = requireNumber(envelope.payload, "draftVersion");

    return {
      ack: true,
      emittedEvents: [{ type: "bundle.created", topicId: envelope.topicId, draftVersion }],
    };
  }
}

class BundleCreatedHandler implements AgentHandler {
  readonly eventType = "bundle.created";

  async handle({ envelope }: AgentContext): Promise<AgentResult> {
    const bundleId = requireString(envelope.payload, "bundleId");

    return {
      ack: true,
      emittedEvents: [
        { type: "bundle.described", topicId: envelope.topicId, bundleId },
        { type: "outline.updated", topicId: envelope.topicId, bundleId },
      ],
    };
  }
}

class TopicSchemaUpdatedHandler implements AgentHandler {
  readonly eventType = "topic.schema_updated";

  async handle({ envelope }: AgentContext): Promise<AgentResult> {
    requireNumber(envelope.payload, "schemaVersion");
    return { ack: true, emittedEvents: [] };
  }
}

class OutlineUpdatedHandler implements AgentHandler {
  readonly eventType = "outline.updated";

  async handle({ envelope }: AgentContext): Promise<AgentResult> {
    requireNumber(envelope.payload, "outlineVersion");
    const changedNodeIds = requireStringArray(envelope.payload, "changedNodeIds");

    return {
      ack: true,
      emittedEvents: changedNodeIds.map((nodeId) => ({
        type: "topic.node_changed",
        topicId: envelope.topicId,
        nodeId,
      })),
    };
  }
}

class TopicNodeChangedHandler implements AgentHandler {
  readonly eventType = "topic.node_changed";

  async handle({ envelope }: AgentContext): Promise<AgentResult> {
    const nodeId = requireString(envelope.payload, "nodeId");

    return {
      ack: true,
      emittedEvents: [{ type: "node.rollup_updated", topicId: envelope.topicId, nodeId }],
    };
  }
}

class NodeRollupRequestedHandler implements AgentHandler {
  readonly eventType = "node.rollup_requested";

  async handle({ envelope }: AgentContext): Promise<AgentResult> {
    requireString(envelope.payload, "nodeId");
    return { ack: true, emittedEvents: [] };
  }
}

class TopicMetricsUpdatedHandler implements AgentHandler {
  readonly eventType = "topic.metrics.updated";

  async handle({ envelope }: AgentContext): Promise<AgentResult> {
    requireString(envelope.payload, "topicId");
    return { ack: true, emittedEvents: [] };
  }
}

export const pipelineHandlers: AgentHandler[] = [
  new MediaReceivedHandler(),
  new InputReceivedHandler(),
  new AtomCreatedHandler(),
  new TopicResolvedHandler(),
  new DraftUpdatedHandler(),
  new BundleCreatedHandler(),
  new TopicSchemaUpdatedHandler(),
  new OutlineUpdatedHandler(),
  new TopicNodeChangedHandler(),
  new NodeRollupRequestedHandler(),
  new TopicMetricsUpdatedHandler(),
];
