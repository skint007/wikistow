import type { AiSettings, MailSettings } from '@wikistow/server';
import type { AiConfig, AiEnv, Config } from './config.ts';
import type { MailSetup } from './mail/mailer.ts';

// Settings an administrator can change on the admin page. A variable in the
// server's environment wins over the field it covers, and the page shows
// that field read-only.

const CONNECTION = ['host', 'port', 'security', 'username', 'password'] as const;

/** Mail fields the environment sets: `SMTP_URL` the connection, `SMTP_FROM` the sender. */
export function mailFromEnvironment(env: Config['smtp']) {
  return [...(env.url ? CONNECTION : []), ...(env.from ? (['from'] as const) : [])];
}

/** What mail goes out with, or null when it isn't fully set up. */
export function mailSetup(env: Config['smtp'], saved: MailSettings): MailSetup | null {
  const from = env.from ?? saved.from;
  const { host, port, security, username, password } = saved;
  const connection = env.url
    ? { url: env.url }
    : host && port && security
      ? { host, port, security, username, password }
      : null;
  return from && connection ? { from, connection } : null;
}

const AI_DEFAULTS = { maxOutputTokens: 4096, requestsPerMinute: 30 };

const AI_FIELDS = [
  'style',
  'baseUrl',
  'apiKey',
  'model',
  'maxOutputTokens',
  'requestsPerMinute',
] as const satisfies readonly (keyof AiConfig)[];

/** AI fields the environment sets, one `AI_*` variable each. */
export function aiFromEnvironment(env: AiEnv = {}) {
  return AI_FIELDS.filter((field) => env[field] !== undefined);
}

/**
 * The AI provider requests go to, each field from the environment if set
 * there, else as saved; null (AI off) without a style, base URL and model.
 */
export function aiSetup(env: AiEnv = {}, saved: AiSettings): AiConfig | null {
  const style = env.style ?? saved.style;
  const baseUrl = env.baseUrl ?? saved.baseUrl;
  const model = env.model ?? saved.model;
  if (!style || !baseUrl || !model) return null;
  return {
    style,
    baseUrl: baseUrl.replace(/\/+$/, ''),
    apiKey: env.apiKey ?? saved.apiKey ?? undefined,
    model,
    maxOutputTokens: env.maxOutputTokens ?? saved.maxOutputTokens ?? AI_DEFAULTS.maxOutputTokens,
    requestsPerMinute:
      env.requestsPerMinute ?? saved.requestsPerMinute ?? AI_DEFAULTS.requestsPerMinute,
  };
}
