import { pluginRoutes } from '@wikistow/contracts';
import { checkPlugin, PluginFolderError } from '@wikistow/plugin-sdk/files';
import { and, desc, eq } from 'drizzle-orm';
import { ContentError } from '../content/errors.ts';
import type { Database } from '../db/client.ts';
import { plugins, pluginVersions, users } from '../db/schema/index.ts';
import type { PluginStore } from './store.ts';

/*
 * The plugin library (ADR 0002). Any person may upload a built plugin; the
 * first to upload an ID owns it for good, and only they upload its later
 * versions and choose whether it is Shared or Only me (ADR 0004).
 * The owner or an administrator removes a version or the whole plugin.
 * Files go to the store before the rows that list them, and are deleted
 * after, so a crash leaves at worst files no row lists, which
 * `sweepPlugins` removes.
 */

const MB = 1024 * 1024;

const invalid = (message: string) => new ContentError('invalid-plugin', message);

type Visibility = pluginRoutes.PluginVisibility;

const setVisibility = (db: Pick<Database, 'update'>, pluginId: string, visibility: Visibility) =>
  db.update(plugins).set({ visibility }).where(eq(plugins.id, pluginId));

const versionOut = (row: typeof pluginVersions.$inferSelect) => ({
  hash: row.hash,
  manifest: row.manifest,
  files: row.files,
  size: row.size,
  uploadedAt: row.createdAt.toISOString(),
});

/** The first of `paths` that is also a folder of another, as can't be on disk. */
export function folderNamed(paths: string[]) {
  const folders = new Set(
    paths.flatMap((path) =>
      path
        .split('/')
        .slice(0, -1)
        .map((_, i, parts) => parts.slice(0, i + 1).join('/')),
    ),
  );
  return paths.find((path) => folders.has(path));
}

/**
 * A whole built folder, checked as the desktop checks one and within the
 * library's limits: what a library upload and a draft build must be.
 */
export async function checkUpload(files: { path: string; data: Uint8Array }[]) {
  const byPath = new Map(files.map(({ path, data }) => [path, data]));
  if (byPath.size !== files.length) throw invalid('A file is listed twice.');
  if (folderNamed(files.map(({ path }) => path))) throw invalid('A file has a folder’s name.');
  const size = files.reduce((total, { data }) => total + data.length, 0);
  if (size > pluginRoutes.MAX_VERSION_BYTES) {
    throw new ContentError(
      'too-large',
      `A plugin may hold ${pluginRoutes.MAX_VERSION_BYTES / MB} MB at most.`,
    );
  }
  const {
    manifest,
    files: paths,
    hash,
  } = await checkPlugin(byPath).catch((error: unknown) => {
    throw error instanceof PluginFolderError ? invalid(error.message) : error;
  });
  if (
    manifest.script &&
    (byPath.get(manifest.script)?.length ?? 0) > pluginRoutes.MAX_SCRIPT_BYTES
  ) {
    throw new ContentError(
      'too-large',
      `A plugin’s script may be ${pluginRoutes.MAX_SCRIPT_BYTES / MB} MB at most.`,
    );
  }
  return { byPath, manifest, paths, hash, size };
}

/**
 * A whole built folder, checked (`checkUpload`), then stored as a version.
 * `visibility` sets a new ID's, Shared if left out, and changes the
 * owner's existing one only when given.
 */
export async function uploadPlugin(
  db: Database,
  store: PluginStore,
  {
    accountId,
    files,
    visibility,
  }: {
    accountId: string;
    files: { path: string; data: Uint8Array }[];
    visibility?: Visibility | undefined;
  },
) {
  const { byPath, manifest, paths, hash, size } = await checkUpload(files);

  const notYours = () =>
    new ContentError('forbidden', `Another account owns the plugin ID ${manifest.id}.`);

  // Refused before any file is written, and again below, where it counts.
  const [claimed] = await db
    .select({ ownerId: plugins.ownerId })
    .from(plugins)
    .where(eq(plugins.id, manifest.id));
  if (claimed && claimed.ownerId !== accountId) throw notYours();
  const [stored] = await db.select().from(pluginVersions).where(eq(pluginVersions.hash, hash));
  if (stored) {
    // The ID is the caller's, since the hash covers the manifest.
    if (visibility) await setVisibility(db, manifest.id, visibility);
    return { pluginId: manifest.id, version: versionOut(stored) };
  }

  await store.put(hash, byPath);
  const version = await db.transaction(async (tx) => {
    await tx
      .insert(plugins)
      .values({ id: manifest.id, ownerId: accountId, visibility })
      .onConflictDoNothing();
    // Held until the version is in, so a removal waits for it. The row only
    // goes with its owner's account.
    const [plugin] = await tx
      .select({ ownerId: plugins.ownerId })
      .from(plugins)
      .where(eq(plugins.id, manifest.id))
      .for('update');
    if (!plugin) throw new Error('plugin row went with its owner');
    if (plugin.ownerId !== accountId) throw notYours();
    if (visibility) await setVisibility(tx, manifest.id, visibility);
    const [inserted] = await tx
      .insert(pluginVersions)
      .values({ hash, pluginId: manifest.id, manifest, files: paths, size, uploadedBy: accountId })
      .onConflictDoNothing()
      .returning();
    return (
      inserted ?? (await tx.select().from(pluginVersions).where(eq(pluginVersions.hash, hash)))[0]
    );
  });
  if (!version) throw new Error('plugin version was not stored');
  return { pluginId: manifest.id, version: versionOut(version) };
}

/**
 * Every plugin in the library `accountId` may see, with its versions,
 * newest first: the Shared ones, their own, and each Only me one with a
 * version whose hash is in `have`, the hashes they approved.
 */
export async function listPlugins(db: Database, accountId: string, have: readonly string[] = []) {
  const owned = await db
    .select({
      id: plugins.id,
      ownerId: plugins.ownerId,
      ownerName: users.name,
      visibility: plugins.visibility,
    })
    .from(plugins)
    .innerJoin(users, eq(users.id, plugins.ownerId))
    .orderBy(plugins.id);
  const versions = await db.select().from(pluginVersions).orderBy(desc(pluginVersions.createdAt));
  const known = new Set(have);
  return owned.flatMap(({ id, ownerId, ownerName, visibility }) => {
    const own = versions.filter((version) => version.pluginId === id);
    const mine = ownerId === accountId;
    const listed =
      visibility === 'shared' || mine || own.some((version) => known.has(version.hash));
    return own.length === 0 || !listed
      ? []
      : [{ id, owner: { name: ownerName }, mine, versions: own.map(versionOut) }];
  });
}

/** The IDs of `accountId`'s own Only me plugins. */
export async function privatePlugins(db: Database, accountId: string) {
  const rows = await db
    .select({ id: plugins.id })
    .from(plugins)
    .where(and(eq(plugins.ownerId, accountId), eq(plugins.visibility, 'private')))
    .orderBy(plugins.id);
  return rows.map(({ id }) => id);
}

/**
 * Make `pluginId` Shared or Only me: its owner only, since who sees it is
 * theirs to choose. Going Only me stops new installs only (`listPlugins`).
 */
export async function setPluginVisibility(
  db: Database,
  {
    accountId,
    pluginId,
    visibility,
  }: { accountId: string; pluginId: string; visibility: Visibility },
) {
  const changed = await db
    .update(plugins)
    .set({ visibility })
    .where(and(eq(plugins.id, pluginId), eq(plugins.ownerId, accountId)))
    .returning({ id: plugins.id });
  if (changed.length > 0) return;
  const [plugin] = await db
    .select({ id: plugins.id })
    .from(plugins)
    .where(eq(plugins.id, pluginId));
  if (!plugin) throw new ContentError('not-found', 'No such plugin');
  throw new ContentError('forbidden', 'Only its owner chooses who sees a plugin.');
}

type Remover = { accountId: string; admin: boolean };

/**
 * Remove `hash` from `pluginId`, or with no hash every version, and the
 * files that go with them. The ID stays its owner's, so another account's
 * plugin can never come in as an update of one people approved; a plugin
 * with no versions isn't listed.
 */
export async function removePlugin(
  db: Database,
  store: PluginStore,
  { accountId, admin, pluginId, hash }: Remover & { pluginId: string; hash?: string },
) {
  const removed = await db.transaction(async (tx) => {
    const [plugin] = await tx
      .select({ ownerId: plugins.ownerId })
      .from(plugins)
      .where(eq(plugins.id, pluginId))
      .for('update');
    if (!plugin) throw new ContentError('not-found', 'No such plugin');
    if (plugin.ownerId !== accountId && !admin) {
      throw new ContentError('forbidden', 'Only its owner or an administrator removes a plugin.');
    }
    const gone = await tx
      .delete(pluginVersions)
      .where(
        and(
          eq(pluginVersions.pluginId, pluginId),
          hash === undefined ? undefined : eq(pluginVersions.hash, hash),
        ),
      )
      .returning({ hash: pluginVersions.hash });
    if (hash !== undefined && gone.length === 0)
      throw new ContentError('not-found', 'No such version');
    return gone.map((row) => row.hash);
  });
  for (const gone of removed) await store.delete(gone);
}

/** A version's file, if `pluginId` has that version and the version that file. */
export async function pluginFile(
  db: Database,
  store: PluginStore,
  { pluginId, hash, path }: { pluginId: string; hash: string; path: string },
) {
  const [version] = await db
    .select({ hash: pluginVersions.hash })
    .from(pluginVersions)
    .where(and(eq(pluginVersions.hash, hash), eq(pluginVersions.pluginId, pluginId)));
  return version ? store.get(hash, path) : null;
}

/**
 * Remove stored versions no row lists, written before the grace period:
 * those of uploads cut short, of removals whose files outlived a crash,
 * and any a restored backup brought back. How many went.
 */
export async function sweepPlugins(
  db: Database,
  store: PluginStore,
  { graceMs = 24 * 60 * 60 * 1000 } = {},
) {
  const cutoff = new Date(Date.now() - graceMs);
  let removed = 0;
  for await (const { hash, writtenAt } of store.list()) {
    if (writtenAt >= cutoff) continue;
    const [listed] = await db
      .select({ hash: pluginVersions.hash })
      .from(pluginVersions)
      .where(eq(pluginVersions.hash, hash));
    if (listed) continue;
    await store.delete(hash);
    removed++;
  }
  await store.clearStaging(graceMs);
  return removed;
}
