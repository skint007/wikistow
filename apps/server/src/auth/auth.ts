import {
  accountState,
  markSessionEnding,
  revokeAgentCredentials,
  schema,
  usablePassword,
  type Database,
} from '@wikistow/server';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { APIError, createAuthMiddleware, getSessionFromCtx } from 'better-auth/api';
import { symmetricDecrypt } from 'better-auth/crypto';
import { createOTP } from '@better-auth/utils/otp';
import { and, eq, isNull, lt, or } from 'drizzle-orm';
import { twoFactor } from 'better-auth/plugins';
import type { Config } from '../config.ts';
import type { Log } from '../http/logger.ts';
import { sendInBackground, type Mail, type Mailer } from '../mail/mailer.ts';
import { resetPasswordMail, verifyEmailMail } from '../mail/templates.ts';
import { accountSetupMail } from './account-setup.ts';
import type { PasswordGuesses } from './password-guesses.ts';

/**
 * Better Auth paths that are switched off. Account creation belongs to
 * `POST /api/accounts` alone; profile and account changes go through app
 * routes. `test/closed-signup.integration.test.ts` keeps a full inventory, so a
 * new upstream route has to be reviewed before it ships.
 */
export const DISABLED_AUTH_PATHS = [
  '/sign-up/email',
  '/update-user',
  '/change-email',
  '/delete-user',
  '/delete-user/callback',
  '/sign-in/social',
  '/link-social',
  '/unlink-account',
  '/callback/:id',
  '/refresh-token',
  '/get-access-token',
  '/account-info',
  '/update-session',
  // Lists the sessions before deleting them one by one, so a desktop sign-in
  // saved in between would outlive it (`desktopApprovalStands`). The app
  // signs other sessions out through /revoke-sessions or a password change.
  '/revoke-other-sessions',
  // Only TOTP and backup codes; no codes by email.
  '/two-factor/send-otp',
  '/two-factor/verify-otp',
] as const;

/**
 * Wrong two-factor codes in a row before the account's codes are refused for
 * a while. Sign-in (Better Auth) and confirming it's you again (our
 * /api/me/reauth) count against the same budget.
 */
export const TWO_FACTOR_LOCKOUT = { maxFailedAttempts: 10, durationSeconds: 15 * 60 } as const;

/**
 * Better Auth paths that never answer sooner than `EQUAL_TIME_FLOOR_MS`. A
 * reset request for a known address writes a token where an unknown one only
 * reads, and the faster answer would show which addresses have accounts.
 */
export const EQUAL_TIME_AUTH_PATHS = ['/request-password-reset'] as const;

/** Well above the work either answer does, as Better Auth's own verification sender pads to. */
export const EQUAL_TIME_FLOOR_MS = 500;

/**
 * The client address, set by our own handler in front of Better Auth after
 * removing any copy the client sent. Better Auth reads only this header and
 * groups IPv6 addresses by /64, as the app's own limiter does.
 */
export const CLIENT_ADDRESS_HEADER = 'x-wikistow-client-address';

/**
 * The routes that prove who someone is: a password sign-in (Better Auth
 * discards that session and asks for a code when two-factor is on), or a
 * TOTP or backup code. Sessions created anywhere else are never "recent".
 */
const SIGN_IN_PATHS = new Set([
  '/sign-in/email',
  '/two-factor/verify-totp',
  '/two-factor/verify-backup-code',
]);

/**
 * Two-factor management needs a recent full sign-in, so a stolen session and
 * the password alone can't switch the second factor off or read its secret.
 */
export const RECENT_SIGN_IN_AUTH_PATHS = new Set([
  '/api/auth/two-factor/enable',
  '/api/auth/two-factor/disable',
  '/api/auth/two-factor/get-totp-uri',
  '/api/auth/two-factor/generate-backup-codes',
]);

/** Code checks that, when made with an existing session, confirm a new authenticator. */
export const SESSION_CODE_PATHS = new Set([
  '/api/auth/two-factor/verify-totp',
  '/api/auth/two-factor/verify-backup-code',
]);

// Paths where a client could ask to skip TOTP on future sign-ins.
const TRUST_DEVICE_PATHS = new Set(['/two-factor/verify-totp', '/two-factor/verify-backup-code']);

/** Better Auth paths that only mail something, refused while mail isn't set up. */
const MAILING_AUTH_PATHS = new Set(['/request-password-reset', '/send-verification-email']);
const mailOff = () => new APIError('CONFLICT', { message: 'Mail isn’t set up', code: 'mail-off' });

export type Auth = ReturnType<typeof createAuth>;

/**
 * Each authenticator code works once. Better Auth accepts a code for the
 * current 30-second step and its neighbours and keeps no record, so a code
 * seen over someone's shoulder would work again for about 90 seconds. The
 * step a code matches is claimed atomically; claiming it again fails.
 * Codes that match no step are left for Better Auth to refuse and count.
 */
async function refuseReplayedCode(db: Database, ctx: AuthHookContext) {
  const code: unknown = ctx.body?.code;
  if (typeof code !== 'string') return;
  const userId = await twoFactorUser(ctx);
  if (!userId) return;
  const [row] = await db
    .select({ secret: schema.twoFactors.secret })
    .from(schema.twoFactors)
    .where(eq(schema.twoFactors.userId, userId));
  if (!row) return;
  const secret = await symmetricDecrypt({ key: ctx.context.secretConfig, data: row.secret });
  const now = Math.floor(Date.now() / 30_000);
  let step: number | null = null;
  const otp = createOTP(secret, { digits: 6, period: 30 });
  for (const candidate of [now - 1, now, now + 1]) {
    if ((await otp.hotp(candidate)) === code) step = candidate;
  }
  if (step === null) return;
  const claimed = await db
    .update(schema.twoFactors)
    .set({ lastTotpStep: step })
    .where(
      and(
        eq(schema.twoFactors.userId, userId),
        or(isNull(schema.twoFactors.lastTotpStep), lt(schema.twoFactors.lastTotpStep, step)),
      ),
    )
    .returning({ userId: schema.twoFactors.userId });
  if (claimed.length === 0) {
    throw new APIError('UNAUTHORIZED', {
      message: 'That code was already used',
      code: 'INVALID_CODE',
    });
  }
}

/** Whose code this is: the signed-in account, or the one midway through signing in. */
async function twoFactorUser(ctx: AuthHookContext): Promise<string | null> {
  const session = await getSessionFromCtx(ctx);
  if (session) return session.user.id;
  const cookie = ctx.context.createAuthCookie('two_factor');
  const identifier = await ctx.getSignedCookie(cookie.name, ctx.context.secret);
  if (!identifier) return null;
  const pending = await ctx.context.internalAdapter.findVerificationValue(identifier);
  return pending?.value ?? null;
}

type AuthHookContext = Parameters<Parameters<typeof createAuthMiddleware>[0]>[0];

export function createAuth({
  db,
  config,
  mailer,
  log,
  guesses,
}: {
  db: Database;
  config: Config;
  mailer: Mailer;
  log: Log;
  guesses: PasswordGuesses;
}) {
  /** The setup link instead, for an account that has no password yet. */
  const mailFor = async (user: { id: string; email: string }, mail: () => Mail) =>
    (await usablePassword(db, user.id)) === null
      ? accountSetupMail(db, config.publicOrigin, user)
      : mail();
  return betterAuth({
    appName: 'WikiStow',
    baseURL: config.publicOrigin,
    basePath: '/api/auth',
    secret: config.authSecret,
    trustedOrigins: [config.publicOrigin],
    // Better Auth's own messages can quote queries with their parameters,
    // tokens included. Only that something happened, and how bad, is kept.
    logger: {
      level: 'warn',
      log: (level) => log({ level: level === 'error' ? 'error' : 'warn', event: 'better-auth' }),
    },
    database: drizzleAdapter(db, { provider: 'pg', usePlural: true, schema }),
    disabledPaths: [...DISABLED_AUTH_PATHS],
    hooks: {
      // disabledPaths only covers HTTP. Before-hooks also run for in-process
      // `auth.api` calls, so sign-up stays closed even for server code.
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path === '/sign-up/email') throw new APIError('NOT_FOUND');
        // These links can only arrive by mail, so say when there is none.
        if (MAILING_AUTH_PATHS.has(ctx.path) && !(await mailer.ready())) throw mailOff();
        // Matched here, as Better Auth routes it, rather than by URL.
        if (ctx.path === '/sign-in/email' && config.rateLimit) {
          const email: unknown = ctx.body?.email;
          if (typeof email === 'string') guesses.signingIn(email);
        }
        // Every fresh sign-in asks for the code, which is what makes the
        // recent-sign-in rule for administrators mean something.
        if (TRUST_DEVICE_PATHS.has(ctx.path) && ctx.body?.trustDevice === true) {
          throw new APIError('BAD_REQUEST', { message: 'Trusted devices are not supported' });
        }
        if (ctx.path === '/two-factor/verify-totp') await refuseReplayedCode(db, ctx);
      }),
      // An unconfirmed address is told a new link went out at sign-in (after
      // its password matched); with no mail, none did.
      after: createAuthMiddleware(async (ctx) => {
        const returned = ctx.context.returned;
        if (
          ctx.path === '/sign-in/email' &&
          returned instanceof APIError &&
          returned.body?.code === 'EMAIL_NOT_VERIFIED' &&
          !(await mailer.ready())
        ) {
          throw mailOff();
        }
      }),
    },
    advanced: {
      // One query per lookup, so signing in with a known address does the same
      // database work as with an unknown one (relations in db/schema/relations.ts).
      database: { generateId: false, joins: true },
      useSecureCookies: config.publicOrigin.startsWith('https:'),
      // Better Auth skips its cross-origin check when NODE_ENV is "test".
      // Forcing it on keeps tests honest about what production does.
      disableOriginCheck: false,
      ipAddress: { ipAddressHeaders: [CLIENT_ADDRESS_HEADER] },
    },
    // Every request reads the session row, so deleting sessions takes effect immediately.
    session: {
      cookieCache: { enabled: false },
      additionalFields: {
        authenticatedAt: { type: 'date', input: false, required: false },
        // `desktop` only for sessions redeemed from a desktop handoff (routes/desktop.ts).
        kind: { type: 'string', input: false, required: true, defaultValue: 'browser' },
      },
    },
    user: {
      additionalFields: {
        role: { type: 'string', input: false, required: true, defaultValue: 'user' },
        suspendedAt: { type: 'date', input: false, required: false },
        theme: { type: 'string', input: false, required: true, defaultValue: 'system' },
      },
    },
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: true,
      password: guesses.password,
      revokeSessionsOnPasswordReset: true,
      // A reset also ends every agent credential the account holds (#7,
      // protocol section 9.7). The trigger on `accounts` does that in the
      // transaction that stores the new password; this only repeats it.
      // Better Auth runs it before it deletes the sessions, so it must
      // never throw: a failure here would leave every session alive.
      onPasswordReset: async ({ user }) => {
        try {
          await db.transaction(async (tx) => {
            await revokeAgentCredentials(tx, user.id);
            // The reset token was mailed to this address. It proves ownership,
            // including when somebody else submitted the registration form.
            await tx
              .update(schema.users)
              .set({ emailVerified: true })
              .where(eq(schema.users.id, user.id));
          });
        } catch (error) {
          log({
            level: 'error',
            event: 'password-reset-agents',
            accountId: user.id,
            name: error instanceof Error ? error.name : 'unknown',
          });
        }
      },
      minPasswordLength: 12,
      maxPasswordLength: 256,
      resetPasswordTokenExpiresIn: 30 * 60,
      sendResetPassword: async ({ user, url }) => {
        sendInBackground(
          mailer.deliver,
          log,
          await mailFor(user, () => resetPasswordMail(user.email, url)),
        );
      },
    },
    emailVerification: {
      sendOnSignIn: true,
      expiresIn: 24 * 60 * 60,
      // Also behind the administrator's "Resend verification".
      sendVerificationEmail: async ({ user, url }) => {
        sendInBackground(
          mailer.deliver,
          log,
          await mailFor(user, () => verifyEmailMail(user.email, url)),
        );
      },
    },
    databaseHooks: {
      session: {
        create: {
          // A suspended account can't start a session, whatever route asks.
          // Only a real sign-in marks the session as freshly authenticated.
          before: async (session, ctx) => {
            const state = await accountState(db, session.userId);
            if (state !== 'active') {
              throw new APIError('FORBIDDEN', {
                message: 'Account suspended',
                code: 'ACCOUNT_SUSPENDED',
              });
            }
            const signedIn = ctx != null && SIGN_IN_PATHS.has(ctx.path);
            // A session made to replace the current one (a password change,
            // two-factor set up or turned off) keeps its kind, so a desktop
            // app stays one.
            const replaced: unknown = ctx?.context.session?.session.kind;
            return {
              data: {
                ...session,
                authenticatedAt: signedIn ? new Date() : null,
                ...(replaced === 'desktop' && { kind: 'desktop' }),
              },
            };
          },
        },
        // Marked first, so a desktop sign-in redeemed at the same moment is
        // refused (`desktopApprovalStands`).
        delete: {
          before: async (session) => {
            await markSessionEnding(db, session.userId);
          },
        },
      },
    },
    plugins: [
      twoFactor({
        issuer: 'WikiStow',
        accountLockout: {
          maxFailedAttempts: TWO_FACTOR_LOCKOUT.maxFailedAttempts,
          durationSeconds: TWO_FACTOR_LOCKOUT.durationSeconds,
        },
      }),
    ],
    rateLimit: {
      enabled: config.rateLimit,
      storage: 'database',
      customRules: {
        '/sign-in/email': { window: 60, max: 5 },
        '/request-password-reset': { window: 60, max: 3 },
        '/send-verification-email': { window: 60, max: 3 },
        '/reset-password': { window: 60, max: 5 },
        // Both take a password guess from a session holder, so they get
        // sign-in's limit rather than Better Auth's loose default.
        '/verify-password': { window: 60, max: 5 },
        '/change-password': { window: 60, max: 5 },
        // These take a password too, from someone with a recent session.
        '/two-factor/enable': { window: 60, max: 5 },
        '/two-factor/disable': { window: 60, max: 5 },
        '/two-factor/get-totp-uri': { window: 60, max: 5 },
        '/two-factor/generate-backup-codes': { window: 60, max: 5 },
      },
    },
  });
}
