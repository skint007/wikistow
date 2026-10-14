import { twoFactorClient } from 'better-auth/client/plugins';
import { createAuthClient } from 'better-auth/react';
import { desktop } from '../desktop';

// The desktop app's pages live at `app://wikistow`, which Better Auth won't
// take as a base URL. There they name this stand-in instead, and every
// request goes to their own origin, where the app forwards it to the server.
const STAND_IN = 'http://wikistow.desktop';

const sendToOwnOrigin = (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : input, STAND_IN);
  return fetch(`${url.pathname}${url.search}`, init);
};

/** Better Auth's browser client: sign-in, two-factor, passwords, and sign-out. */
export const authClient = createAuthClient({
  basePath: '/api/auth',
  plugins: [twoFactorClient()],
  ...(desktop && { baseURL: STAND_IN, fetchOptions: { customFetchImpl: sendToOwnOrigin } }),
});
