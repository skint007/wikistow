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
     * True while the server has no accounts. The app then offers to create
     * the first one, its administrator (`createFirstAccount`). Missing from
     * servers older than it.
     */
    setup: z.boolean().optional(),
    /**
     * Where the server is reached, as clients outside the browser should
     * name it. Missing from servers older than the desktop app.
     */
    origin: z.url().optional(),
    /**
     * When an operator last restored a backup (`scripts/restore.sh`), and
     * when that backup was taken, if known; null if never. Clients take what
     * a server serves after a restore they haven't seen as their new
     * starting point, not as a rollback (`unseenRestore`). Missing from
     * servers older than it.
     */
    restore: z
      .object({ restoredAt: z.iso.datetime(), backupTakenAt: z.iso.datetime().nullable() })
      .nullable()
      .optional(),
  }),
} as const satisfies RouteDef;
