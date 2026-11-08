import { and, eq, lt, sql } from 'drizzle-orm';
import { ContentError } from '../content/errors.ts';
import type { Database } from '../db/client.ts';
import { pluginDevelopmentFiles as files } from '../db/schema/index.ts';
import { checkUpload } from './library.ts';

/*
 * Development builds (#317): a browser loading a plugin folder for
 * development uploads each Reload's build here, one per account and plugin
 * ID, served only to that account. Separate from the library, which an
 * upload would add a version to, and from a draft's build, which the
 * workshop replaces as it previews.
 */

type Slot = { accountId: string; pluginId: string };

/** How long a build stays after its last Reload. The tab that loaded it has usually gone long before. */
const KEPT_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Replace the caller's development build of `pluginId` with a built folder,
 * checked as a library upload is (`checkUpload`), whoever owns the ID in
 * the library. Its hash.
 */
export async function putPluginDevelopment(
  db: Database,
  { accountId, pluginId, files: upload }: Slot & { files: { path: string; data: Uint8Array }[] },
) {
  const { byPath, manifest, hash } = await checkUpload(upload);
  if (manifest.id !== pluginId) {
    throw new ContentError('invalid-plugin', `The folder holds ${manifest.id}, not ${pluginId}.`);
  }
  await db.transaction(async (tx) => {
    // One Reload at a time per slot, so two never mix their files.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`wikistow:plugin-development:${accountId}:${pluginId}`}))`,
    );
    await tx.delete(files).where(slot({ accountId, pluginId }));
    await tx
      .insert(files)
      .values([...byPath].map(([path, data]) => ({ accountId, pluginId, hash, path, data })));
  });
  return { hash };
}

/** Remove the caller's development build of `pluginId`, if any. */
export async function removePluginDevelopment(db: Database, at: Slot) {
  await db.delete(files).where(slot(at));
}

/**
 * A file of the caller's own development build of `pluginId` with that
 * hash: what the file route serves under `dev-<hash>-<n>`.
 */
export async function pluginDevelopmentFile(
  db: Database,
  { hash, path, ...at }: Slot & { hash: string; path: string },
) {
  const [file] = await db
    .select({ data: files.data })
    .from(files)
    .where(and(slot(at), eq(files.hash, hash), eq(files.path, path)));
  // A copy on its own `ArrayBuffer`, as a response body takes.
  return file ? new Uint8Array(file.data) : null;
}

/** Remove development builds not reloaded for a week. How many files went. */
export async function sweepPluginDevelopment(db: Database, { keptMs = KEPT_MS } = {}) {
  const gone = await db
    .delete(files)
    .where(lt(files.loadedAt, new Date(Date.now() - keptMs)))
    .returning({ path: files.path });
  return gone.length;
}

const slot = ({ accountId, pluginId }: Slot) =>
  and(eq(files.accountId, accountId), eq(files.pluginId, pluginId));
