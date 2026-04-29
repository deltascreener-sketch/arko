import { config as loadEnv } from "dotenv";
import { z } from "zod";

loadEnv();

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  SUPABASE_DB_URL: z.string().min(1),
  FMP_API_KEY: z.string().min(1),
  FMP_BASE_URL: z.string().url().default("https://financialmodelingprep.com/stable"),
  FMP_REQUESTS_PER_MINUTE: z.coerce.number().int().positive().default(250),
  FMP_RETRY_ATTEMPTS: z.coerce.number().int().min(0).default(4),
  FMP_BATCH_QUOTE_SIZE: z.coerce.number().int().positive().default(100),
  FMP_PROFILE_BULK_PARTS: z.coerce.number().int().positive().default(40),
  FUNDAMENTALS_BATCH_SIZE: z.coerce.number().int().positive().default(150),
  FUNDAMENTALS_CONCURRENCY: z.coerce.number().int().positive().default(4),
  CRON_TIMEZONE: z.string().default("UTC"),
  RUN_SCHEDULER: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true")
});

export type AppEnv = z.infer<typeof envSchema>;
export const env: AppEnv = envSchema.parse(process.env);
