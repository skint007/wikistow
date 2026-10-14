import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { createHash, randomBytes } from 'node:crypto';
import { AccountError } from '../accounts/errors.ts';
import { asAdmin } from './accounts.ts';
import { createInvitation, INVITATION_TTL_DAYS, type Role } from '../accounts/invitations.ts';
import type { Database } from '../db/client.ts';
import { invitations, settings } from '../db/schema/index.ts';
import { audit } from './audit.ts';

const pending = and(isNull(invitations.acceptedAt), isNull(invitations.revokedAt));

/** Open invitations, newest first. Tokens can't be listed; only their hashes exist. */
export function listPendingInvitations(db: Database) {
  return db
    .select({
      id: invitations.id,
      email: invitations.email,
      role: invitations.role,
      createdAt: invitations.createdAt,
      expiresAt: invitations.expiresAt,
      lastSentAt: invitations.lastSentAt,
    })
    .from(invitations)
    .where(pending)
    .orderBy(desc(invitations.createdAt));
}

export function inviteAccount(
  db: Database,
  { actor, email, role }: { actor: string; email: string | null; role: Role },
) {
  return asAdmin(db, actor, async (tx) => {
    const created = await createInvitation(tx, { email, role, createdBy: actor });
    await audit(tx, {
      actor,
      action: 'invitation.created',
      target: { kind: 'invitation', id: created.invitation.id },
      details: { role, emailBound: email !== null },
    });
    return created;
  });
}

/**
 * Issue a fresh token and expiry for a pending invitation. The old link stops
 * working, so a resend also replaces a link that may have leaked.
 */
export function resendInvitation(db: Database, { actor, id }: { actor: string; id: string }) {
  return asAdmin(db, actor, async (tx) => {
    const token = randomBytes(32).toString('base64url');
    const [invitation] = await tx
      .update(invitations)
      .set({
        tokenHash: createHash('sha256').update(token).digest('hex'),
        expiresAt: sql`now() + make_interval(days => ${INVITATION_TTL_DAYS})`,
        lastSentAt: sql`now()`,
      })
      .where(and(eq(invitations.id, id), pending))
      .returning();
    if (!invitation) throw new AccountError('invitation-not-found');
    await audit(tx, {
      actor,
      action: 'invitation.resent',
      target: { kind: 'invitation', id },
      details: {},
    });
    return { invitation, token };
  });
}

export function revokeInvitation(db: Database, { actor, id }: { actor: string; id: string }) {
  return asAdmin(db, actor, async (tx) => {
    const [revoked] = await tx
      .update(invitations)
      .set({ revokedAt: sql`now()` })
      .where(and(eq(invitations.id, id), pending))
      .returning({ id: invitations.id });
    if (!revoked) throw new AccountError('invitation-not-found');
    await audit(tx, {
      actor,
      action: 'invitation.revoked',
      target: { kind: 'invitation', id },
      details: {},
    });
  });
}

export function setPublicRegistration(
  db: Database,
  { actor, open }: { actor: string; open: boolean },
) {
  return asAdmin(db, actor, async (tx) => {
    await tx.update(settings).set({ publicRegistration: open });
    await audit(tx, {
      actor,
      action: 'settings.updated',
      target: { kind: 'settings', id: '1' },
      details: { publicRegistration: open },
    });
  });
}
