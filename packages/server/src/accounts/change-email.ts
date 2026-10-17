import { and, eq, gt, like, lte, ne, or, sql } from 'drizzle-orm';
import { createHash, randomBytes } from 'node:crypto';
import type { Database } from '../db/client.ts';
import { users, verifications } from '../db/schema/index.ts';
import { AccountError } from './errors.ts';
import { normalizeEmail } from './invitations.ts';

/** As long as a link to confirm a new address lasts. */
export const EMAIL_CHANGE_LINK_TTL_HOURS = 24;

const identifier = (token: string) =>
  `email-change:${createHash('sha256').update(token).digest('hex')}`;

/**
 * A link token that moves the account to `email` once its owner opens it.
 * Only the hash is stored, with the account ID and new address as
 * `<accountId> <email>`. The account's earlier links stop working, so a
 * mistyped address can't be confirmed after the right one was asked for.
 */
export async function createEmailChangeToken(
  db: Database,
  accountId: string,
  email: string,
): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  await db
    .delete(verifications)
    .where(
      and(
        like(verifications.identifier, 'email-change:%'),
        or(like(verifications.value, `${accountId} %`), lte(verifications.expiresAt, sql`now()`)),
      ),
    );
  await db.insert(verifications).values({
    identifier: identifier(token),
    value: `${accountId} ${normalizeEmail(email)}`,
    expiresAt: sql`now() + make_interval(hours => ${EMAIL_CHANGE_LINK_TTL_HOURS})`,
  });
  return token;
}

/**
 * Move an account to the address its link was mailed to. The link works
 * once. An address another account took meanwhile changes nothing, and the
 * link stays until it expires.
 */
export async function confirmEmailChange(
  db: Database,
  token: string,
): Promise<{ accountId: string; from: string; to: string }> {
  return db.transaction(async (tx) => {
    const [link] = await tx
      .delete(verifications)
      .where(
        and(
          eq(verifications.identifier, identifier(token)),
          gt(verifications.expiresAt, sql`now()`),
        ),
      )
      .returning({ value: verifications.value });
    const [accountId = '', to = ''] = link?.value.split(' ') ?? [];
    const [user] = link
      ? await tx
          .select({ email: users.email })
          .from(users)
          .where(eq(users.id, accountId))
          .for('update')
      : [];
    if (!user) throw new AccountError('email-link-invalid');
    const [taken] = await tx
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.email, to), ne(users.id, accountId)));
    if (taken) throw new AccountError('email-taken');
    // The link reached this mailbox, which proves it is the account's.
    await tx.update(users).set({ email: to, emailVerified: true }).where(eq(users.id, accountId));
    return { accountId, from: user.email, to };
  });
}
