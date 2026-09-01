import 'dotenv/config';
import { z } from 'zod';

export const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/** Parse an env var as an integer within [min, max], defaulting when unset. */
const intInRange = (min: number, max: number, defaultValue: number) =>
  z.preprocess((v) => (v === undefined ? defaultValue : Number(v)), z.number().int().min(min).max(max));

const trustedProxy = z.preprocess(
  (v) => (v === undefined ? undefined : String(v).trim().toLowerCase()),
  z.enum(['true', 'false']).optional().transform((v) => v === 'true'),
);

const redisUrl = z.preprocess(
  (v) => (v === undefined || String(v).trim() === '' ? undefined : v),
  z
    .string()
    .refine((s) => /^rediss?:\/\//.test(s), 'expected a redis:// or rediss:// URL')
    .optional(),
);

const demoConfigSchema = z
  .object({
    PORT: intInRange(1, 65_535, 3000),
    REDIS_URL: redisUrl,
    TRUST_PROXY: trustedProxy,
    LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
    FAILOVER_THRESHOLD: intInRange(1, 1_000_000, 3),
    FAILOVER_RECOVERY_MS: intInRange(1, 86_400_000, 30_000),
    FAILOVER_SUCCESS_THRESHOLD: intInRange(1, 1_000_000, 1),
  })
  .transform((e) => ({
    port: e.PORT,
    redisUrl: e.REDIS_URL,
    trustProxy: e.TRUST_PROXY,
    logLevel: e.LOG_LEVEL,
    failOver: {
      failureThreshold: e.FAILOVER_THRESHOLD,
      recoveryTimeoutMs: e.FAILOVER_RECOVERY_MS,
      successThreshold: e.FAILOVER_SUCCESS_THRESHOLD,
    },
  }));

export type DemoConfig = z.infer<typeof demoConfigSchema>;

/** Read all demo configuration, failing fast with a clear message on invalid values. */
export function readConfig(env: NodeJS.ProcessEnv): DemoConfig {
  const result = demoConfigSchema.safeParse(env);
  if (!result.success) {
    const detail = result.error.issues
      .map((i) => `${i.path.join('.') || 'config'}: ${i.message}`)
      .join('; ');
    throw new Error(`Invalid configuration: ${detail}`);
  }
  return result.data;
}
