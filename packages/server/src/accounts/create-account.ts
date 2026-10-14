import { hashPassword } from 'better-auth/crypto';
import type { Database } from '../db/client.ts';
import { and, eq } from 'drizzle-orm';
import { accounts, settings, users } from '../db/schema/index.ts';
import { usablePassword } from './account-setup.ts';
import { lockAdmins } from './bootstrap.ts';
import { AccountError } from './errors.ts';
import {
  claimInvitation,
  markInvitationAccepted,
  normalizeEmail,
  type Role,
} from './invitations.ts';

/**
 * The only way an account is created. Better Auth's own sign-up route is
 * disabled, because it can't consume an invitation in the same transaction.
 *
 * One transaction locks the invitation (or checks that public registration is
 * open), inserts the user and its password credential, and marks the
 * invitation accepted. Two concurrent attempts with one invitation produce
 * exactly one account. Only an email-bound link went to the address's owner,
 * so only it chooses a name and password here. Otherwise the account gets
 * neither until the mailbox owner finishes it from an emailed link.
 */
export async function createAccount(
  db: Database,
  input: {
    token?: string | undefined;
    email: string;
    name?: string | undefined;
    password?: string | undefined;
  },
) {
  const email = normalizeEmail(input.email);
  // Hash before opening the transaction so no lock is held during scrypt.
  const passwordHash = input.password === undefined ? null : await hashPassword(input.password);

  return db.transaction(async (tx) => {
    // Taken first, before any row lock, so lock order matches bootstrap and
    // admin changes. Account creation is rare enough to serialize.
    await lockAdmins(tx);
    let role: Role = 'user';
    let invitationId: string | undefined;
    let emailBound = false;
    if (input.token !== undefined) {
      const invitation = await claimInvitation(tx, input.token, email);
      if (invitation.bootstrap) {
        const [admin] = await tx
          .select({ id: users.id })
          .from(users)
          .where(and(eq(users.role, 'admin'), eq(users.emailVerified, true)))
          .limit(1);
        if (admin) throw new AccountError('admin-exists');
      }
      invitationId = invitation.id;
      emailBound = invitation.email !== null;
      // A bootstrap link makes an ordinary account; the operator's second run
      // of bootstrap-admin, after verification, grants the role.
      role = invitation.bootstrap ? 'user' : invitation.role;
    } else {
      const [row] = await tx
        .select({ open: settings.publicRegistration })
        .from(settings)
        .for('share');
      if (!row?.open) throw new AccountError('registration-closed');
    }
    const name = input.name?.trim();
    if (emailBound && (!name || passwordHash === null)) {
      throw new AccountError('details-required');
    }

    const [user] = await tx
      .insert(users)
      .values({ name: emailBound ? (name ?? '') : '', email, role })
      .onConflictDoNothing({ target: users.email })
      .returning({ id: users.id });
    if (!user) {
      const [existing] = await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, email))
        .for('update');
      if (!existing) throw new AccountError('email-taken');
      const finished = (await usablePassword(tx, existing.id)) !== null;
      if (!emailBound) {
        // Generic links and open registration answer alike for a taken
        // address, and a generic link is used up either way, so its public
        // status can't show whether the address had an account. The existing
        // account is untouched.
        if (invitationId) await markInvitationAccepted(tx, invitationId, null);
        return { kind: 'existing' as const, accountId: existing.id, email, finished };
      }
      // A private link mailed to this address takes over an account nobody
      // can sign in to yet, verified or not. Nothing the earlier visitor
      // chose survives, and the address is confirmed again from this mail.
      if (finished) throw new AccountError('email-taken');
      await tx
        .update(users)
        .set({ name, role, emailVerified: false })
        .where(eq(users.id, existing.id));
      await setCredential(tx, existing.id, passwordHash);
      if (invitationId) await markInvitationAccepted(tx, invitationId, existing.id);
      return { kind: 'created' as const, accountId: existing.id, email, role, emailBound };
    }

    await setCredential(tx, user.id, emailBound ? passwordHash : null);
    if (invitationId) await markInvitationAccepted(tx, invitationId, user.id);
    return { kind: 'created' as const, accountId: user.id, email, role, emailBound };
  });
}

/** Better Auth's credential account, which uses the user ID as its account ID. */
async function setCredential(tx: Database, userId: string, password: string | null) {
  const updated = await tx
    .update(accounts)
    .set({ password })
    .where(and(eq(accounts.userId, userId), eq(accounts.providerId, 'credential')))
    .returning({ id: accounts.id });
  if (updated.length > 0) return;
  await tx
    .insert(accounts)
    .values({ userId, accountId: userId, providerId: 'credential', password });
}
