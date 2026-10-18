import { and, eq, isNull, sql } from 'drizzle-orm';
import { createHash, randomBytes } from 'node:crypto';
import type { Database } from '../db/client.ts';
import { invitations, ROLES, users } from '../db/schema/index.ts';
import { AccountError } from './errors.ts';

export const INVITATION_TTL_DAYS = 7;

export type Role = (typeof ROLES)[number];

export const normalizeEmail = (email: string): string => email.trim().toLowerCase();

/** Tokens are 256 random bits. Only the SHA-256 hash is ever stored. */
export const hashInvitationToken = (token: string): string =>
  createHash('sha256').update(token).digest('hex');

function newToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, tokenHash: hashInvitationToken(token) };
}

/**
 * Create an invitation and return its token, which is shown or sent once and
 * never stored. With an email, only that address can accept it.
 */
export async function createInvitation(
  db: Database,
  {
    email,
    role,
    createdBy,
  }: {
    email: string | null;
    role: Role;
    createdBy: string | null;
  },
) {
  const { token, tokenHash } = newToken();
  const [invitation] = await db
    .insert(invitations)
    .values({
      tokenHash,
      email: email === null ? null : normalizeEmail(email),
      role,
      createdBy,
      expiresAt: sql`now() + make_interval(days => ${INVITATION_TTL_DAYS})`,
    })
    .onConflictDoNothing()
    .returning();
  // The only conflict left is the partial unique index: an open invitation already exists.
  if (!invitation) throw new AccountError('invitation-exists');
  return { invitation, token };
}

/**
 * Authorization is re-checked whenever a link is shown or redeemed: an account
 * invitation stops working once whoever issued it is no longer an active
 * administrator, including once they are deleted.
 */
async function issuerGone(
  db: Database,
  { createdBy }: { createdBy: string | null },
): Promise<boolean> {
  if (!createdBy) return true;
  const [issuer] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, createdBy), eq(users.role, 'admin'), isNull(users.suspendedAt)));
  return !issuer;
}

export type InvitationStatus =
  | { status: 'valid'; email: string | null; expiresAt: Date }
  | { status: 'expired' | 'used' | 'revoked' | 'not-found' };

/** What the invite page shows before someone fills in the form. */
export async function inspectInvitation(db: Database, token: string): Promise<InvitationStatus> {
  const [row] = await db
    .select({
      email: invitations.email,
      createdBy: invitations.createdBy,
      expiresAt: invitations.expiresAt,
      acceptedAt: invitations.acceptedAt,
      revokedAt: invitations.revokedAt,
      expired: sql<boolean>`${invitations.expiresAt} <= now()`,
    })
    .from(invitations)
    .where(eq(invitations.tokenHash, hashInvitationToken(token)));
  if (!row) return { status: 'not-found' };
  if (row.acceptedAt) return { status: 'used' };
  if (row.revokedAt) return { status: 'revoked' };
  if (row.expired) return { status: 'expired' };
  if (await issuerGone(db, row)) return { status: 'revoked' };
  return { status: 'valid', email: row.email, expiresAt: row.expiresAt };
}

/** Lock an invitation for redemption inside `tx`, or throw why it can't be used. */
export async function claimInvitation(tx: Database, token: string, email: string) {
  const [row] = await tx
    .select({
      id: invitations.id,
      email: invitations.email,
      role: invitations.role,
      createdBy: invitations.createdBy,
      acceptedAt: invitations.acceptedAt,
      revokedAt: invitations.revokedAt,
      expired: sql<boolean>`${invitations.expiresAt} <= now()`,
    })
    .from(invitations)
    .where(eq(invitations.tokenHash, hashInvitationToken(token)))
    .for('update');
  if (!row) throw new AccountError('invitation-not-found');
  if (row.acceptedAt) throw new AccountError('invitation-used');
  if (row.revokedAt) throw new AccountError('invitation-revoked');
  if (row.expired) throw new AccountError('invitation-expired');
  if (row.email !== null && row.email !== email)
    throw new AccountError('invitation-email-mismatch');
  if (await issuerGone(tx, row)) throw new AccountError('invitation-revoked');
  return { id: row.id, email: row.email, role: row.role };
}

/** `userId` is null when a generic link was spent on an address that already had an account. */
export async function markInvitationAccepted(tx: Database, id: string, userId: string | null) {
  await tx
    .update(invitations)
    .set({ acceptedAt: sql`now()`, acceptedUserId: userId })
    .where(and(eq(invitations.id, id), isNull(invitations.acceptedAt)));
}
