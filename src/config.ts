import 'dotenv/config';
import { z } from 'zod';
import path from 'node:path';

const PathsSchema = z.object({
  DATA_DIR: z.string().default('./data'),
});

const SecretsSchema = z.object({
  IBD_USER: z.string().min(1, 'IBD_USER is required'),
  IBD_PASSWORD: z.string().min(1, 'IBD_PASSWORD is required'),

  GMAIL_USER: z.string().email('GMAIL_USER must be a valid email'),
  GMAIL_APP_PASSWORD: z.string().min(1, 'GMAIL_APP_PASSWORD is required'),
  EMAIL_TO: z.string().min(1, 'EMAIL_TO is required'),
  EMAIL_FROM: z.string().optional(),

  SKIP_EARLY_CLOSE_DAYS: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),

  MIN_COMP_RATING: z
    .string()
    .default('94')
    .transform((v) => Number.parseInt(v, 10))
    .pipe(z.number().int().min(0).max(99)),

  MAX_RESULTS: z
    .string()
    .default('100')
    .transform((v) => Number.parseInt(v, 10))
    .pipe(z.number().int().min(0).max(2000)),
});

export type AppPaths = {
  dataDir: string;
  storageStateFile: string;
  lastStateFile: string;
  holidaysFile: string;
};

export type AppConfig = {
  ibd: { user: string; password: string };
  email: { user: string; appPassword: string; to: string; from: string };
  schedule: { skipEarlyCloseDays: boolean };
  screener: { minCompRating: number; maxResults: number };
  paths: AppPaths;
};

function buildPaths(dataDirRaw: string): AppPaths {
  const dataDir = path.resolve(dataDirRaw);
  return {
    dataDir,
    storageStateFile: path.join(dataDir, 'storage-state.json'),
    lastStateFile: path.join(dataDir, 'last-state.json'),
    holidaysFile: path.join(dataDir, 'market-holidays.json'),
  };
}

function formatZodIssues(error: z.ZodError): string {
  return error.issues
    .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('\n');
}

/** Lightweight loader for commands (e.g. `login`) that only need filesystem paths. */
export function loadPaths(): AppPaths {
  const parsed = PathsSchema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(`Invalid environment configuration:\n${formatZodIssues(parsed.error)}`);
  }
  return buildPaths(parsed.data.DATA_DIR);
}

let cached: AppConfig | null = null;

/** Full loader for commands (e.g. `scan`, `schedule`) that need credentials. */
export function loadConfig(): AppConfig {
  if (cached) return cached;

  const pathsParsed = PathsSchema.safeParse(process.env);
  const secretsParsed = SecretsSchema.safeParse(process.env);

  if (!pathsParsed.success || !secretsParsed.success) {
    const errs = [pathsParsed, secretsParsed]
      .filter((r): r is z.SafeParseError<unknown> => !r.success)
      .map((r) => formatZodIssues(r.error))
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${errs}`);
  }

  const env = secretsParsed.data;
  cached = {
    ibd: { user: env.IBD_USER, password: env.IBD_PASSWORD },
    email: {
      user: env.GMAIL_USER,
      appPassword: env.GMAIL_APP_PASSWORD,
      to: env.EMAIL_TO,
      from: env.EMAIL_FROM ?? env.GMAIL_USER,
    },
    schedule: { skipEarlyCloseDays: env.SKIP_EARLY_CLOSE_DAYS },
    screener: { minCompRating: env.MIN_COMP_RATING, maxResults: env.MAX_RESULTS },
    paths: buildPaths(pathsParsed.data.DATA_DIR),
  };
  return cached;
}
