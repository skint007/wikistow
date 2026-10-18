import { eq } from 'drizzle-orm';
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import type { Database } from './db/client.ts';
import { settings } from './db/schema/index.ts';

export async function readSettings(db: Database) {
  const [row] = await db.select().from(settings).where(eq(settings.id, 1));
  if (!row) throw new Error('settings row missing; were migrations applied?');
  return row;
}

type Row = typeof settings.$inferSelect;

/** Columns holding a secret an administrator saved, sealed by `settingsSecrets`. */
export type SecretColumn = 'smtpPassword';

const SEALED = 'v1.';
const IV_BYTES = 12;
const TAG_BYTES = 16;

/**
 * Seals and opens the secrets kept in settings (an SMTP password, an API
 * key), so a database dump or backup alone doesn't reveal them. The key
 * comes from `BETTER_AUTH_SECRET` (HKDF with its own label) and the
 * installation, and each value is bound to its column. A value this server
 * can't open, as after a restore under another secret, reads as unset.
 */
export function settingsSecrets(authSecret: string, row: Pick<Row, 'installationId'>) {
  const key = Buffer.from(
    hkdfSync('sha256', authSecret, row.installationId, 'wikistow settings secret', 32),
  );
  return {
    seal(column: SecretColumn, value: string): string {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv('aes-256-gcm', key, iv).setAAD(Buffer.from(column));
      const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      return SEALED + Buffer.concat([iv, body, cipher.getAuthTag()]).toString('base64url');
    },
    open(column: SecretColumn, sealed: string | null): string | null {
      if (sealed === null || !sealed.startsWith(SEALED)) return null;
      const bytes = Buffer.from(sealed.slice(SEALED.length), 'base64url');
      if (bytes.length < IV_BYTES + TAG_BYTES) return null;
      try {
        const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, IV_BYTES))
          .setAAD(Buffer.from(column))
          .setAuthTag(bytes.subarray(-TAG_BYTES));
        const body = bytes.subarray(IV_BYTES, -TAG_BYTES);
        return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
      } catch {
        return null;
      }
    },
  };
}

/** Outgoing mail as an administrator saved it, password opened. Null fields are unset. */
export function mailSettingsOf(row: Row, authSecret: string) {
  return {
    host: row.smtpHost,
    port: row.smtpPort,
    security: row.smtpSecurity,
    username: row.smtpUsername,
    password: settingsSecrets(authSecret, row).open('smtpPassword', row.smtpPassword),
    from: row.smtpFrom,
  };
}

export type MailSettings = ReturnType<typeof mailSettingsOf>;

export async function readMailSettings(db: Database, authSecret: string): Promise<MailSettings> {
  return mailSettingsOf(await readSettings(db), authSecret);
}

/** Changes to settings: a field left out (or undefined) keeps its value. */
export type SettingsChanges<T> = { [K in keyof T]?: T[K] | undefined };

/** The fields of `changes` whose value differs from `current`. */
export function changedFields<T extends object>(current: T, changes: SettingsChanges<T>) {
  const changed: Extract<keyof T, string>[] = [];
  for (const field in changes) {
    if (changes[field] !== undefined && changes[field] !== current[field]) changed.push(field);
  }
  return changed;
}

/** `current` with `changes` applied. */
export function withChanges<T extends object>(current: T, changes: SettingsChanges<T>): T {
  const result = { ...current };
  for (const field in changes) {
    const value = changes[field];
    if (value !== undefined) result[field] = value;
  }
  return result;
}
