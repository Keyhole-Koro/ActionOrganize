import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(8090),
  GOOGLE_CLOUD_PROJECT: z.string().default("local-dev"),
  PUBSUB_EMULATOR_HOST: z.string().default("localhost:8085"),
  FIRESTORE_EMULATOR_HOST: z.string().default("localhost:8081"),
  STORAGE_EMULATOR_HOST: z.string().default("http://localhost:4443"),
  VERTEX_USE_REAL_API: z
    .string()
    .optional()
    .transform((value) => value === "true"),
});

export type AppEnv = z.infer<typeof envSchema>;

export const env = envSchema.parse(process.env);
