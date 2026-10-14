import { accountRoutes } from '@wikistow/contracts';
import type { Context } from 'hono';
import type { Auth } from '../auth/auth.ts';
import type { AppEnv } from './env.ts';
import { ApiError } from './errors.ts';

/** The signed-in account behind a request, read fresh from the database. */
export type Principal = {
  accountId: string;
  email: string;
  name: string;
  role: 'user' | 'admin';
  theme: (typeof accountRoutes.THEMES)[number];
  sessionId: string;
  sessionCreatedAt: Date;
  /** When this session's holder last signed in with every factor; null if never. */
  authenticatedAt: Date | null;
};

/** Changes that need someone at the keyboard require a full sign-in this recent. */
export const RECENT_AUTH_MS = 10 * 60 * 1000;

export const isRecentlyAuthenticated = (
  authenticatedAt: Date | null | undefined,
  now = Date.now(),
) => authenticatedAt instanceof Date && now - authenticatedAt.getTime() <= RECENT_AUTH_MS;

/**
 * Resolve the session cookie to an active, verified account, or throw.
 * Better Auth reads the session and user rows on every call (its cookie cache
 * is off), so a suspension or revoked session takes effect on the next request.
 */
export async function requirePrincipal(auth: Auth, c: Context<AppEnv>): Promise<Principal> {
  const { headers, response: result } = await auth.api.getSession({
    headers: c.req.raw.headers,
    returnHeaders: true,
  });
  // Reading the session may renew it; pass the renewed cookie on, or the
  // browser's copy would expire however active the person is.
  for (const cookie of headers.getSetCookie()) c.header('set-cookie', cookie, { append: true });
  if (!result) throw new ApiError('unauthenticated', 'Sign in first');
  const { user, session } = result;
  if (user.suspendedAt) throw new ApiError('account-suspended', 'This account is suspended');
  if (!user.emailVerified) throw new ApiError('email-unverified', 'Confirm your email first');
  const role = accountRoutes.Role.safeParse(user.role);
  const theme = accountRoutes.Theme.safeParse(user.theme);
  if (!role.success || !theme.success) throw new Error('account row has an unknown role or theme');
  return {
    accountId: user.id,
    email: user.email,
    name: user.name,
    role: role.data,
    theme: theme.data,
    sessionId: session.id,
    sessionCreatedAt: session.createdAt,
    authenticatedAt: session.authenticatedAt ?? null,
  };
}
