import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(8090),
  STATE_BACKEND: z.enum(["memory", "firestore"]).default("memory"),
  GOOGLE_CLOUD_PROJECT: z.string().default("local-dev"),
  PUBSUB_EMULATOR_HOST: z.string().default("localhost:8085"),
  PUBSUB_TOPIC_NAME: z.string().default("mind-events"),
  PUBSUB_PUBLISH_ENABLED: z
    .string()
    .optional()
    .transform((value) => value === "true"),
  FIRESTORE_EMULATOR_HOST: z.string().default("localhost:8081"),
  STORAGE_EMULATOR_HOST: z.string().default("http://localhost:4443"),
  LEASE_TTL_SECONDS: z.coerce.number().int().positive().default(120),
  VERTEX_USE_REAL_API: z
    .string()
    .optional()
    .transform((value) => value === "true"),
});

export type AppEnv = z.infer<typeof envSchema>;

export const env = envSchema.parse(process.env);
