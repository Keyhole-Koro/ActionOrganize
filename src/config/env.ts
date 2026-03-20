import { z } from "zod";

const requiredString = (name: string) =>
  z.string().trim().min(1, `${name} is required`);

const requiredBooleanString = (name: string) =>
  z
    .enum(["true", "false"], {
      error: () => `${name} must be "true" or "false"`,
    })
    .transform((value) => value === "true");

const requiredPositiveInt = (name: string) =>
  z.coerce
    .number({
      error: () => `${name} must be an integer`,
    })
    .int(`${name} must be an integer`)
    .positive(`${name} must be greater than 0`);

const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: requiredPositiveInt("PORT"),
    STATE_BACKEND: z.enum(["memory", "firestore"], {
      error: () => 'STATE_BACKEND must be "memory" or "firestore"',
    }),
    GOOGLE_CLOUD_PROJECT: requiredString("GOOGLE_CLOUD_PROJECT"),
    PUBSUB_EMULATOR_HOST: z.string().trim().default(""),
    PUBSUB_TOPIC_NAME: requiredString("PUBSUB_TOPIC_NAME"),
    PUBSUB_PUBLISH_ENABLED: requiredBooleanString("PUBSUB_PUBLISH_ENABLED"),
    FIRESTORE_EMULATOR_HOST: z.string().trim().default(""),
    STORAGE_EMULATOR_HOST: z.string().trim().default(""),
    ORGANIZE_GCS_BUCKET: requiredString("ORGANIZE_GCS_BUCKET"),
    LEASE_TTL_SECONDS: requiredPositiveInt("LEASE_TTL_SECONDS"),
    GOOGLE_API_KEY: requiredString("GOOGLE_API_KEY"),
    GEMINI_MODEL_FAST: z.string().default("gemini-3-flash-preview"),
    GEMINI_MODEL_QUALITY: z.string().default("gemini-3.1-pro-preview"),
    LLM_LIMITER_REDIS_URL: requiredString("LLM_LIMITER_REDIS_URL"),
    LLM_LIMITER_TARGET_TPM: requiredPositiveInt("LLM_LIMITER_TARGET_TPM"),
    LLM_LIMITER_TARGET_RPM: requiredPositiveInt("LLM_LIMITER_TARGET_RPM"),
    LLM_LIMITER_MAX_CONCURRENCY: requiredPositiveInt("LLM_LIMITER_MAX_CONCURRENCY"),
  });

export type AppEnv = z.infer<typeof envSchema>;

export const env = envSchema.parse(process.env);
