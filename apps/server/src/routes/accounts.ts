import { accountRoutes, type ErrorCode } from '@wikistow/contracts';
import {
  AccountError,
  AvatarRefused,
  avatarOf,
  avatarPart,
  confirmEmailChange,
  consumeRateLimit,
  createEmailChangeToken,
  currentIdentity,
  createAccount,
  findAvatar,
  finishAccountSetup,
  inspectInvitation,
  normalizeEmail,
  removeAvatar,
  schema,
  setAvatar,
  setTheme,
  type AccountFailure,
  type Database,
} from '@wikistow/server';
import { and, eq, lte, sql } from 'drizzle-orm';
import type { Context } from 'hono';
import { accountSetupMail } from '../auth/account-setup.ts';
import { TWO_FACTOR_LOCKOUT, type Auth } from '../auth/auth.ts';
import { GuessesRefused, type PasswordGuesses } from '../auth/password-guesses.ts';
import { ApiError } from '../http/errors.ts';
import type { Log } from '../http/logger.ts';
import type { Routes } from '../http/mount.ts';
import { sendInBackground, type Deliver } from '../mail/mailer.ts';
import {
  accountExistsMail,
  confirmNewEmailMail,
  emailChangedMail,
  verifyEmailMail,
} from '../mail/templates.ts';
import { APIError, createEmailVerificationToken } from 'better-auth/api';

const ACCOUNT_ERRORS = {
  'registration-closed': 'registration-closed',
  'invitation-not-found': 'invitation-not-found',
  'invitation-used': 'invitation-used',
  'invitation-revoked': 'invitation-revoked',
  'invitation-expired': 'invitation-expired',
  'invitation-email-mismatch': 'invitation-email-mismatch',
  'invitation-exists': 'invitation-exists',
  'email-taken': 'email-taken',
  'admin-exists': 'admin-exists',
  'account-not-found': 'not-found',
  'not-admin': 'forbidden',
  'cannot-target-self': 'cannot-target-self',
  'last-admin': 'last-admin',
  'details-required': 'invalid-request',
  'setup-link-invalid': 'setup-link-invalid',
  'email-link-invalid': 'email-link-invalid',
} as const satisfies Record<AccountFailure, ErrorCode>;

/** Turn a refused account operation into its API error; rethrow anything else. */
export function toApiError(error: unknown): never {
  if (error instanceof AccountError) throw new ApiError(ACCOUNT_ERRORS[error.code], error.message);
  throw error;
}

/** The link Better Auth's /verify-email accepts, built the way Better Auth builds it. */
async function verificationMail(auth: Auth, email: string) {
  const context = await auth.$context;
  const token = await createEmailVerificationToken(
    context.secret,
    email,
    undefined,
    context.options.emailVerification?.expiresIn,
  );
  const callbackURL = encodeURIComponent('/sign-in?verified=1');
  return verifyEmailMail(
    email,
    `${context.baseURL}/verify-email?token=${token}&callbackURL=${callbackURL}`,
  );
}

// Generous enough for a family filling in forms, tight enough to stop guessing.
const FORM_LIMIT = { windowSeconds: 60, max: 10 };

// Every confirmation is a password guess. With two-factor on it takes two
// requests, so twice sign-in's five a minute, counted per account.
const REAUTH_LIMIT = { windowSeconds: 60, max: 10 };

// Each request mails a link to an address the account doesn't own yet.
const EMAIL_CHANGE_LIMIT = { windowSeconds: 60, max: 3 };

// Changing an avatar a few times while picking one, not filling the database.
const AVATAR_LIMIT = { windowSeconds: 60, max: 10 };

// Browsers keep each avatar for good, so a client fetching many is unusual.
const AVATAR_FETCH_LIMIT = { windowSeconds: 60, max: 600 };

// How an avatar is sent: never sniffed as another type, never framed or
// cached under another name, and opened on its own, a sandboxed image that
// can't run scripts or load anything. A new upload gets a new address, so
// browsers may keep each one for good.
const AVATAR_CSP = "default-src 'none'; style-src 'unsafe-inline'; sandbox";
const AVATAR_FILE_NAMES = {
  'image/jpeg': 'avatar.jpg',
  'image/png': 'avatar.png',
  'image/gif': 'avatar.gif',
  'image/svg+xml': 'avatar.svg',
} as const;

// Avatars are read from the database a part at a time, as the client takes
// them, so a slow reader holds one part rather than the whole image.
const AVATAR_PART = 256 * 1024;

/** Checked as Better Auth's routes check passwords, against the account's allowance. */
async function passwordMatches(
  auth: Auth,
  guesses: PasswordGuesses,
  c: Context,
  account: { id: string; email: string },
  password: string,
) {
  const context = await auth.$context;
  const credential = await context.internalAdapter.findCredentialAccount(account.id);
  if (!credential?.password) return false;
  const hash = credential.password;
  try {
    const { result, setCookies } = await guesses.scope(
      { email: account.email, cookie: c.req.header('cookie') },
      () => context.password.verify({ hash, password }),
    );
    for (const cookie of setCookies) c.header('set-cookie', cookie, { append: true });
    return result;
  } catch (error) {
    if (error instanceof GuessesRefused) {
      throw new ApiError('account-rate-limited', error.message);
    }
    throw error;
  }
}

/**
 * Check a code against the signed-in account through Better Auth, which
 * also refuses an authenticator code already used and spends a backup code.
 * With a session present it neither creates nor replaces one. Called in
 * process, it skips the HTTP gate on code checks from a stale session
 * (app.ts); the password checked first stands in for it.
 *
 * Better Auth counts wrong codes toward its lockout only at sign-in, so
 * this does the same here, on the same row: a locked account is refused
 * before any code is tried, each wrong code counts, and a right one clears
 * the count.
 */
async function codeMatches(
  db: Database,
  auth: Auth,
  { accountId, headers }: { accountId: string; headers: Headers },
  code: { kind: 'totp' | 'backup'; value: string },
) {
  const factor = eq(schema.twoFactors.userId, accountId);
  const [state] = await db
    .select({ lockedUntil: schema.twoFactors.lockedUntil })
    .from(schema.twoFactors)
    .where(factor);
  if (state?.lockedUntil) {
    if (state.lockedUntil.getTime() > Date.now()) {
      throw new ApiError('two-factor-locked', 'Too many wrong codes. Try again later.');
    }
    // A lock that has run out starts the count again, as at sign-in.
    await db
      .update(schema.twoFactors)
      .set({ failedVerificationCount: 0, lockedUntil: null })
      .where(and(factor, lte(schema.twoFactors.lockedUntil, new Date())));
  }
  try {
    const body = { code: code.value };
    if (code.kind === 'totp') await auth.api.verifyTOTP({ headers, body });
    else await auth.api.verifyBackupCode({ headers, body });
  } catch (error) {
    // CONFLICT: another request spent this backup code first.
    if (
      !(error instanceof APIError) ||
      !['UNAUTHORIZED', 'CONFLICT'].includes(String(error.status))
    )
      throw error;
    const [counted] = await db
      .update(schema.twoFactors)
      .set({
        failedVerificationCount: sql`coalesce(${schema.twoFactors.failedVerificationCount}, 0) + 1`,
      })
      .where(factor)
      .returning({ failed: schema.twoFactors.failedVerificationCount });
    if ((counted?.failed ?? 0) >= TWO_FACTOR_LOCKOUT.maxFailedAttempts) {
      await db
        .update(schema.twoFactors)
        .set({ lockedUntil: new Date(Date.now() + TWO_FACTOR_LOCKOUT.durationSeconds * 1000) })
        .where(factor);
    }
    return false;
  }
  await db
    .update(schema.twoFactors)
    .set({ failedVerificationCount: 0, lockedUntil: null })
    .where(factor);
  return true;
}

export function mountAccountRoutes(
  routes: Routes,
  {
    db,
    auth,
    guesses,
    deliver,
    log,
    publicOrigin,
  }: {
    db: Database;
    auth: Auth;
    guesses: PasswordGuesses;
    deliver: Deliver;
    log: Log;
    publicOrigin: string;
  },
): void {
  routes.public(
    accountRoutes.createAccount,
    async ({ body }) => {
      const account = await createAccount(db, body).catch(toApiError);
      if (account.kind === 'existing') {
        // Open registration and generic links give the same answer for a taken
        // address. Only the owner hears of it: the setup link again if the
        // account was never finished, or else a notice.
        const { allowed } = await consumeRateLimit(db, `account-exists-mail:${account.email}`, {
          windowMs: 60_000,
          max: 3,
        });
        if (allowed) {
          const mail = account.finished
            ? accountExistsMail(account.email, `${publicOrigin}/sign-in`)
            : await accountSetupMail(db, publicOrigin, {
                id: account.accountId,
                email: account.email,
              });
          sendInBackground(deliver, log, mail);
        }
        return {};
      }
      // Both paths queue mail without Better Auth's HTTP timing pad, so a new
      // address and a taken one answer alike.
      const mail = account.emailBound
        ? await verificationMail(auth, account.email)
        : await accountSetupMail(db, publicOrigin, { id: account.accountId, email: account.email });
      sendInBackground(deliver, log, mail);
      return account.emailBound ? { accountId: account.accountId } : {};
    },
    { rateLimit: FORM_LIMIT },
  );

  routes.public(
    accountRoutes.finishAccountSetup,
    async ({ body }) => {
      await finishAccountSetup(db, body).catch(toApiError);
      return {};
    },
    { rateLimit: FORM_LIMIT },
  );

  routes.public(
    accountRoutes.inspectInvitation,
    async ({ body }) => {
      const result = await inspectInvitation(db, body.token);
      return result.status === 'valid'
        ? {
            status: 'valid' as const,
            email: result.email,
            expiresAt: result.expiresAt.toISOString(),
          }
        : { status: result.status };
    },
    { rateLimit: FORM_LIMIT },
  );

  routes.account(accountRoutes.me, async (_input, { principal }) => ({
    account: {
      id: principal.accountId,
      email: principal.email,
      name: principal.name,
      role: principal.role,
      theme: principal.theme,
      avatar: await avatarOf(db, principal.accountId),
    },
    session: { createdAt: principal.sessionCreatedAt.toISOString() },
    identity: await currentIdentity(db, principal.accountId),
  }));

  // The password comes first, so a stale stolen session can't try codes
  // without it, and a code sent with a wrong password isn't used up.
  routes.account(
    accountRoutes.reauthenticate,
    async ({ body }, { c, principal }) => {
      const self = { id: principal.accountId, email: principal.email };
      if (!(await passwordMatches(auth, guesses, c, self, body.password))) {
        throw new ApiError('wrong-password', 'That password is not right');
      }
      const [account] = await db
        .select({ twoFactorEnabled: schema.users.twoFactorEnabled })
        .from(schema.users)
        .where(eq(schema.users.id, principal.accountId));
      if (account?.twoFactorEnabled) {
        if (!body.code) return { status: 'code-required' as const };
        if (
          !(await codeMatches(
            db,
            auth,
            { accountId: principal.accountId, headers: c.req.raw.headers },
            body.code,
          ))
        ) {
          throw new ApiError('wrong-code', 'That code didn’t work');
        }
      }
      await db
        .update(schema.sessions)
        .set({ authenticatedAt: new Date() })
        .where(eq(schema.sessions.id, principal.sessionId));
      return { status: 'confirmed' as const };
    },
    { rateLimit: REAUTH_LIMIT },
  );

  // The new address gets a link and the same answer whether or not another
  // account has it; only opening the link changes anything.
  routes.account(
    accountRoutes.requestEmailChange,
    async ({ body }, { principal }) => {
      const email = normalizeEmail(body.email);
      if (email === principal.email) {
        throw new ApiError('invalid-request', 'That is already the account’s address');
      }
      const token = await createEmailChangeToken(db, principal.accountId, email);
      const url = `${publicOrigin}/confirm-email?token=${token}`;
      sendInBackground(deliver, log, confirmNewEmailMail(email, url));
      return {};
    },
    { recentAuth: true, rateLimit: EMAIL_CHANGE_LIMIT },
  );

  routes.public(
    accountRoutes.confirmEmailChange,
    async ({ body }) => {
      const change = await confirmEmailChange(db, body.token).catch(toApiError);
      sendInBackground(deliver, log, emailChangedMail(change.from, change.to));
      return { email: change.to };
    },
    { rateLimit: FORM_LIMIT },
  );

  routes.account(accountRoutes.setTheme, async ({ body }, { principal }) => {
    await setTheme(db, principal.accountId, body.theme);
    return { theme: body.theme };
  });

  // Only the signed-in person changes their own avatar: the account comes
  // from the session, never from the request.
  routes.upload(
    accountRoutes.AVATAR_UPLOAD_PATH,
    accountRoutes.MAX_AVATAR_BYTES,
    async (bytes, { c, principal }) => {
      try {
        const avatar = await setAvatar(db, principal.accountId, bytes);
        return c.json(accountRoutes.AvatarUpload.parse({ avatar }));
      } catch (error) {
        if (error instanceof AvatarRefused) throw new ApiError('unsupported-image', error.message);
        throw error;
      }
    },
    { rateLimit: AVATAR_LIMIT },
  );

  routes.account(
    accountRoutes.removeAvatar,
    async (_input, { principal }) => {
      await removeAvatar(db, principal.accountId);
      return {};
    },
    { rateLimit: AVATAR_LIMIT },
  );

  routes.publicFile(
    accountRoutes.AVATAR_PATH,
    async (c) => {
      const id = accountRoutes.AvatarId.safeParse(c.req.param('avatarId'));
      const found = id.success ? await findAvatar(db, id.data) : null;
      if (!id.success || !found) throw new ApiError('not-found', 'No such avatar');
      const headers = {
        'content-type': found.contentType,
        'content-length': String(found.size),
        'content-disposition': `inline; filename="${AVATAR_FILE_NAMES[found.contentType]}"`,
        'content-security-policy': AVATAR_CSP,
        'cache-control': 'public, max-age=31536000, immutable',
      };
      // Hono answers HEAD with the GET handler, dropping any body unread.
      if (c.req.method === 'HEAD') return c.body(null, 200, headers);
      let offset = 0;
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          const part = await avatarPart(db, id.data, offset, AVATAR_PART);
          if (!part?.byteLength) {
            controller.error(new Error('The avatar changed while it was being sent'));
            return;
          }
          controller.enqueue(part);
          offset += part.byteLength;
          if (offset >= found.size) controller.close();
        },
      });
      return c.body(body, 200, headers);
    },
    { rateLimit: AVATAR_FETCH_LIMIT },
  );
}
