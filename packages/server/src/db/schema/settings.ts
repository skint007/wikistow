import { sql } from 'drizzle-orm';
import { boolean, check, integer, pgTable, smallint, text } from 'drizzle-orm/pg-core';
import { timestamptz } from './helpers.ts';

export const SMTP_SECURITY = ['none', 'starttls', 'tls'] as const;

/**
 * Installation-wide settings, kept in a single row (`id = 1`) that the first
 * migration creates. `installationId` is bound into every signature and every
 * piece of ciphertext, so it must never change.
 */
export const settings = pgTable(
  'settings',
  {
    id: smallint().primaryKey().default(1),
    installationId: text().notNull(),
    publicRegistration: boolean().notNull().default(false),
    /**
     * When `scripts/restore.sh` last restored a backup, and when that backup
     * was taken, if its directory name says. The script writes them after
     * `pg_restore`, adding the columns if the backup is older than they are.
     */
    restoredAt: timestamptz(),
    backupTakenAt: timestamptz(),
    /**
     * Outgoing mail, as an administrator set it on the admin page. Null
     * until set. The server's environment wins over each (`SMTP_URL` over
     * the connection, `SMTP_FROM` over `smtpFrom`). The password is sealed
     * (`settingsSecrets` in settings.ts) and never sent back.
     */
    smtpHost: text(),
    smtpPort: integer(),
    smtpSecurity: text({ enum: SMTP_SECURITY }),
    smtpUsername: text(),
    smtpPassword: text(),
    smtpFrom: text(),
  },
  (table) => [
    check('settings_single_row', sql`${table.id} = 1`),
    check('settings_smtp_security', sql`${table.smtpSecurity} in ('none', 'starttls', 'tls')`),
  ],
);
