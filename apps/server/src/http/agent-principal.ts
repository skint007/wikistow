import { authenticateAgent, type AgentCredential, type Database } from '@wikistow/server';
import type { Context } from 'hono';
import type { AppEnv } from './env.ts';
import { ApiError } from './errors.ts';

/**
 * Whether a request presents an agent's bearer token, which makes it an
 * agent's. Any other `Authorization`, such as the Basic credentials a proxy
 * in front of the app passes on, leaves it to the session.
 */
export const hasBearer = (c: Context<AppEnv>) =>
  c.req.header('authorization')?.startsWith('Bearer wsa_') ?? false;

/**
 * The agent behind `Authorization: Bearer wsa_…` (protocol section 9.6),
 * checked on every request. A request that also carries a cookie is
 * refused, so a token is never mixed with a person's session; so is one
 * from any origin but the app's own, where a person's app runs its agents,
 * and anything but exactly one well-formed token.
 */
export async function requireAgent(
  db: Database,
  c: Context<AppEnv>,
  publicOrigin: string,
): Promise<AgentCredential> {
  const origin = c.req.header('origin');
  if (c.req.header('cookie') !== undefined || (origin !== undefined && origin !== publicOrigin)) {
    throw new ApiError(
      'forbidden',
      'Agent tokens are not accepted with a session or from other sites',
    );
  }
  const [scheme, token, ...rest] = (c.req.header('authorization') ?? '').split(' ');
  const agent =
    scheme === 'Bearer' && token !== undefined && rest.length === 0
      ? await authenticateAgent(db, token)
      : null;
  if (!agent) throw new ApiError('unauthenticated', 'This agent token doesn’t work');
  return agent;
}
