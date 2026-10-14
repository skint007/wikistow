import { and, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import type { Database } from '../db/client.ts';
import { revokeCredentials } from '../admin/accounts.ts';
import { audit } from '../admin/audit.ts';
import { invitations, users } from '../db/schema/index.ts';
import { AccountError } from './errors.ts';
import { createInvitation, normalizeEmail } from './invitations.ts';

/**
 * Serializes every change to who is an administrator. Taken as a
 * transaction-scoped advisory lock, so it is released on commit or rollback.
 */
export const lockAdmins = (tx: Database) =>
  tx.execute(sql`select pg_advisory_xact_lock(hashtext('wikistow:admins'))`);

const isBootstrapInvitation = eq(invitations.kind, 'bootstrap');

const revokeOpenBootstrapLinks = (tx: Database) =>
  tx
    .update(invitations)
    .set({ revokedAt: sql`now()` })
    .where(
      and(isBootstrapInvitation, isNull(invitations.acceptedAt), isNull(invitations.revokedAt)),
    );

export type BootstrapResult =
  /** A one-time link to create the account. */
  | { kind: 'invited'; token: string }
  /** The account exists but hasn't verified its email yet. */
  | { kind: 'awaiting-verification' }
  /**
   * The verified account at this address is now the administrator. Accounts
   * from other bootstrap links were suspended.
   */
  | { kind: 'promoted'; accountId: string; suspended: number };

/**
 * The operator's command for the first administrator, run twice: once to get
 * a one-time link, which creates an ordinary account, and again after that
 * account has verified its email, which makes it the administrator.
 *
 * Only the operator's second run grants the role, and only to the exact
 * address typed. So a link that went to a mistyped address can't make whoever
 * owns that address an administrator, even if they verify it. Re-running
 * before verifying leaves the operator's account alone. Refused once a
 * verified administrator exists.
 */
export async function bootstrapAdmin(db: Database, email: string): Promise<BootstrapResult> {
  const address = normalizeEmail(email);
  return db.transaction(async (tx) => {
    await lockAdmins(tx);
    const [admin] = await tx
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.role, 'admin'), eq(users.emailVerified, true)))
      .limit(1);
    if (admin) throw new AccountError('admin-exists');

    const [account] = await tx.select().from(users).where(eq(users.email, address));
    if (account) {
      if (!account.emailVerified) return { kind: 'awaiting-verification' };
      await tx
        .update(users)
        .set({ role: 'admin', suspendedAt: null })
        .where(eq(users.id, account.id));
      // The operator's command has no account, so these events have no actor.
      await audit(tx, {
        actor: null,
        action: 'account.role-changed',
        target: { kind: 'account', id: account.id },
        // Like any role change, the operator signs in afresh as administrator.
        details: {
          role: 'admin',
          sessionsRevoked: await revokeCredentials(tx, account.id),
          invitationsRevoked: 0,
        },
      });
      // Nobody invited the accounts other bootstrap links made (a mistyped
      // address, say), so they are suspended and signed out, and links still
      // open are revoked. The new administrator can review the accounts and
      // reactivate any that are wanted.
      const others = await tx
        .select({ userId: invitations.acceptedUserId })
        .from(invitations)
        .where(and(isBootstrapInvitation, ne(invitations.acceptedUserId, account.id)));
      const suspended = others.flatMap((row) => (row.userId ? [row.userId] : []));
      await revokeOpenBootstrapLinks(tx);
      for (const id of suspended) {
        await tx
          .update(users)
          .set({ suspendedAt: sql`now()` })
          .where(eq(users.id, id));
        await audit(tx, {
          actor: null,
          action: 'account.suspended',
          target: { kind: 'account', id },
          details: { sessionsRevoked: await revokeCredentials(tx, id), invitationsRevoked: 0 },
        });
      }
      return { kind: 'promoted', accountId: account.id, suspended: suspended.length };
    }

    // Starting over at a new address: unverified accounts from earlier
    // bootstrap links (a mistyped address, say) are removed, and any links
    // still open are revoked. Unverified accounts never held any content.
    const earlier = await tx
      .select({ userId: invitations.acceptedUserId })
      .from(invitations)
      .innerJoin(users, eq(users.id, invitations.acceptedUserId))
      .where(and(isBootstrapInvitation, eq(users.emailVerified, false), ne(users.email, address)));
    const unverified = earlier.flatMap((row) => (row.userId ? [row.userId] : []));
    if (unverified.length > 0) {
      await tx
        .delete(users)
        .where(and(inArray(users.id, unverified), eq(users.emailVerified, false)));
    }
    await revokeOpenBootstrapLinks(tx);
    const { token } = await createInvitation(tx, {
      email: address,
      role: 'admin',
      createdBy: null,
      kind: 'bootstrap',
    });
    return { kind: 'invited', token };
  });
}
