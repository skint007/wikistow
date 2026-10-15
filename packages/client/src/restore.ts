// Getting past a restore (docs/operations.md, "What a restore undoes"). An
// operator restoring an older backup rolls back every record, which the
// contacts mark and the No going back marks would refuse. The server says
// when it was last restored, and a client that hasn't seen that restore yet
// drops those marks and starts again from what the server serves now.
import type { systemRoutes } from '@wikistow/contracts';
import type { z } from 'zod';

/** The last restore, as `GET /api/installation` reports it. */
export type Restore = NonNullable<z.infer<typeof systemRoutes.installation.response>['restore']>;

/**
 * The restore the server reports, if it isn't the one this client last saw:
 * `seen` is the `restoredAt` it kept, or null if it kept none. When this
 * gives one, the client's marks describe the server as it was before the
 * restore. Drop them, so what it serves now becomes the starting point, keep
 * `restoredAt` with the marks as the new `seen`, and tell the person
 * (`restoreNotice`). A client meeting the server for the first time has no
 * marks to drop: it keeps `restoredAt` and says nothing.
 */
export function unseenRestore(
  served: Restore | null | undefined,
  seen: string | null,
): Restore | null {
  return served && served.restoredAt !== seen ? served : null;
}

/** What to tell the person about a restore, with dates as `date` writes them. */
export function restoreNotice(restore: Restore, date: (iso: string) => string): string {
  return restore.backupTakenAt
    ? `This server was restored from a backup taken on ${date(restore.backupTakenAt)}. Changes made after that are gone.`
    : `This server was restored from an older backup on ${date(restore.restoredAt)}. Changes made after that backup was taken are gone.`;
}
