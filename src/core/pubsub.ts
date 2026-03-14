import { InvalidEventError } from "./errors.js";
import {
  eventEnvelopeSchema,
  pubsubAttributesSchema,
  pubsubPushMessageSchema,
  type EventEnvelope,
  type PubsubAttributes,
  type PubsubPushMessage,
} from "../models/envelope.js";

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

  const envelope = eventEnvelopeSchema.parse(parsedEnvelope);
  const attributes = pubsubAttributesSchema.parse(push.message.attributes);

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
