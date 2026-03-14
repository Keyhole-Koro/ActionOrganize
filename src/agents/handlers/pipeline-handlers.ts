import { InvalidEventError } from "../../core/errors.js";
import { A0A1WriteService } from "../../services/a0-a1-write-service.js";
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

function optionalString(payload: Payload, key: string): string | undefined {
  const value = payload[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value.length === 0) {
    throw new InvalidEventError(`payload.${key} must be a string`);
  }
  return value;
}

const writeService = new A0A1WriteService();

class MediaReceivedHandler implements AgentHandler {
  readonly eventType = "media.received";

  async handle({ envelope }: AgentContext): Promise<AgentResult> {
    const inputId = requireString(envelope.payload, "inputId");

    await writeService.onMediaReceived(envelope, inputId);

    return {
      ack: true,
      emittedEvents: [
        {
          type: "input.received",
          topicId: envelope.topicId,
          payload: { topicId: envelope.topicId, inputId },
        },
      ],
    };
  }
}

class InputReceivedHandler implements AgentHandler {
  readonly eventType = "input.received";

  async handle({ envelope }: AgentContext): Promise<AgentResult> {
    const inputId = requireString(envelope.payload, "inputId");
    const atomIds = [`atom:${envelope.topicId}:${inputId}:0`];

    await writeService.onInputReceived(envelope, inputId, atomIds);

    return {
      ack: true,
      emittedEvents: [
        {
          type: "atom.created",
          topicId: envelope.topicId,
          payload: { topicId: envelope.topicId, inputId, atomIds },
        },
      ],
    };
  }
}

class AtomCreatedHandler implements AgentHandler {
  readonly eventType = "atom.created";

  async handle({ envelope }: AgentContext): Promise<AgentResult> {
    const inputId = requireString(envelope.payload, "inputId");
    const atomIds = requireStringArray(envelope.payload, "atomIds");

    return {
      ack: true,
      emittedEvents: [
        {
          type: "topic.resolved",
          topicId: envelope.topicId,
          orderingKey: envelope.topicId,
          payload: {
            resolvedTopicId: envelope.topicId,
            inputId,
            atomIds,
            resolutionMode: "attach_existing",
            resolutionConfidence: 0.8,
          },
        },
      ],
    };
  }
}

class TopicResolvedHandler implements AgentHandler {
  readonly eventType = "topic.resolved";

  async handle({ envelope }: AgentContext): Promise<AgentResult> {
    const resolvedTopicId = requireString(envelope.payload, "resolvedTopicId");
    const inputId = requireString(envelope.payload, "inputId");
    const atomIds = requireStringArray(envelope.payload, "atomIds");
    const resolutionMode = requireString(envelope.payload, "resolutionMode");

    await writeService.onTopicResolved(envelope, inputId, resolvedTopicId, resolutionMode);

    return {
      ack: true,
      emittedEvents: [
        {
          type: "draft.updated",
          topicId: resolvedTopicId,
          orderingKey: resolvedTopicId,
          payload: {
            topicId: resolvedTopicId,
            draftVersion: 1,
            appendedAtomIds: atomIds,
            inputId,
          },
        },
      ],
    };
  }
}

class DraftUpdatedHandler implements AgentHandler {
  readonly eventType = "draft.updated";

  async handle({ envelope }: AgentContext): Promise<AgentResult> {
    const draftVersion = requireNumber(envelope.payload, "draftVersion");

    return {
      ack: true,
      emittedEvents: [
        {
          type: "bundle.created",
          topicId: envelope.topicId,
          orderingKey: envelope.topicId,
          payload: {
            topicId: envelope.topicId,
            bundleId: `bundle:${envelope.topicId}:v${draftVersion}`,
            sourceDraftVersion: draftVersion,
          },
        },
      ],
    };
  }
}

class BundleCreatedHandler implements AgentHandler {
  readonly eventType = "bundle.created";

  async handle({ envelope }: AgentContext): Promise<AgentResult> {
    const bundleId = requireString(envelope.payload, "bundleId");
    const sourceDraftVersion = requireNumber(envelope.payload, "sourceDraftVersion");

    return {
      ack: true,
      emittedEvents: [
        {
          type: "outline.updated",
          topicId: envelope.topicId,
          orderingKey: envelope.topicId,
          payload: {
            topicId: envelope.topicId,
            bundleId,
            outlineVersion: sourceDraftVersion,
            changedNodeIds: [`node:${envelope.topicId}:root`],
          },
        },
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
        orderingKey: nodeId,
        payload: {
          topicId: envelope.topicId,
          nodeId,
          reason: "outline.updated",
        },
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
      emittedEvents: [
        {
          type: "node.rollup_requested",
          topicId: envelope.topicId,
          orderingKey: nodeId,
          payload: {
            topicId: envelope.topicId,
            nodeId,
            generation: 1,
          },
        },
      ],
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
    const topicId = optionalString(envelope.payload, "topicId") ?? envelope.topicId;
    return {
      ack: true,
      emittedEvents: [
        {
          type: "topic.node_changed",
          topicId,
          orderingKey: topicId,
          payload: {
            topicId,
            nodeId: `node:${topicId}:root`,
            reason: "topic.metrics.updated",
          },
        },
      ],
    };
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
