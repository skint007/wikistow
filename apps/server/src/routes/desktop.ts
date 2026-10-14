import { desktopRoutes } from '@wikistow/contracts';
import {
  accountState,
  approveDesktopHandoff,
  listDesktopSessions,
  redeemDesktopHandoff,
  revokeDesktopSession,
  desktopApprovalStands,
  type Database,
} from '@wikistow/server';
import { makeSignature } from 'better-auth/crypto';
import type { Auth } from '../auth/auth.ts';
import { ApiError } from '../http/errors.ts';
import type { Routes } from '../http/mount.ts';

const APPROVE_LIMIT = { windowSeconds: 60, max: 10 };
const REDEEM_LIMIT = { windowSeconds: 60, max: 10 };

/**
 * Desktop sign-in (`desktopRoutes`): the browser approves, the app redeems.
 * A redeemed code becomes an ordinary Better Auth session marked `desktop`,
 * so sign-out, suspension, password resets and an administrator's "revoke
 * sessions" end it like any other.
 */
export function mountDesktopRoutes(routes: Routes, { db, auth }: { db: Database; auth: Auth }) {
  // A recent sign-in, so a script running in the page, or someone at a
  // session left open, can't quietly mint a session that outlives the tab.
  routes.account(
    desktopRoutes.approveHandoff,
    async ({ body }, { principal }) => ({
      code: await approveDesktopHandoff(
        db,
        { userId: principal.accountId, sessionId: principal.sessionId },
        body.challenge,
      ),
    }),
    { rateLimit: APPROVE_LIMIT, recentAuth: true },
  );

  routes.public(
    desktopRoutes.redeemHandoff,
    async ({ body }, { c }) => {
      // Only the app redeems. A page that could would hold a session token
      // its own scripts can read.
      if (c.req.header('origin') !== undefined) {
        throw new ApiError('forbidden', 'Only the desktop app redeems a sign-in');
      }
      const approved = await redeemDesktopHandoff(db, body.code, body.verifier);
      const expired = () =>
        new ApiError('handoff-invalid', 'This sign-in has expired; start again');
      if (!approved) throw expired();
      if ((await accountState(db, approved.userId)) !== 'active') {
        throw new ApiError('account-suspended', 'This account is suspended');
      }
      const context = await auth.$context;
      // `overrideAll`, or the field's default would win over `kind`.
      const session = await context.internalAdapter.createSession(
        approved.userId,
        false,
        { kind: 'desktop' },
        true,
      );
      // The approving session may have ended while this one was made: a
      // revocation in that moment must reach the new session too.
      if (!(await desktopApprovalStands(db, approved))) {
        await context.internalAdapter.deleteSession(session.token);
        throw expired();
      }
      // Signed as Better Auth signs its own cookie, so the server reads it back unchanged.
      const value = `${session.token}.${await makeSignature(session.token, context.secret)}`;
      return { cookie: `${context.authCookies.sessionToken.name}=${encodeURIComponent(value)}` };
    },
    { rateLimit: REDEEM_LIMIT },
  );

  routes.account(desktopRoutes.listDesktopSessions, async (_input, { principal }) => ({
    sessions: (await listDesktopSessions(db, principal.accountId)).map((session) => ({
      id: session.id,
      createdAt: session.createdAt.toISOString(),
      expiresAt: session.expiresAt.toISOString(),
      current: session.id === principal.sessionId,
    })),
  }));

  routes.account(desktopRoutes.revokeDesktopSession, async ({ params }, { principal }) => {
    if (!(await revokeDesktopSession(db, principal.accountId, params.sessionId))) {
      throw new ApiError('not-found', 'No such desktop app');
    }
    return {};
  });
}
