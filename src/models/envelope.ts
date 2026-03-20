import { z } from "zod";

export const eventEnvelopeSchema = z.object({
  schemaVersion: z.string().min(1),
  type: z.string().min(1),
  traceId: z.string().min(1),
  workspaceId: z.string().min(1),
  topicId: z.string().min(1),
  uid: z.string().min(1).optional(),
  idempotencyKey: z.string().min(1),
  emittedAt: z.string().datetime({ offset: true }),
  payload: z.record(z.string(), z.unknown()),
});

export const pubsubAttributesSchema = z.object({
  type: z.string().min(1),
  schemaVersion: z.string().min(1),
  workspaceId: z.string().min(1),
  topicId: z.string().min(1),
  nodeId: z.string().min(1).optional(),
  inputId: z.string().min(1).optional(),
  bundleId: z.string().min(1).optional(),
  draftVersion: z.string().min(1).optional(),
  outlineVersion: z.string().min(1).optional(),
  batchId: z.string().min(1).optional(),
  conversationId: z.string().min(1).optional(),
  threadId: z.string().min(1).optional(),
  chunkId: z.string().min(1).optional(),
});

export const pubsubPushMessageSchema = z.object({
  message: z.object({
    data: z.string().min(1),
    messageId: z.string().min(1).optional(),
    publishTime: z.string().optional(),
    attributes: z.record(z.string(), z.string()).default({}),
    orderingKey: z.string().optional(),
  }),
  subscription: z.string().optional(),
});

export type EventEnvelope = z.infer<typeof eventEnvelopeSchema>;
export type PubsubAttributes = z.infer<typeof pubsubAttributesSchema>;
export type PubsubPushMessage = z.infer<typeof pubsubPushMessageSchema>;
