import { createHash, randomBytes } from 'node:crypto';
import { desktopRoutes, systemRoutes } from '@wikistow/contracts';

/**
 * The server an origin names, if this app may sign in to it: `https:`, or
 * plain `http:` on this computer only, as the CLI allows. Paths are dropped.
 */
export function serverOrigin(input: string): string | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) return null;
  if (url.username || url.password) return null;
  return url.origin;
}

/**
 * The one-time code in a `wikistow://signed-in?code=…` link, or null for
 * anything else. Links arrive as command-line arguments, from any program.
 */
export function handoffCode(link: string): string | null {
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return null;
  }
  if (`${url.protocol}//${url.host}${url.pathname}` !== desktopRoutes.DESKTOP_LINK) return null;
  const codes = url.searchParams.getAll('code');
  if (codes.length !== 1 || [...url.searchParams.keys()].length !== 1) return null;
  const parsed = desktopRoutes.HandoffCode.safeParse(codes[0]);
  return parsed.success ? parsed.data : null;
}

/** A fresh verifier, and the challenge the browser page sends for it. */
export function newVerifier(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

export class SignInError extends Error {
  override readonly name = 'SignInError';
}

/**
 * Check `origin` really is a WikiStow server that calls itself by that name,
 * so a mistyped address or a redirect can't receive the session.
 */
export async function checkServer(origin: string, send: typeof fetch = fetch): Promise<void> {
  const answer = await send(`${origin}${systemRoutes.installation.path}`, {
    redirect: 'error',
  }).catch(() => {
    throw new SignInError(`Couldn’t reach ${origin}. Check the address and your connection.`);
  });
  const facts = answer.ok
    ? systemRoutes.installation.response.safeParse(await answer.json().catch(() => null))
    : null;
  if (!facts?.success) throw new SignInError(`${origin} isn’t a WikiStow server.`);
  if (!facts.data.origin) throw new SignInError('That server needs updating for the desktop app.');
  if (facts.data.origin !== origin) {
    throw new SignInError(`That server calls itself ${facts.data.origin}. Use that address.`);
  }
}

/**
 * Trade a code and its verifier for the session cookie. Null when the server
 * doesn't know the pair: a code that expired, or one made for another app.
 */
export async function redeem(
  origin: string,
  code: string,
  verifier: string,
  send: typeof fetch = fetch,
): Promise<string | null> {
  const route = desktopRoutes.redeemHandoff;
  const answer = await send(`${origin}${route.path}`, {
    method: route.method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, verifier }),
    redirect: 'error',
  }).catch(() => {
    throw new SignInError(`Couldn’t reach ${origin} to finish signing in.`);
  });
  if (answer.status === 410) return null;
  const body = route.response.safeParse(await answer.json().catch(() => null));
  if (!answer.ok || !body.success) {
    throw new SignInError('Signing in didn’t finish. Start again from this app.');
  }
  return body.data.cookie;
}

/**
 * End a session on the server, as signing out does; failures are ignored,
 * and so is the answer once `signal` aborts, such as when the app quits.
 */
export async function signOutSession(
  origin: string,
  cookie: string,
  signal?: AbortSignal,
  send: typeof fetch = fetch,
): Promise<void> {
  // Better Auth takes only JSON, even with nothing to say.
  await send(`${origin}/api/auth/sign-out`, {
    method: 'POST',
    headers: { cookie, origin, 'content-type': 'application/json' },
    body: '{}',
    redirect: 'error',
    signal: signal ?? null,
  }).catch(() => {});
}
