import { index, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { timestamptz } from './helpers.ts';
import { sessions } from './sessions.ts';
import { users } from './users.ts';

/**
 * A desktop sign-in a signed-in person approved in their browser, waiting for
 * the desktop app to redeem it (`accounts/desktop.ts`). The code itself is
 * kept only hashed. The challenge is the hash of a verifier only the app that
 * asked holds, so a code is no use to anyone who merely sees it. It goes with
 * the session that approved it: whatever ends that session (signing out, a
 * password reset, an administrator revoking sessions) ends the code too.
 */
export const desktopHandoffs = pgTable(
  'desktop_handoffs',
  {
    /** SHA-256 of the code, base64url. */
    codeHash: text().primaryKey(),
    /** SHA-256 of the app's verifier, base64url. */
    challenge: text().notNull(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    sessionId: uuid()
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    /** Both by the database's clock, as `users.sessionsEndedAt` is (`desktopApprovalStands`). */
    approvedAt: timestamptz().notNull().defaultNow(),
    expiresAt: timestamptz().notNull(),
  },
  (table) => [
    index('desktop_handoffs_expires_idx').on(table.expiresAt),
    index('desktop_handoffs_session_idx').on(table.sessionId),
  ],
);
