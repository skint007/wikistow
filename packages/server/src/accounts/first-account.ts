import { hashPassword } from 'better-auth/crypto';
import { sql } from 'drizzle-orm';
import type { Database } from '../db/client.ts';
import { audit } from '../admin/audit.ts';
import { accounts, users } from '../db/schema/index.ts';
import { AccountError } from './errors.ts';
import { normalizeEmail } from './invitations.ts';

/**
 * Serializes every change to who is an administrator. Taken as a
 * transaction-scoped advisory lock, so it is released on commit or rollback.
 */
export const lockAdmins = (tx: Database) =>
  tx.execute(sql`select pg_advisory_xact_lock(hashtext('wikistow:admins'))`);

/** True until the installation has its first account, which `createFirstAccount` makes. */
export async function setupOpen(db: Database): Promise<boolean> {
  const [account] = await db.select({ id: users.id }).from(users).limit(1);
  return !account;
}

/**
 * A new installation's first account, which becomes its administrator.
 * Refused once any account exists, so this never makes a second one. The
 * operator is the one setting up the server, so the address counts as
 * verified and the account signs in at once, before mail is set up.
 */
export async function createFirstAccount(
  db: Database,
  input: { name: string; email: string; password: string },
) {
  // Hash before opening the transaction so no lock is held during scrypt.
  const password = await hashPassword(input.password);
  return db.transaction(async (tx) => {
    // Account creation takes the same lock, so two requests make one account.
    await lockAdmins(tx);
    if (!(await setupOpen(tx))) throw new AccountError('admin-exists');
    const [user] = await tx
      .insert(users)
      .values({
        name: input.name.trim(),
        email: normalizeEmail(input.email),
        role: 'admin',
        emailVerified: true,
      })
      .returning({ id: users.id });
    if (!user) throw new Error('first account was not inserted');
    // Better Auth's credential account, which uses the user ID as its account ID.
    await tx
      .insert(accounts)
      .values({ userId: user.id, accountId: user.id, providerId: 'credential', password });
    // Nobody is signed in yet, so the event has no actor.
    await audit(tx, {
      actor: null,
      action: 'account.first-admin',
      target: { kind: 'account', id: user.id },
      details: {},
    });
    return { accountId: user.id };
  });
}
