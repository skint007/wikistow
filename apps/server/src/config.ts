import {
  DEFAULT_CONTENT_LIMITS,
  DEFAULT_DRAFT_RETENTION_MS,
  MIN_VAULT_KDF,
  type ContentLimits,
  type KdfParams,
} from '@wikistow/server';
import { z } from 'zod';

// An empty variable (`AI_MODEL=`) counts as unset.
const unsetIfEmpty = <S extends z.ZodType>(schema: S) =>
  z.preprocess((value) => (value === '' ? undefined : value), schema.optional());

const Env = z.object({
  DATABASE_URL: z.url(),
  /** The origin browsers use, e.g. https://wiki.example. Links in email are built from it. */
  PUBLIC_ORIGIN: z.url({ protocol: /^https?$/ }),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  /** Built web app to serve. Unset in development, where Vite serves it. */
  WEB_DIST: z.string().min(1).optional(),
  /** Where the server and `migrate` find the SQL migrations. Defaults to the source tree. */
  MIGRATIONS_DIR: z.string().min(1).optional(),
  /** Signs session cookies and encrypts Better Auth's secrets at rest. */
  BETTER_AUTH_SECRET: z.string().min(32),
  /**
   * Outgoing mail, optional: an administrator can set it on the admin page
   * instead. For example smtp://user:pass@relay:587, or
   * smtp://127.0.0.1:1025 for Mailpit. Each wins over the admin page.
   */
  SMTP_URL: unsetIfEmpty(z.url()),
  SMTP_FROM: unsetIfEmpty(z.string().min(3)),
  /** Set when a reverse proxy (Traefik) supplies X-Real-IP. Never trust it otherwise. */
  TRUST_PROXY: z.enum(['true', 'false']).default('false'),
  /** Where encrypted attachment files are stored. Back it up with the database. */
  BLOB_DIR: z.string().min(1),
  /** The largest attachment one upload may carry, in MiB. */
  MAX_UPLOAD_MIB: z.coerce.number().int().min(1).max(1024).default(25),
  /** Attachment storage per account, in MiB, counting unpublished copies too. */
  STORAGE_QUOTA_MIB: z.coerce.number().int().min(1).default(5120),
  /** Live items created per account, including agent work and publication openings. */
  MAX_SPACES_PER_ACCOUNT: z.coerce
    .number()
    .int()
    .min(1)
    .max(2_147_483_647)
    .default(DEFAULT_CONTENT_LIMITS.spaces),
  MAX_FOLDERS_PER_ACCOUNT: z.coerce
    .number()
    .int()
    .min(1)
    .max(2_147_483_647)
    .default(DEFAULT_CONTENT_LIMITS.folders),
  MAX_PAGES_PER_ACCOUNT: z.coerce
    .number()
    .int()
    .min(1)
    .max(2_147_483_647)
    .default(DEFAULT_CONTENT_LIMITS.pages),
  /** Days after a draft checkpoint is saved over before it may go, if nothing else needs it. */
  DRAFT_RETENTION_DAYS: z.coerce
    .number()
    .int()
    .min(1)
    .max(36500)
    .default(DEFAULT_DRAFT_RETENTION_MS / (24 * 60 * 60 * 1000)),
  /** Rate limiting can be turned off for browser tests only. */
  RATE_LIMIT: z.enum(['on', 'off']).default('on'),
  /**
   * Wrong passwords an hour for one address, and separately for each device
   * its owner signed in on, refilled steadily. Past that, checks are refused.
   */
  PASSWORD_GUESS_FAILURES: z.coerce.number().int().min(1).default(20),
  /**
   * The AI provider (wikistow.md, AI assistant), optional: an administrator
   * can set it on the admin page instead, and each variable wins over its
   * field there. AI is on once the style, base URL and model are set, here
   * or there; the key is optional, for local servers.
   */
  AI_API_STYLE: unsetIfEmpty(z.enum(['openai', 'anthropic'])),
  /** As each SDK takes it: `https://api.openai.com/v1`, or `https://api.anthropic.com`. */
  AI_BASE_URL: unsetIfEmpty(z.url({ protocol: /^https?$/ })),
  AI_API_KEY: unsetIfEmpty(z.string()),
  AI_MODEL: unsetIfEmpty(z.string().max(200)),
  /** The most a reply may write, in tokens. Clients can't ask for more. Default 4096. */
  AI_MAX_OUTPUT_TOKENS: unsetIfEmpty(z.coerce.number().int().min(1).max(1_000_000)),
  /** AI requests a minute for one account. A tool step is one request. Default 30. */
  AI_REQUESTS_PER_MINUTE: unsetIfEmpty(z.coerce.number().int().min(1).max(1_000_000)),
});

const MIB = 1024 * 1024;

/** The AI provider the server forwards to. The key never leaves the server. */
export type AiConfig = {
  style: 'openai' | 'anthropic';
  baseUrl: string;
  apiKey: string | undefined;
  model: string;
  maxOutputTokens: number;
  requestsPerMinute: number;
};

/** The parts of `AiConfig` the environment sets; settings.ts fills in the rest. */
export type AiEnv = { [K in keyof AiConfig]?: AiConfig[K] | undefined };

export type Config = {
  databaseUrl: string;
  publicOrigin: string;
  port: number;
  webDist: string | undefined;
  migrationsDir: string | undefined;
  authSecret: string;
  /** Mail settings from the environment, which win over the admin page's. */
  smtp: { url: string | undefined; from: string | undefined };
  trustProxy: boolean;
  rateLimit: boolean;
  /** Optional for embedded callers, which use the environment default. */
  passwordGuessesPerHour?: number;
  /** The cheapest vault passphrase wrapper accepted. Lowered only in tests. */
  minKdf: KdfParams;
  blobDir: string;
  draftRetentionMs?: number;
  /** Omitted by embedded servers to use the same account caps as production. */
  contentLimits?: ContentLimits;
  limits: { uploadBytes: number; storageBytes: number };
  /** How long a large owner body may take to arrive. */
  bodyDeadlineMs: number;
  /** The AI provider's settings from the environment, which win over the admin page's. */
  ai?: AiEnv;
};

const LARGE_BODY_DEADLINE_MS = 60_000;

/**
 * Parse settings from the environment. Errors name the variables but never
 * echo their values, which may be secrets.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    const names = parsed.error.issues.map((issue) => issue.path.join('.')).join(', ');
    throw new Error(`Invalid or missing environment variables: ${names}`);
  }
  const e = parsed.data;
  return {
    databaseUrl: e.DATABASE_URL,
    publicOrigin: new URL(e.PUBLIC_ORIGIN).origin,
    port: e.PORT,
    webDist: e.WEB_DIST,
    migrationsDir: e.MIGRATIONS_DIR,
    authSecret: e.BETTER_AUTH_SECRET,
    smtp: { url: e.SMTP_URL, from: e.SMTP_FROM },
    trustProxy: e.TRUST_PROXY === 'true',
    rateLimit: e.RATE_LIMIT === 'on',
    passwordGuessesPerHour: e.PASSWORD_GUESS_FAILURES,
    minKdf: MIN_VAULT_KDF,
    blobDir: e.BLOB_DIR,
    limits: { uploadBytes: e.MAX_UPLOAD_MIB * MIB, storageBytes: e.STORAGE_QUOTA_MIB * MIB },
    draftRetentionMs: e.DRAFT_RETENTION_DAYS * 24 * 60 * 60 * 1000,
    contentLimits: {
      spaces: e.MAX_SPACES_PER_ACCOUNT,
      folders: e.MAX_FOLDERS_PER_ACCOUNT,
      pages: e.MAX_PAGES_PER_ACCOUNT,
    },
    bodyDeadlineMs: LARGE_BODY_DEADLINE_MS,
    ai: {
      style: e.AI_API_STYLE,
      baseUrl: e.AI_BASE_URL,
      apiKey: e.AI_API_KEY,
      model: e.AI_MODEL,
      maxOutputTokens: e.AI_MAX_OUTPUT_TOKENS,
      requestsPerMinute: e.AI_REQUESTS_PER_MINUTE,
    },
  } satisfies Config;
}
