import { adminRoutes } from '@wikistow/contracts';
import {
  changeRole,
  inviteAccount,
  listAccounts,
  listPendingInvitations,
  newInvitationLink,
  reactivateAccount,
  readMailSettings,
  readSettings,
  recordVerificationResend,
  resendInvitation,
  revokeAccountSessions,
  revokeInvitation,
  saveMailSettings,
  setPublicRegistration,
  suspendAccount,
  withChanges,
  type Database,
  type MailSettings,
} from '@wikistow/server';
import type { z } from 'zod';
import type { Auth } from '../auth/auth.ts';
import type { Config } from '../config.ts';
import type { Log } from '../http/logger.ts';
import type { Routes } from '../http/mount.ts';
import { ApiError } from '../http/errors.ts';
import { sendInBackground, type Mailer, type Transport } from '../mail/mailer.ts';
import { invitationMail, testMail } from '../mail/templates.ts';
import { mailFromEnvironment, mailSetup } from '../settings.ts';
import { toApiError } from './accounts.ts';

type Deps = {
  db: Database;
  auth: Auth;
  config: Config;
  mailer: Mailer;
  transport: Transport;
  log: Log;
};

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

/** Why a test message didn't go, from nodemailer's error codes, never the server's own words. */
function mailFailure(error: unknown, setup: NonNullable<ReturnType<typeof mailSetup>>) {
  const code = error instanceof Error && 'code' in error ? error.code : undefined;
  // OpenSSL's, as when TLS meets a server that starts in plain text.
  const tls = error instanceof Error && 'library' in error && error.library === 'SSL routines';
  const where =
    'url' in setup.connection
      ? 'the mail server'
      : `${setup.connection.host}:${setup.connection.port}`;
  switch (tls ? 'ETLS' : code) {
    case 'EAUTH':
      return 'The mail server refused the username or password.';
    case 'ENOAUTH':
      return 'The mail server needs a username and password.';
    case 'ETLS':
      return `Couldn’t start a secure connection with ${where}. Check the security setting.`;
    case 'ETIMEDOUT':
      return `No answer from ${where} in time.`;
    case 'EDNS':
    case 'ECONNECTION':
    case 'ESOCKET':
      return `Couldn’t reach ${where}.`;
    case 'EENVELOPE':
      return 'The mail server refused the From address or your address.';
    default:
      return 'The mail server didn’t accept the message.';
  }
}

export function mountAdminRoutes(
  routes: Routes,
  { db, auth, config, mailer, transport, log }: Deps,
): void {
  const environment = mailFromEnvironment(config.smtp);
  const mailView = (saved: MailSettings) => {
    const shown = (field: (typeof environment)[number]) => !environment.includes(field);
    return {
      host: shown('host') ? saved.host : null,
      port: shown('port') ? saved.port : null,
      security: shown('security') ? saved.security : null,
      username: shown('username') ? saved.username : null,
      passwordSaved: shown('password') && saved.password !== null,
      from: shown('from') ? saved.from : null,
      environment,
      ready: mailSetup(config.smtp, saved) !== null,
    };
  };
  /** The form's values, less the fields the environment sets. */
  const editable = (form: z.output<typeof adminRoutes.MailForm>) => {
    const changes = { ...form };
    for (const field of environment) delete changes[field];
    return changes;
  };

  const inviteLink = (token: string) => `${config.publicOrigin}/invite#token=${token}`;

  /** Email-bound invitations are mailed; generic ones return the link once. */
  const deliverInvitation = (invitation: InvitationRow, token: string, inviter: string) => {
    if (invitation.email === null) return inviteLink(token);
    sendInBackground(
      mailer.deliver,
      log,
      invitationMail(invitation.email, inviteLink(token), inviter),
    );
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
      await mailer.require();
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
      // A link for anyone needs no mail; one for an address is mailed to it.
      if (body.email !== null) await mailer.require();
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
      await mailer.require();
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

  // Mails nothing, so it isn't under the mail limit.
  routes.admin(adminRoutes.newInvitationLink, async ({ params }, { principal }) => {
    const { invitation, token } = await newInvitationLink(db, {
      actor: principal.accountId,
      id: params.id,
    }).catch(toApiError);
    return { invitation: toPending(invitation), link: inviteLink(token) };
  });

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

  routes.admin(adminRoutes.getMailSettings, async () =>
    mailView(await readMailSettings(db, config.authSecret)),
  );

  routes.admin(adminRoutes.updateMailSettings, async ({ body }, { principal }) => {
    const saved = await saveMailSettings(db, config.authSecret, {
      actor: principal.accountId,
      changes: editable(body),
    }).catch(toApiError);
    mailer.reload();
    return mailView(saved);
  });

  routes.admin(
    adminRoutes.sendTestMail,
    async ({ body }, { principal }) => {
      const saved = await readMailSettings(db, config.authSecret);
      const setup = mailSetup(config.smtp, withChanges(saved, editable(body)));
      if (!setup) throw new ApiError('mail-failed', 'Fill in the server, port and From first.');
      try {
        await transport(setup)(testMail(principal.email, config.publicOrigin));
      } catch (error) {
        throw new ApiError('mail-failed', mailFailure(error, setup));
      }
      return { sentTo: principal.email };
    },
    { rateLimit: MAIL_LIMIT },
  );
}
