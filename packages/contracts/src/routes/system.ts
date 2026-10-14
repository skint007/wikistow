import { z } from 'zod';
import { InstallationId } from '../records/ids.ts';
import type { RouteDef } from '../route.ts';

export const health = {
  method: 'GET',
  path: '/api/health',
  response: z.object({ status: z.literal('ok') }),
} as const satisfies RouteDef;

/** Public facts about this installation that clients need before signing in. */
export const installation = {
  method: 'GET',
  path: '/api/installation',
  response: z.object({
    installationId: InstallationId,
    publicRegistration: z.boolean(),
    /**
     * Where the server is reached, as clients outside the browser should
     * name it. Missing from servers older than the desktop app.
     */
    origin: z.url().optional(),
  }),
} as const satisfies RouteDef;
