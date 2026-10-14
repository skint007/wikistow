import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { and, desc, eq, lt, sql } from 'drizzle-orm';
import type { Database } from '../db/client.ts';
import { desktopHandoffs, sessions, users } from '../db/schema/index.ts';

/**
 * How long an approved desktop sign-in waits for its app. The browser hands
 * the code straight to the app, so this only needs to cover a slow click.
 */
const HANDOFF = sql`interval '2 minutes'`;

const sha256 = (text: string) => createHash('sha256').update(text).digest('base64url');

/**
 * A signed-in person approved a desktop sign-in in their browser session
 * `by`. Answers the one-time code the browser passes to the app in its
 * `wikistow://` link. `challenge` is the SHA-256 of the verifier the app made
 * when it asked.
 */
export async function approveDesktopHandoff(
  db: Database,
  by: { userId: string; sessionId: string },
  challenge: string,
): Promise<string> {
  await db.delete(desktopHandoffs).where(lt(desktopHandoffs.expiresAt, sql`now()`));
  const code = randomBytes(32).toString('base64url');
  await db.insert(desktopHandoffs).values({
    codeHash: sha256(code),
    challenge,
    userId: by.userId,
    sessionId: by.sessionId,
    expiresAt: sql`now() + ${HANDOFF}`,
  });
  return code;
}

/** A redeemed desktop sign-in: who approved it, from which session, and when. */
export type Approval = { userId: string; sessionId: string; approvedAt: Date };

/**
 * Who approved the sign-in a desktop app redeems, given the code from its
 * link and the verifier only that app holds, or null. A code works once: it
 * is used up even when the verifier is wrong, so nobody gets a second guess.
 */
export async function redeemDesktopHandoff(
  db: Database,
  code: string,
  verifier: string,
): Promise<Approval | null> {
  const [handoff] = await db
    .delete(desktopHandoffs)
    .where(eq(desktopHandoffs.codeHash, sha256(code)))
    .returning({
      challenge: desktopHandoffs.challenge,
      userId: desktopHandoffs.userId,
      sessionId: desktopHandoffs.sessionId,
      approvedAt: desktopHandoffs.approvedAt,
      live: sql<boolean>`${desktopHandoffs.expiresAt} > now()`,
    });
  if (!handoff?.live) return null;
  const expected = Buffer.from(handoff.challenge);
  const given = Buffer.from(sha256(verifier));
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  return {
    userId: handoff.userId,
    sessionId: handoff.sessionId,
    approvedAt: handoff.approvedAt,
  };
}

/**
 * Whether an approval still stands once the desktop session it gave is made:
 * the approving session is still there, and none of the account's sessions
 * ended since. Checked after the new session is saved, so whichever comes
 * second, the check or a revocation, sees the other:
 *
 * - Better Auth marks the account (`sessionsEndedAt`) before each delete, so
 *   a check after the mark refuses, and a delete after the check finds the
 *   new session and ends it too.
 * - The row lock waits for a delete of the approving session already under
 *   way, such as an administrator's, which doesn't go through Better Auth.
 */
export async function desktopApprovalStands(db: Database, approval: Approval): Promise<boolean> {
  const [approving] = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(eq(sessions.id, approval.sessionId))
    .for('key share');
  if (!approving) return false;
  const [account] = await db
    .select({ endedAt: users.sessionsEndedAt })
    .from(users)
    .where(eq(users.id, approval.userId));
  return !account?.endedAt || account.endedAt < approval.approvedAt;
}

/** Record that one of the account's sessions is about to end (`desktopApprovalStands`). */
export async function markSessionEnding(db: Database, userId: string): Promise<void> {
  await db
    .update(users)
    .set({ sessionsEndedAt: sql`now()` })
    .where(eq(users.id, userId));
}

/** The account's desktop sessions that haven't expired, newest first. */
export function listDesktopSessions(db: Database, userId: string) {
  return db
    .select({ id: sessions.id, createdAt: sessions.createdAt, expiresAt: sessions.expiresAt })
    .from(sessions)
    .where(and(eq(sessions.userId, userId), eq(sessions.kind, 'desktop')))
    .orderBy(desc(sessions.createdAt))
    .then((rows) => rows.filter((row) => row.expiresAt.getTime() > Date.now()));
}

/** Sign one of the account's desktop apps out. False if there was no such session. */
export async function revokeDesktopSession(
  db: Database,
  userId: string,
  sessionId: string,
): Promise<boolean> {
  const deleted = await db
    .delete(sessions)
    .where(
      and(eq(sessions.id, sessionId), eq(sessions.userId, userId), eq(sessions.kind, 'desktop')),
    )
    .returning({ id: sessions.id });
  return deleted.length > 0;
}
