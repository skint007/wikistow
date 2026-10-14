import { systemRoutes } from '@wikistow/contracts';
import { readSettings, type Database } from '@wikistow/server';
import type { Routes } from '../http/mount.ts';

export function mountSystemRoutes(
  routes: Routes,
  { db, publicOrigin }: { db: Database; publicOrigin: string },
): void {
  routes.public(systemRoutes.health, () => ({ status: 'ok' as const }));

  routes.public(systemRoutes.installation, async () => {
    const { installationId, publicRegistration } = await readSettings(db);
    return { installationId, publicRegistration, origin: publicOrigin };
  });
}
