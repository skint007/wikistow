import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { primaryId, timestamps, timestamptz } from './helpers.ts';
import { users } from './users.ts';

/** Better Auth sessions. Deleting a row signs that browser out on its next request. */
export const sessions = pgTable(
  'sessions',
  {
    id: primaryId(),
    token: text().notNull().unique(),
    expiresAt: timestamptz().notNull(),
    ipAddress: text(),
    userAgent: text(),
    /**
     * When the person last proved who they are: a password sign-in, or a TOTP
     * or backup code when two-factor is on, or the same proof given again in
     * this session (`POST /api/me/reauth`). Sessions minted any other way (a
     * password change, turning two-factor off) leave it null, so they never
     * count as a recent sign-in.
     */
    authenticatedAt: timestamptz(),
    /**
     * `desktop` for a session the desktop app redeemed from a browser handoff
     * (`accounts/desktop.ts`), listed and revoked on its own in Settings.
     * Every other session is `browser`.
     */
    kind: text().notNull().default('browser'),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    ...timestamps,
  },
  (table) => [
    index('sessions_user_id_idx').on(table.userId),
    check('sessions_kind', sql`${table.kind} in ('browser', 'desktop')`),
  ],
);
