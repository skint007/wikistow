import { z } from 'zod';
import type { RouteDef } from '../route.ts';

/** 32 random bytes, or a SHA-256 hash, in base64url. */
const Base64Url32 = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

/**
 * Desktop sign-in (RFC 8252, with a PKCE-style verifier). The desktop app
 * makes a random verifier and opens the system browser at
 * `/desktop-sign-in?challenge=<SHA-256 of it>`. The person, signed in there,
 * approves, and the browser opens `wikistow://signed-in?code=…`. The app then
 * redeems the code with its verifier for a desktop session of its own.
 */
export const DESKTOP_LINK = 'wikistow://signed-in';

export const Challenge = Base64Url32;
export const HandoffCode = Base64Url32;
export const Verifier = Base64Url32;

/** The signed-in person approves a desktop sign-in. */
export const approveHandoff = {
  method: 'POST',
  path: '/api/desktop/handoffs',
  body: z.object({ challenge: Challenge }),
  response: z.object({ code: HandoffCode }),
} as const satisfies RouteDef;

/**
 * The desktop app redeems its code. The answer is the session cookie, as a
 * `name=value` pair, which the app sends on its own requests and never shows
 * to its pages. Browsers can't call this: a request with an `Origin` is refused.
 */
export const redeemHandoff = {
  method: 'POST',
  path: '/api/desktop/sessions',
  body: z.object({ code: HandoffCode, verifier: Verifier }),
  response: z.object({ cookie: z.string().min(1) }),
} as const satisfies RouteDef;

export const DesktopSession = z.object({
  id: z.uuid(),
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  /** The session this request came with: the app being looked at. */
  current: z.boolean(),
});
export type DesktopSession = z.infer<typeof DesktopSession>;

export const listDesktopSessions = {
  method: 'GET',
  path: '/api/me/desktop-sessions',
  response: z.object({ sessions: z.array(DesktopSession) }),
} as const satisfies RouteDef;

/** Sign one desktop app out. Its next request finds no session. */
export const revokeDesktopSession = {
  method: 'DELETE',
  path: '/api/me/desktop-sessions/:sessionId',
  params: z.object({ sessionId: z.uuid() }),
  response: z.object({}),
} as const satisfies RouteDef;
