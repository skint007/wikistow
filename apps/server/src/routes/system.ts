import { systemRoutes } from '@wikistow/contracts';
import { readSettings, setupOpen, type Database } from '@wikistow/server';
import type { Routes } from '../http/mount.ts';

export function mountSystemRoutes(
  routes: Routes,
  { db, publicOrigin }: { db: Database; publicOrigin: string },
): void {
  routes.public(systemRoutes.health, () => ({ status: 'ok' as const }));

  routes.public(systemRoutes.installation, async () => {
    const { installationId, publicRegistration, restoredAt, backupTakenAt } =
      await readSettings(db);
    const restore = restoredAt && {
      restoredAt: restoredAt.toISOString(),
      backupTakenAt: backupTakenAt?.toISOString() ?? null,
    };
    return {
      installationId,
      publicRegistration,
      setup: await setupOpen(db),
      origin: publicOrigin,
      restore,
    };
  });
}
