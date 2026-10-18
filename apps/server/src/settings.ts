import type { MailSettings } from '@wikistow/server';
import type { Config } from './config.ts';
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
