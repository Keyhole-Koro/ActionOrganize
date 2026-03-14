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
    PUBSUB_EMULATOR_HOST: requiredString("PUBSUB_EMULATOR_HOST"),
    PUBSUB_TOPIC_NAME: requiredString("PUBSUB_TOPIC_NAME"),
    PUBSUB_PUBLISH_ENABLED: requiredBooleanString("PUBSUB_PUBLISH_ENABLED"),
    FIRESTORE_EMULATOR_HOST: requiredString("FIRESTORE_EMULATOR_HOST"),
    STORAGE_EMULATOR_HOST: requiredString("STORAGE_EMULATOR_HOST"),
    ORGANIZE_GCS_BUCKET: requiredString("ORGANIZE_GCS_BUCKET"),
    LEASE_TTL_SECONDS: requiredPositiveInt("LEASE_TTL_SECONDS"),
    VERTEX_USE_REAL_API: requiredBooleanString("VERTEX_USE_REAL_API"),
    GEMINI_API_KEY: z.string().trim().min(1).optional(),
  })
  .superRefine((data, ctx) => {
    if (data.VERTEX_USE_REAL_API && !data.GEMINI_API_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "GEMINI_API_KEY is required when VERTEX_USE_REAL_API=true",
        path: ["GEMINI_API_KEY"],
      });
    }
  });

export type AppEnv = z.infer<typeof envSchema>;

export const env = envSchema.parse(process.env);
