import { sql } from 'drizzle-orm';
import { boolean, check, pgTable, text } from 'drizzle-orm/pg-core';
import { primaryId, timestamps, timestamptz } from './helpers.ts';

export const ROLES = ['user', 'admin'] as const;
export const THEMES = ['system', 'light', 'slate', 'warm', 'oled'] as const;

/**
 * Accounts. Better Auth reads and writes the core columns; `role`,
 * `suspendedAt`, and `theme` are app fields Better Auth exposes as read-only.
 * Emails are stored lowercased.
 */
export const users = pgTable(
  'users',
  {
    id: primaryId(),
    name: text().notNull(),
    email: text().notNull().unique(),
    emailVerified: boolean().notNull().default(false),
    image: text(),
    /** Set by Better Auth's two-factor plugin once a TOTP authenticator is verified. */
    twoFactorEnabled: boolean().notNull().default(false),
    role: text({ enum: ROLES }).notNull().default('user'),
    /** Set while an administrator has suspended the account. */
    suspendedAt: timestamptz(),
    theme: text({ enum: THEMES }).notNull().default('system'),
    /**
     * Agent credentials made before this are dead (protocol section 9.7):
     * set by a password reset, an administrator revoking sessions and
     * agents, a suspension or a role change. Never cleared.
     */
    credentialsRevokedAt: timestamptz(),
    /**
     * When one of the account's sessions last ended, set just before Better
     * Auth deletes it (`auth.ts`). A desktop sign-in redeemed across such a
     * moment is refused (`desktopApprovalStands`).
     */
    sessionsEndedAt: timestamptz(),
    ...timestamps,
  },
  (table) => [
    check('users_role', sql`${table.role} in ('user', 'admin')`),
    check('users_theme', sql`${table.theme} in ('system', 'light', 'slate', 'warm', 'oled')`),
    check('users_email_lowercase', sql`${table.email} = lower(${table.email})`),
  ],
);
