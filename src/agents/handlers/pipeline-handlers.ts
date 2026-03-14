import { InvalidEventError } from "../../core/errors.js";
import { A0A1WriteService } from "../../services/a0-a1-write-service.js";
import { A2DraftAppenderService } from "../../services/a2-draft-appender-service.js";
import { A5BalancerService } from "../../services/a5-balancer-service.js";
import { PipelineWriteService } from "../../services/pipeline-write-service.js";
import { TopicResolverService } from "../../services/topic-resolver-service.js";
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
const draftAppenderService = new A2DraftAppenderService();
const a5BalancerService = new A5BalancerService();
const pipelineWriteService = new PipelineWriteService();
const topicResolverService = new TopicResolverService();

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
          idempotencyKey: `type:input.received/topicId:${envelope.topicId}/inputId:${inputId}`,
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
          idempotencyKey: `type:atom.created/topicId:${envelope.topicId}/inputId:${inputId}`,
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
    const resolution = await topicResolverService.resolve(envelope, inputId, atomIds);

    return {
      ack: true,
      emittedEvents: [
        {
          type: "topic.resolved",
          topicId: resolution.resolvedTopicId,
          orderingKey: resolution.resolvedTopicId,
          idempotencyKey: `type:topic.resolved/topicId:${resolution.resolvedTopicId}/inputId:${inputId}`,
          payload: {
            resolvedTopicId: resolution.resolvedTopicId,
            inputId,
            atomIds,
            resolutionMode: resolution.resolutionMode,
            resolutionConfidence: resolution.resolutionConfidence,
            resolutionReason: resolution.resolutionReason,
            topicLifecycleStateAtResolution: resolution.topicLifecycleStateAtResolution,
            candidateTopicIds: resolution.candidateTopicIds,
            candidateTopicStates: resolution.candidateTopicStates,
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
    optionalString(envelope.payload, "resolutionReason");
    optionalString(envelope.payload, "topicLifecycleStateAtResolution");

    await writeService.onTopicResolved(envelope, inputId, resolvedTopicId, resolutionMode);
    const { draftVersion } = await draftAppenderService.appendDraft(
      envelope,
      resolvedTopicId,
      inputId,
      atomIds,
      resolutionMode,
    );

    return {
      ack: true,
      emittedEvents: [
        {
          type: "draft.updated",
          topicId: resolvedTopicId,
          orderingKey: resolvedTopicId,
          idempotencyKey: `type:draft.updated/topicId:${resolvedTopicId}/draftVersion:${draftVersion}`,
          payload: {
            topicId: resolvedTopicId,
            draftVersion,
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
    const appendedAtomIds = requireStringArray(envelope.payload, "appendedAtomIds");
    const inputId = optionalString(envelope.payload, "inputId");
    const { bundleId } = await pipelineWriteService.onDraftUpdated(
      envelope,
      draftVersion,
      appendedAtomIds,
      inputId,
    );

    return {
      ack: true,
      emittedEvents: [
        {
          type: "bundle.created",
          topicId: envelope.topicId,
          orderingKey: envelope.topicId,
          idempotencyKey: `type:bundle.created/topicId:${envelope.topicId}/bundleId:${bundleId}`,
          payload: {
            topicId: envelope.topicId,
            bundleId,
            sourceDraftVersion: draftVersion,
            inputId,
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
    const inputId = optionalString(envelope.payload, "inputId");
    const {
      outlineVersion,
      changedNodeIds,
      descRef,
      reissuedAtomIds = [],
    } = await pipelineWriteService.onBundleCreated(
      envelope,
      bundleId,
      sourceDraftVersion,
      inputId,
    );

    return {
      ack: true,
      emittedEvents: [
        {
          type: "bundle.described",
          topicId: envelope.topicId,
          idempotencyKey: `type:bundle.described/topicId:${envelope.topicId}/bundleId:${bundleId}`,
          payload: {
            topicId: envelope.topicId,
            bundleId,
            descRef,
          },
        },
        {
          type: "outline.updated",
          topicId: envelope.topicId,
          orderingKey: envelope.topicId,
          idempotencyKey: `type:outline.updated/topicId:${envelope.topicId}/outlineVersion:${outlineVersion}`,
          payload: {
            topicId: envelope.topicId,
            bundleId,
            outlineVersion,
            changedNodeIds,
            inputId,
          },
        },
        ...reissuedAtomIds.map((atomId) => ({
          type: "atom.reissued",
          topicId: envelope.topicId,
          idempotencyKey: `type:atom.reissued/topicId:${envelope.topicId}/atomId:${atomId}/bundleId:${bundleId}`,
          payload: {
            topicId: envelope.topicId,
            atomId,
            reason: "schema_incompatible_or_low_confidence",
          },
        })),
      ],
    };
  }
}

class BundleDescribedHandler implements AgentHandler {
  readonly eventType = "bundle.described";

  async handle({ envelope }: AgentContext): Promise<AgentResult> {
    const bundleId = requireString(envelope.payload, "bundleId");
    const descRef = requireString(envelope.payload, "descRef");
    await pipelineWriteService.onBundleDescribed(envelope, bundleId, descRef);
    return { ack: true, emittedEvents: [] };
  }
}

class TopicSchemaUpdatedHandler implements AgentHandler {
  readonly eventType = "topic.schema_updated";

  async handle({ envelope }: AgentContext): Promise<AgentResult> {
    const schemaVersion = requireNumber(envelope.payload, "schemaVersion");
    await pipelineWriteService.onTopicSchemaUpdated(envelope, schemaVersion);
    return { ack: true, emittedEvents: [] };
  }
}

class OutlineUpdatedHandler implements AgentHandler {
  readonly eventType = "outline.updated";

  async handle({ envelope }: AgentContext): Promise<AgentResult> {
    const changedNodeIds = requireStringArray(envelope.payload, "changedNodeIds");
    const outlineVersion = requireNumber(envelope.payload, "outlineVersion");

    await pipelineWriteService.onOutlineUpdated(envelope, outlineVersion, changedNodeIds);

    return {
      ack: true,
      emittedEvents: changedNodeIds.map((nodeId) => ({
        type: "topic.node_changed",
        topicId: envelope.topicId,
        orderingKey: nodeId,
        idempotencyKey: `type:topic.node_changed/topicId:${envelope.topicId}/nodeId:${nodeId}/generation:${outlineVersion}`,
        payload: {
          topicId: envelope.topicId,
          nodeId,
          reason: "outline.updated",
          generation: outlineVersion,
        },
      })),
    };
  }
}

class TopicNodeChangedHandler implements AgentHandler {
  readonly eventType = "topic.node_changed";

  async handle({ envelope }: AgentContext): Promise<AgentResult> {
    const nodeId = requireString(envelope.payload, "nodeId");
    const generation =
      typeof envelope.payload.generation === "number" ? envelope.payload.generation : 1;

    return {
      ack: true,
      emittedEvents: [
        {
          type: "node.rollup_requested",
          topicId: envelope.topicId,
          orderingKey: nodeId,
          idempotencyKey: `type:node.rollup_requested/topicId:${envelope.topicId}/nodeId:${nodeId}/generation:${generation}`,
          payload: {
            topicId: envelope.topicId,
            nodeId,
            generation,
          },
        },
      ],
    };
  }
}

class NodeRollupRequestedHandler implements AgentHandler {
  readonly eventType = "node.rollup_requested";

  async handle({ envelope }: AgentContext): Promise<AgentResult> {
    const nodeId = requireString(envelope.payload, "nodeId");
    const generation = requireNumber(envelope.payload, "generation");
    const result = await pipelineWriteService.onNodeRollupRequested(envelope, nodeId, generation);
    return {
      ack: true,
      emittedEvents: [
        {
          type: "node.rollup.updated",
          topicId: result.topicId,
          idempotencyKey: `type:node.rollup.updated/topicId:${result.topicId}/nodeId:${result.nodeId}/generation:${generation}`,
          payload: {
            topicId: result.topicId,
            nodeId: result.nodeId,
          },
        },
      ],
    };
  }
}

class TopicMetricsUpdatedHandler implements AgentHandler {
  readonly eventType = "topic.metrics.updated";

  async handle({ envelope }: AgentContext): Promise<AgentResult> {
    const { topicId, nodeIds, generation } = await a5BalancerService.onTopicMetricsUpdated(envelope);
    return {
      ack: true,
      emittedEvents: nodeIds.map((nodeId) => ({
        type: "topic.node_changed",
        topicId,
        orderingKey: nodeId,
        idempotencyKey: `type:topic.node_changed/topicId:${topicId}/nodeId:${nodeId}/generation:${generation}`,
        payload: {
          topicId,
          nodeId,
          reason: "topic.metrics.updated",
          generation,
        },
      })),
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
  new BundleDescribedHandler(),
  new TopicSchemaUpdatedHandler(),
  new OutlineUpdatedHandler(),
  new TopicNodeChangedHandler(),
  new NodeRollupRequestedHandler(),
  new TopicMetricsUpdatedHandler(),
];
