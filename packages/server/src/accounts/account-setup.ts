import { hashPassword } from 'better-auth/crypto';
import { and, eq, gt, like, lte, sql } from 'drizzle-orm';
import { createHash, randomBytes } from 'node:crypto';
import type { Database } from '../db/client.ts';
import { accounts, users, verifications } from '../db/schema/index.ts';
import { AccountError } from './errors.ts';
import { normalizeName, withUniqueName } from './profile.ts';

/** As long as a confirmation link lasts. */
export const SETUP_LINK_TTL_HOURS = 24;

const identifier = (token: string) =>
  `account-setup:${createHash('sha256').update(token).digest('hex')}`;

/** The credential password, or null when the account can't sign in with one yet. */
export async function usablePassword(db: Database, accountId: string): Promise<string | null> {
  const [credential] = await db
    .select({ password: accounts.password })
    .from(accounts)
    .where(and(eq(accounts.userId, accountId), eq(accounts.providerId, 'credential')));
  return credential?.password ?? null;
}

/**
 * A link token for the mailbox owner to finish an account nobody can sign in
 * to yet. Only its hash is stored, apart from Better Auth's reset tokens, so
 * neither kind of link can be used as the other.
 */
export async function createSetupToken(db: Database, accountId: string): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  await db
    .delete(verifications)
    .where(
      and(
        like(verifications.identifier, 'account-setup:%'),
        lte(verifications.expiresAt, sql`now()`),
      ),
    );
  await db.insert(verifications).values({
    identifier: identifier(token),
    value: accountId,
    expiresAt: sql`now() + make_interval(hours => ${SETUP_LINK_TTL_HOURS})`,
  });
  return token;
}

/**
 * Finish an account from its emailed link: the owner's name and first
 * password, and the address confirmed, all at once. The link works once,
 * and not at all once the account has a password some other way. A name
 * another account uses is refused with `name-taken`, and the link still works.
 */
export async function finishAccountSetup(
  db: Database,
  input: { token: string; name: string; password: string },
): Promise<{ accountId: string }> {
  // Hashed before the transaction so no lock is held during scrypt.
  const passwordHash = await hashPassword(input.password);
  const transaction = db.transaction(async (tx) => {
    const [link] = await tx
      .delete(verifications)
      .where(
        and(
          eq(verifications.identifier, identifier(input.token)),
          gt(verifications.expiresAt, sql`now()`),
        ),
      )
      .returning({ accountId: verifications.value });
    if (!link) throw new AccountError('setup-link-invalid');
    const [user] = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, link.accountId))
      .for('update');
    if (!user || (await usablePassword(tx, user.id)) !== null) {
      throw new AccountError('setup-link-invalid');
    }
    const credential = and(eq(accounts.userId, user.id), eq(accounts.providerId, 'credential'));
    const updated = await tx
      .update(accounts)
      .set({ password: passwordHash })
      .where(credential)
      .returning({ id: accounts.id });
    if (updated.length === 0) {
      await tx.insert(accounts).values({
        userId: user.id,
        accountId: user.id,
        providerId: 'credential',
        password: passwordHash,
      });
    }
    await tx
      .update(users)
      .set({ name: normalizeName(input.name), emailVerified: true })
      .where(eq(users.id, user.id));
    return { accountId: user.id };
  });
  return withUniqueName(transaction);
}
