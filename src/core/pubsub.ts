import { InvalidEventError } from "./errors.js";
import {
  eventEnvelopeSchema,
  pubsubAttributesSchema,
  pubsubPushMessageSchema,
  type EventEnvelope,
  type PubsubAttributes,
  type PubsubPushMessage,
} from "../models/envelope.js";

type LegacyEvent = {
  type: string;
  payload: Record<string, unknown>;
};

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function deriveTopicId(type: string, payload: Record<string, unknown>): string {
  const explicitTopicId = asNonEmptyString(payload.topicId);
  if (explicitTopicId) {
    return explicitTopicId;
  }

  const inputId = asNonEmptyString(payload.inputId);
  if (inputId) {
    return `topic:${inputId}`;
  }

  throw new InvalidEventError(`legacy ${type} event must include payload.topicId or payload.inputId`);
}

function parseLegacyEvent(parsedEnvelope: unknown): LegacyEvent | null {
  if (!parsedEnvelope || typeof parsedEnvelope !== "object") {
    return null;
  }

  const type = asNonEmptyString((parsedEnvelope as { type?: unknown }).type);
  const payload = (parsedEnvelope as { payload?: unknown }).payload;
  if (!type || !payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }

  return {
    type,
    payload: payload as Record<string, unknown>,
  };
}

export type DecodedPushEvent = {
  push: PubsubPushMessage;
  envelope: EventEnvelope;
  attributes: PubsubAttributes;
};

export function decodePushEvent(input: unknown): DecodedPushEvent {
  const push = pubsubPushMessageSchema.parse(input);

  let decodedData = "";
  try {
    decodedData = Buffer.from(push.message.data, "base64").toString("utf8");
  } catch {
    throw new InvalidEventError("message.data must be valid base64");
  }

  let parsedEnvelope: unknown;
  try {
    parsedEnvelope = JSON.parse(decodedData);
  } catch {
    throw new InvalidEventError("message.data must decode to JSON");
  }

  let envelope: EventEnvelope;
  let attributes: PubsubAttributes;

  try {
    envelope = eventEnvelopeSchema.parse(parsedEnvelope);
    attributes = pubsubAttributesSchema.parse(push.message.attributes);
  } catch {
    const legacy = parseLegacyEvent(parsedEnvelope);
    if (!legacy) {
      throw new InvalidEventError("message.data must be an Organize envelope or legacy event format");
    }

    const workspaceId = asNonEmptyString(legacy.payload.workspaceId);
    if (!workspaceId) {
      throw new InvalidEventError("legacy event payload.workspaceId is required");
    }

    const topicId = deriveTopicId(legacy.type, legacy.payload);
    const inputId = asNonEmptyString(legacy.payload.inputId);
    const messageId = push.message.messageId ?? "no-message-id";
    const idempotencyKey =
      asNonEmptyString(legacy.payload.idempotencyKey) ??
      `legacy:type:${legacy.type}/workspaceId:${workspaceId}/topicId:${topicId}/messageId:${messageId}`;

    envelope = eventEnvelopeSchema.parse({
      schemaVersion: "1",
      type: legacy.type,
      traceId: asNonEmptyString(legacy.payload.traceId) ?? `legacy:${messageId}`,
      workspaceId,
      topicId,
      uid: asNonEmptyString(legacy.payload.uid),
      idempotencyKey,
      emittedAt: new Date().toISOString(),
      payload: legacy.payload,
    });

    attributes = pubsubAttributesSchema.parse({
      type: envelope.type,
      schemaVersion: envelope.schemaVersion,
      workspaceId: envelope.workspaceId,
      topicId: envelope.topicId,
      inputId,
    });
  }

  if (attributes.type !== envelope.type) {
    throw new InvalidEventError("attributes.type does not match envelope.type");
  }
  if (attributes.schemaVersion !== envelope.schemaVersion) {
    throw new InvalidEventError("attributes.schemaVersion does not match envelope.schemaVersion");
  }
  if (attributes.workspaceId !== envelope.workspaceId) {
    throw new InvalidEventError("attributes.workspaceId does not match envelope.workspaceId");
  }
  if (attributes.topicId !== envelope.topicId) {
    throw new InvalidEventError("attributes.topicId does not match envelope.topicId");
  }

  return { push, envelope, attributes };
}
