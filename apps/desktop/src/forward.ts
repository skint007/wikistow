/**
 * Where the pages' API requests go, and the server's cookies that go with
 * them, as a `Cookie` header: the session, and the device cookie that keeps
 * password checks from counting against the account (`password-guesses.ts`).
 */
export type Upstream = { origin: string; cookie: string | null };

/**
 * The server's answer, for the page, and what became of its cookies: the new
 * header when it set or cleared one (a password change replaces the session),
 * null when none are left, or undefined when it left them alone.
 */
export type Forwarded = { response: Response; cookie: string | null | undefined };

// Headers a page may not choose: who it is and what it carries are the app's
// to say. The body is re-sent whole, so its length and framing are recomputed.
const DROPPED_REQUEST = [
  'cookie',
  'origin',
  'referer',
  'authorization',
  'host',
  'content-length',
  'transfer-encoding',
];

// The cookies stay in the main process. `fetch` has already decoded the
// body, so its encoding and length no longer describe it.
const DROPPED_RESPONSE = ['set-cookie', 'content-encoding', 'content-length', 'transfer-encoding'];

/**
 * Send one of the pages' `app://wikistow/api/…` requests on to the server, as
 * the server's own pages would send it: with the session cookie and the
 * server's origin. Better Auth refuses a request with cookies and no origin,
 * and the server refuses any origin but its own, so the origin is replaced,
 * never dropped. Redirects come back as they are, so the cookie never
 * follows one anywhere.
 */
export async function forward(
  request: Request,
  upstream: Upstream,
  send: typeof fetch = fetch,
): Promise<Forwarded> {
  const url = new URL(request.url);
  const headers = new Headers(request.headers);
  // An agent the app runs (the page chat's) sends its own token, and never
  // goes with the person's session (protocol section 9.6).
  const agent = headers.get('authorization')?.startsWith('Bearer wsa_') ?? false;
  for (const name of DROPPED_REQUEST)
    if (!(agent && name === 'authorization')) headers.delete(name);
  headers.set('origin', upstream.origin);
  if (upstream.cookie && !agent) headers.set('cookie', upstream.cookie);
  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
  const answer = await send(`${upstream.origin}${url.pathname}${url.search}`, {
    method: request.method,
    headers,
    redirect: 'manual',
    ...(hasBody ? { body: await request.arrayBuffer() } : {}),
  });
  const kept = new Headers(answer.headers);
  for (const name of DROPPED_RESPONSE) kept.delete(name);
  return {
    response: new Response(answer.body, {
      status: answer.status,
      statusText: answer.statusText,
      headers: kept,
    }),
    cookie: cookieChange(upstream.cookie, answer.headers.getSetCookie()),
  };
}

/**
 * What the server's `Set-Cookie` headers make of the `Cookie` header
 * `current`: the new header, null when no cookie is left, or undefined when
 * nothing changed. One server, so paths and domains don't matter.
 */
export function cookieChange(
  current: string | null,
  setCookies: string[],
): string | null | undefined {
  const jar = new Map<string, string>();
  for (const pair of current?.split('; ') ?? []) {
    const split = pair.indexOf('=');
    if (split > 0) jar.set(pair.slice(0, split), pair.slice(split + 1));
  }
  let changed = false;
  for (const header of setCookies) {
    const [pair = '', ...attributes] = header.split(';');
    const split = pair.indexOf('=');
    if (split <= 0) continue;
    const name = pair.slice(0, split).trim();
    const value = pair.slice(split + 1).trim();
    const expired = attributes.some((attribute) => /^\s*max-age\s*=\s*0\s*$/i.test(attribute));
    if (value === '' || expired) changed = jar.delete(name) || changed;
    else if (jar.get(name) !== value) {
      jar.set(name, value);
      changed = true;
    }
  }
  if (!changed) return undefined;
  return jar.size === 0 ? null : [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
}
