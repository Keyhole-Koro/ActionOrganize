import { z } from "zod";

const storedAssetRefSchema = z.object({
  assetId: z.string().min(1),
  messageId: z.string().min(1),
  kind: z.literal("image"),
  mimeType: z.string().min(1),
  gcsUri: z.string().min(1),
  downloadUrl: z.string().min(1).optional(),
  originalPath: z.string().min(1),
});

export const organizeChunkJobSchema = z.object({
  sourceType: z.literal("chat_history"),
  batchId: z.string().min(1),
  conversationId: z.string().min(1),
  threadId: z.string().min(1),
  chunkId: z.string().min(1),
  chunkIndex: z.number().int().nonnegative(),
  inputId: z.string().min(1),
  estimatedInputTokens: z.number().int().positive(),
  reservedOutputTokens: z.number().int().nonnegative(),
  priority: z.enum(["high", "normal", "low"]),
  timeRange: z.object({
    start: z.string().datetime({ offset: true }),
    end: z.string().datetime({ offset: true }),
  }),
  messageIds: z.array(z.string().min(1)),
  text: z.string().min(1),
  assetRefs: z.array(storedAssetRefSchema).default([]),
});

export type OrganizeChunkJob = z.infer<typeof organizeChunkJobSchema>;
