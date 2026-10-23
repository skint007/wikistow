import { and, count, eq, gt, isNotNull, isNull, max, ne, sql } from 'drizzle-orm';
import { lockAdmins } from '../accounts/first-account.ts';
import { AccountError } from '../accounts/errors.ts';
import type { Role } from '../accounts/invitations.ts';
import type { Database } from '../db/client.ts';
import { revokeAgentCredentials } from '../content/agents.ts';
import { invitations, sessions, users } from '../db/schema/index.ts';
import { endLapsedWhere } from '../public-links/links.ts';
import { audit } from './audit.ts';

/** What the dashboard shows per account. Never content, keys, or vault data. */
export async function listAccounts(db: Database) {
  const activity = db
    .select({
      userId: sessions.userId,
      sessionCount: count().as('session_count'),
      lastSeenAt: max(sessions.updatedAt).as('last_seen_at'),
    })
    .from(sessions)
    .where(gt(sessions.expiresAt, sql`now()`))
    .groupBy(sessions.userId)
    .as('activity');
  return db
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      role: users.role,
      emailVerified: users.emailVerified,
      twoFactorEnabled: users.twoFactorEnabled,
      suspendedAt: users.suspendedAt,
      createdAt: users.createdAt,
      sessionCount: sql<number>`coalesce(${activity.sessionCount}, 0)::int`,
      lastSeenAt: activity.lastSeenAt,
    })
    .from(users)
    .leftJoin(activity, eq(activity.userId, users.id))
    .orderBy(users.createdAt);
}

/**
 * Sign an account out everywhere, and end every agent credential it holds
 * (#7, protocol section 9.7). Every administrative revocation path
 * (suspension, a role change, revoking sessions and agents) goes through
 * here. Nothing undoes it: the person enrolls their agents again.
 */
export function revokeCredentials(db: Database, accountId: string): Promise<number> {
  // All or nothing, inside the caller's transaction when there is one. The
  // account's row is locked before its sessions go, so a session being saved
  // for it (a desktop sign-in) waits and is then refused
  // (`desktopApprovalStands`). Agents go first: their enrollments are locked
  // by approvals that wait on that row, which would deadlock the other way.
  return db.transaction(async (tx) => {
    await revokeAgentCredentials(tx, accountId);
    await tx.select({ id: users.id }).from(users).where(eq(users.id, accountId)).for('update');
    const removed = await tx
      .delete(sessions)
      .where(eq(sessions.userId, accountId))
      .returning({ id: sessions.id });
    return removed.length;
  });
}

type Change = { actor: string; target: string };

/**
 * Run an administrative action under the admin lock, after re-reading the
 * actor from the database. Every admin write goes through here, so a demoted
 * or suspended admin's in-flight request can't finish after the change that
 * removed their access, and two admins can't demote each other at once.
 */
export function asAdmin<T>(
  db: Database,
  actor: string,
  action: (tx: Database) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await lockAdmins(tx);
    const [acting] = await tx
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.id, actor), eq(users.role, 'admin'), isNull(users.suspendedAt)));
    if (!acting) throw new AccountError('not-admin');
    return action(tx);
  });
}

/** An admin action on another account, which is locked for the duration. */
async function adminChange<T>(
  db: Database,
  { actor, target }: Change,
  change: (tx: Database) => Promise<T>,
) {
  if (actor === target) throw new AccountError('cannot-target-self');
  return asAdmin(db, actor, async (tx) => {
    const [subject] = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, target))
      .for('update');
    if (!subject) throw new AccountError('account-not-found');
    return change(tx);
  });
}

/** Pending invitations an administrator issued stop working when they lose the role. */
async function revokeInvitationsIssuedBy(tx: Database, accountId: string): Promise<number> {
  const revoked = await tx
    .update(invitations)
    .set({ revokedAt: sql`now()` })
    .where(
      and(
        eq(invitations.createdBy, accountId),
        isNull(invitations.acceptedAt),
        isNull(invitations.revokedAt),
      ),
    )
    .returning({ id: invitations.id });
  return revoked.length;
}

/** Active admins other than `except`, for the last-admin guard. */
async function otherActiveAdmins(tx: Database, except: string): Promise<number> {
  const [row] = await tx
    .select({ n: count() })
    .from(users)
    .where(and(eq(users.role, 'admin'), isNull(users.suspendedAt), ne(users.id, except)));
  return row?.n ?? 0;
}

export function changeRole(db: Database, change: Change & { role: Role }) {
  return adminChange(db, change, async (tx) => {
    if (change.role !== 'admin' && (await otherActiveAdmins(tx, change.target)) === 0) {
      throw new AccountError('last-admin');
    }
    const changed = await tx
      .update(users)
      .set({ role: change.role })
      .where(and(eq(users.id, change.target), ne(users.role, change.role)))
      .returning({ id: users.id });
    // Already in that role: nothing changes and nothing is recorded.
    if (changed.length === 0) return;
    // A new role starts from a fresh sign-in, so sessions from before it
    // (perhaps on a machine the person no longer controls) don't carry it.
    const sessionsRevoked = await revokeCredentials(tx, change.target);
    const invitationsRevoked =
      change.role === 'admin' ? 0 : await revokeInvitationsIssuedBy(tx, change.target);
    await audit(tx, {
      actor: change.actor,
      action: 'account.role-changed',
      target: { kind: 'account', id: change.target },
      details: { role: change.role, sessionsRevoked, invitationsRevoked },
    });
  });
}

/**
 * Block sign-in and end every session; content keys are untouched. Already
 * suspended is a no-op, so the original time and record stay.
 */
export function suspendAccount(db: Database, change: Change) {
  return adminChange(db, change, async (tx) => {
    if ((await otherActiveAdmins(tx, change.target)) === 0) throw new AccountError('last-admin');
    const changed = await tx
      .update(users)
      .set({ suspendedAt: sql`now()` })
      .where(and(eq(users.id, change.target), isNull(users.suspendedAt)))
      .returning({ id: users.id });
    if (changed.length === 0) return;
    const sessionsRevoked = await revokeCredentials(tx, change.target);
    const invitationsRevoked = await revokeInvitationsIssuedBy(tx, change.target);
    // Under the account's row, which staging and committing take: every
    // public link it turned on ends, and every copy it uploaded goes
    // (ADR 0005, decision 8). No content locks, so none of the spaces
    // these are in waits on it.
    await endLapsedWhere(tx, { accountId: change.target }, change.actor);
    await audit(tx, {
      actor: change.actor,
      action: 'account.suspended',
      target: { kind: 'account', id: change.target },
      details: { sessionsRevoked, invitationsRevoked },
    });
  });
}

/**
 * Allow sign-in again. Sessions revoked by the suspension stay revoked: any
 * session that exists now was created around the suspension (a sign-in can
 * race it) and could never be used during it, so it is removed too.
 */
export function reactivateAccount(db: Database, change: Change) {
  return adminChange(db, change, async (tx) => {
    // An account that isn't suspended is left alone, sessions included.
    const changed = await tx
      .update(users)
      .set({ suspendedAt: null })
      .where(and(eq(users.id, change.target), isNotNull(users.suspendedAt)))
      .returning({ id: users.id });
    if (changed.length === 0) return;
    await revokeCredentials(tx, change.target);
    await audit(tx, {
      actor: change.actor,
      action: 'account.reactivated',
      target: { kind: 'account', id: change.target },
      details: {},
    });
  });
}

export function revokeAccountSessions(db: Database, change: Change) {
  return adminChange(db, change, async (tx) => {
    const sessionsRevoked = await revokeCredentials(tx, change.target);
    await audit(tx, {
      actor: change.actor,
      action: 'account.sessions-revoked',
      target: { kind: 'account', id: change.target },
      details: { sessionsRevoked },
    });
  });
}

/**
 * The address to send a new verification link to, recording who asked.
 * Null for an account that is already verified: nothing is sent or recorded.
 */
export function recordVerificationResend(db: Database, change: Change) {
  return adminChange(db, change, async (tx) => {
    const [user] = await tx
      .select({ email: users.email, emailVerified: users.emailVerified })
      .from(users)
      .where(eq(users.id, change.target));
    if (!user) throw new AccountError('account-not-found');
    if (user.emailVerified) return null;
    await audit(tx, {
      actor: change.actor,
      action: 'account.verification-resent',
      target: { kind: 'account', id: change.target },
      details: {},
    });
    return user.email;
  });
}
