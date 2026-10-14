import { adminRoutes } from '@wikistow/contracts';
import {
  changeRole,
  inviteAccount,
  listAccounts,
  listPendingInvitations,
  reactivateAccount,
  readSettings,
  recordVerificationResend,
  resendInvitation,
  revokeAccountSessions,
  revokeInvitation,
  setPublicRegistration,
  suspendAccount,
  type Database,
} from '@wikistow/server';
import type { Auth } from '../auth/auth.ts';
import type { Config } from '../config.ts';
import type { Log } from '../http/logger.ts';
import type { Routes } from '../http/mount.ts';
import { sendInBackground, type Deliver } from '../mail/mailer.ts';
import { invitationMail } from '../mail/templates.ts';
import { toApiError } from './accounts.ts';

type Deps = { db: Database; auth: Auth; config: Config; deliver: Deliver; log: Log };

const iso = (date: Date | null) => (date === null ? null : date.toISOString());

type InvitationRow = Awaited<ReturnType<typeof listPendingInvitations>>[number];
const toPending = (row: InvitationRow) => ({
  id: row.id,
  email: row.email,
  role: row.role,
  createdAt: row.createdAt.toISOString(),
  expiresAt: row.expiresAt.toISOString(),
  lastSentAt: iso(row.lastSentAt),
});

const done = { ok: true as const };

// Each of these sends mail; an administrator has no reason to send more than this.
const MAIL_LIMIT = { windowSeconds: 60, max: 10 };

export function mountAdminRoutes(routes: Routes, { db, auth, config, deliver, log }: Deps): void {
  const inviteLink = (token: string) => `${config.publicOrigin}/invite#token=${token}`;

  /** Email-bound invitations are mailed; generic ones return the link once. */
  const deliverInvitation = (invitation: InvitationRow, token: string, inviter: string) => {
    if (invitation.email === null) return inviteLink(token);
    sendInBackground(deliver, log, invitationMail(invitation.email, inviteLink(token), inviter));
    return null;
  };

  routes.admin(adminRoutes.listAccounts, async () => ({
    accounts: (await listAccounts(db)).map((row) => ({
      id: row.id,
      email: row.email,
      name: row.name,
      role: row.role,
      emailVerified: row.emailVerified,
      twoFactorEnabled: row.twoFactorEnabled,
      suspended: row.suspendedAt !== null,
      createdAt: row.createdAt.toISOString(),
      sessionCount: row.sessionCount,
      lastSeenAt: iso(row.lastSeenAt),
    })),
  }));

  routes.admin(adminRoutes.setRole, async ({ params, body }, { principal }) => {
    await changeRole(db, { actor: principal.accountId, target: params.id, role: body.role }).catch(
      toApiError,
    );
    return done;
  });

  routes.admin(adminRoutes.suspend, async ({ params }, { principal }) => {
    await suspendAccount(db, { actor: principal.accountId, target: params.id }).catch(toApiError);
    return done;
  });

  routes.admin(adminRoutes.reactivate, async ({ params }, { principal }) => {
    await reactivateAccount(db, { actor: principal.accountId, target: params.id }).catch(
      toApiError,
    );
    return done;
  });

  routes.admin(adminRoutes.revokeSessions, async ({ params }, { principal }) => {
    await revokeAccountSessions(db, { actor: principal.accountId, target: params.id }).catch(
      toApiError,
    );
    return done;
  });

  routes.admin(
    adminRoutes.resendVerification,
    async ({ params }, { principal }) => {
      const email = await recordVerificationResend(db, {
        actor: principal.accountId,
        target: params.id,
      }).catch(toApiError);
      if (email !== null) {
        await auth.api.sendVerificationEmail({
          body: { email, callbackURL: '/sign-in?verified=1' },
        });
      }
      return done;
    },
    { rateLimit: MAIL_LIMIT },
  );

  routes.admin(adminRoutes.listInvitations, async () => ({
    invitations: (await listPendingInvitations(db)).map(toPending),
  }));

  routes.admin(
    adminRoutes.createInvitation,
    async ({ body }, { principal }) => {
      const { invitation, token } = await inviteAccount(db, {
        actor: principal.accountId,
        email: body.email,
        role: body.role,
      }).catch(toApiError);
      return {
        invitation: toPending(invitation),
        link: deliverInvitation(invitation, token, principal.name),
      };
    },
    { rateLimit: MAIL_LIMIT },
  );

  routes.admin(
    adminRoutes.resendInvitation,
    async ({ params }, { principal }) => {
      const { invitation, token } = await resendInvitation(db, {
        actor: principal.accountId,
        id: params.id,
      }).catch(toApiError);
      return {
        invitation: toPending(invitation),
        link: deliverInvitation(invitation, token, principal.name),
      };
    },
    { rateLimit: MAIL_LIMIT },
  );

  routes.admin(adminRoutes.revokeInvitation, async ({ params }, { principal }) => {
    await revokeInvitation(db, { actor: principal.accountId, id: params.id }).catch(toApiError);
    return done;
  });

  routes.admin(adminRoutes.getSettings, async () => {
    const { publicRegistration } = await readSettings(db);
    return { publicRegistration };
  });

  routes.admin(adminRoutes.updateSettings, async ({ body }, { principal }) => {
    await setPublicRegistration(db, {
      actor: principal.accountId,
      open: body.publicRegistration,
    }).catch(toApiError);
    return { publicRegistration: body.publicRegistration };
  });
}
