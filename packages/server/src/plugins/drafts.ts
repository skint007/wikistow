import { pluginDraftRoutes } from '@wikistow/contracts';
import { MANIFEST_FILE } from '@wikistow/plugin-sdk/manifest';
import { and, count, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { ContentError } from '../content/errors.ts';
import type { Database } from '../db/client.ts';
import {
  pluginDraftBuildFiles,
  pluginDraftFiles,
  pluginDrafts,
  plugins,
  pluginVersions,
  users,
} from '../db/schema/index.ts';
import { checkUpload, folderNamed } from './library.ts';
import type { PluginStore } from './store.ts';

/*
 * Plugin drafts (ADR 0004): the workshop's files as the assistant last
 * saved them, at most `MAX_DRAFTS` per account, each with the one build a
 * browser last previewed. Every function takes the caller's account, and
 * another account's draft is `not-found`, the same as a missing one.
 */

const { DraftFile, MAX_DRAFTS, MAX_DRAFT_BYTES, MAX_DRAFT_FILE_BYTES, MAX_DRAFT_FILES } =
  pluginDraftRoutes;

const KB = 1024;
const MB = 1024 * 1024;
const UNTITLED = 'Untitled plugin';
const SOURCE = 'source/';

type DraftText = { path: string; text: string };
type Draft = { accountId: string; draftId: string };

const notFound = () => new ContentError('not-found', 'No such plugin draft');
const invalid = (message: string) => new ContentError('invalid-plugin', message);

// The manifest's `id` and `name`, when its JSON has them as strings.
const ManifestFields = z
  .object({
    id: z.string().optional().catch(undefined),
    name: z.string().optional().catch(undefined),
  })
  .catch({});

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

const manifestFields = (text: string | undefined) =>
  text === undefined ? {} : ManifestFields.parse(parseJson(text));

/** The draft's name from its manifest's text, if that names one. */
const nameFrom = (text: string | undefined) =>
  manifestFields(text).name?.trim().slice(0, 100) || undefined;

/** Refuse a draft's files, all of them as they would be, past the limits. */
function checkFiles(files: { path: string; size: number }[]) {
  if (files.length > MAX_DRAFT_FILES) {
    throw new ContentError('too-large', `A draft holds ${MAX_DRAFT_FILES} files at most.`);
  }
  const big = files.find(({ size }) => size > MAX_DRAFT_FILE_BYTES);
  if (big) {
    throw new ContentError(
      'too-large',
      `${big.path} is too large: a draft file holds ${MAX_DRAFT_FILE_BYTES / KB} KB at most.`,
    );
  }
  if (files.reduce((total, { size }) => total + size, 0) > MAX_DRAFT_BYTES) {
    throw new ContentError('too-large', `A draft holds ${MAX_DRAFT_BYTES / MB} MB at most.`);
  }
  const both = folderNamed(files.map(({ path }) => path));
  if (both) throw invalid(`“${both}” is also the name of a folder in the draft.`);
}

/** Files with their text's size in UTF-8, as the draft's rows hold them. */
const withSizes = (files: DraftText[]) =>
  files.map(({ path, text }) => ({ path, text, size: Buffer.byteLength(text) }));

const listed = (paths: string[]) => {
  if (new Set(paths).size !== paths.length) throw invalid('A file is named twice.');
};

/** Drafts' summaries, most recently changed first. */
async function summaries(db: Database, where: SQL | undefined) {
  const rows = await db
    .select({
      id: pluginDrafts.id,
      name: pluginDrafts.name,
      fromPluginId: pluginDrafts.fromPluginId,
      fromHash: pluginDrafts.fromHash,
      updatedAt: pluginDrafts.updatedAt,
      files: sql<number>`count(${pluginDraftFiles.path})::int`,
      size: sql<number>`coalesce(sum(${pluginDraftFiles.size}), 0)::int`,
    })
    .from(pluginDrafts)
    .leftJoin(pluginDraftFiles, eq(pluginDraftFiles.draftId, pluginDrafts.id))
    .where(where)
    .groupBy(pluginDrafts.id)
    .orderBy(desc(pluginDrafts.updatedAt));
  return rows.map(({ fromPluginId, fromHash, updatedAt, ...row }) => ({
    ...row,
    from:
      fromPluginId === null || fromHash === null
        ? null
        : { pluginId: fromPluginId, hash: fromHash },
    updatedAt: updatedAt.toISOString(),
  }));
}

async function summaryOf(db: Database, { accountId, draftId }: Draft) {
  const [summary] = await summaries(
    db,
    and(eq(pluginDrafts.id, draftId), eq(pluginDrafts.ownerId, accountId)),
  );
  if (!summary) throw notFound();
  return summary;
}

/** The draft, locked for this transaction, if it is the caller's. */
async function lockDraft(tx: Database, { accountId, draftId }: Draft) {
  const [draft] = await tx
    .select({ id: pluginDrafts.id })
    .from(pluginDrafts)
    .where(and(eq(pluginDrafts.id, draftId), eq(pluginDrafts.ownerId, accountId)))
    .for('update');
  if (!draft) throw notFound();
}

/** Whether `draftId` is the caller's: checked before a large body is read. */
export async function checkPluginDraftOwner(db: Database, draft: Draft) {
  await summaryOf(db, draft);
}

/** The caller's drafts, most recently changed first. */
export const listPluginDrafts = (db: Database, accountId: string) =>
  summaries(db, eq(pluginDrafts.ownerId, accountId));

/** A draft and every file's text, by path. */
export async function readPluginDraft(db: Database, draft: Draft) {
  const summary = await summaryOf(db, draft);
  const files = await db
    .select({ path: pluginDraftFiles.path, text: pluginDraftFiles.text })
    .from(pluginDraftFiles)
    .where(eq(pluginDraftFiles.draftId, draft.draftId))
    .orderBy(pluginDraftFiles.path);
  return { draft: summary, files };
}

/** `<id>-copy`, then `<id>-copy-2` and on, shortening `<id>` to keep within 40 characters. */
const copyName = (id: string, n: number) => {
  const suffix = n === 1 ? '-copy' : `-copy-${n}`;
  return `${id.slice(0, 40 - suffix.length).replace(/-+$/, '')}${suffix}`;
};

/**
 * A new ID for the caller's copy of `id`: the first `copyName` no account
 * has claimed and none of the caller's drafts names. Not reserved; the
 * library's upload has the final word.
 */
async function copyId(db: Database, accountId: string, id: string) {
  const claimed = await db.select({ id: plugins.id }).from(plugins);
  const drafted = await db
    .select({ text: pluginDraftFiles.text })
    .from(pluginDraftFiles)
    .innerJoin(pluginDrafts, eq(pluginDrafts.id, pluginDraftFiles.draftId))
    .where(and(eq(pluginDrafts.ownerId, accountId), eq(pluginDraftFiles.path, MANIFEST_FILE)));
  const taken = new Set([
    ...claimed.map((row) => row.id),
    ...drafted.flatMap((row) => manifestFields(row.text).id ?? []),
  ]);
  for (let n = 1; ; n++) {
    const candidate = copyName(id, n);
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * A library version's `source/` files, without the prefix, as a draft's.
 * Another account's plugin gets a new ID (`copyId`) in its manifest; the
 * rest of the source is as it was.
 */
async function sourceOf(
  db: Database,
  store: PluginStore,
  accountId: string,
  { pluginId, hash }: { pluginId: string; hash: string },
): Promise<DraftText[]> {
  const [version] = await db
    .select({ files: pluginVersions.files, ownerId: plugins.ownerId })
    .from(pluginVersions)
    .innerJoin(plugins, eq(plugins.id, pluginVersions.pluginId))
    .where(and(eq(pluginVersions.hash, hash), eq(pluginVersions.pluginId, pluginId)));
  if (!version) throw new ContentError('not-found', 'No such version');
  if (!version.files.includes(`${SOURCE}${MANIFEST_FILE}`)) {
    throw invalid(
      'This version has no source to change. Its author can upload the project folder as a draft.',
    );
  }
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const files: DraftText[] = [];
  for (const file of version.files) {
    if (!file.startsWith(SOURCE)) continue;
    const bytes = await store.get(hash, file);
    // Removed meanwhile.
    if (!bytes) throw new ContentError('not-found', 'No such version');
    let text: string;
    try {
      text = decoder.decode(bytes);
    } catch {
      throw invalid(`${file} isn’t a text file, so a draft can’t hold it.`);
    }
    const checked = DraftFile.safeParse({ path: file.slice(SOURCE.length), text });
    if (!checked.success) throw invalid(checked.error.issues[0]?.message ?? `${file} won’t do.`);
    files.push(checked.data);
  }
  if (version.ownerId === accountId) return files;

  const id = await copyId(db, accountId, pluginId);
  return files.map((file) => {
    if (file.path !== MANIFEST_FILE) return file;
    const fields = z.record(z.string(), z.unknown()).safeParse(parseJson(file.text));
    if (!fields.success) throw invalid(`This version’s ${MANIFEST_FILE} isn’t readable.`);
    return { path: file.path, text: `${JSON.stringify({ ...fields.data, id }, null, 2)}\n` };
  });
}

/**
 * Make a draft: empty, from `files`, or from a library version's source.
 * With `MAX_DRAFTS` already, refused with `draft-limit` unless `replaces`
 * names one of the caller's drafts, which goes in the same transaction.
 */
export async function createPluginDraft(
  db: Database,
  store: PluginStore,
  {
    accountId,
    from,
    files = [],
    replaces,
  }: {
    accountId: string;
    from?: { pluginId: string; hash: string } | undefined;
    files?: DraftText[] | undefined;
    replaces?: string | undefined;
  },
) {
  const texts = from ? await sourceOf(db, store, accountId, from) : files;
  listed(texts.map(({ path }) => path));
  const rows = withSizes(texts);
  checkFiles(rows);
  const name = nameFrom(texts.find(({ path }) => path === MANIFEST_FILE)?.text) ?? UNTITLED;

  return db.transaction(async (tx) => {
    // One account's drafts are made one at a time, so two can't both take
    // the last place. `no key update` leaves rows that reference the
    // account free to be written meanwhile.
    await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, accountId))
      .for('no key update');
    if (replaces !== undefined) {
      const gone = await tx
        .delete(pluginDrafts)
        .where(and(eq(pluginDrafts.id, replaces), eq(pluginDrafts.ownerId, accountId)))
        .returning({ id: pluginDrafts.id });
      if (gone.length === 0) throw notFound();
    }
    const [held] = await tx
      .select({ n: count() })
      .from(pluginDrafts)
      .where(eq(pluginDrafts.ownerId, accountId));
    if ((held?.n ?? 0) >= MAX_DRAFTS) {
      throw new ContentError(
        'draft-limit',
        `You have ${MAX_DRAFTS} plugin drafts. Starting another replaces one of them.`,
      );
    }
    const [draft] = await tx
      .insert(pluginDrafts)
      .values({
        ownerId: accountId,
        name,
        fromPluginId: from?.pluginId ?? null,
        fromHash: from?.hash ?? null,
      })
      .returning({ id: pluginDrafts.id });
    if (!draft) throw new Error('plugin draft was not stored');
    if (texts.length > 0) {
      await tx.insert(pluginDraftFiles).values(rows.map((row) => ({ ...row, draftId: draft.id })));
    }
    return summaryOf(tx, { accountId, draftId: draft.id });
  });
}

/**
 * Write `put` and remove `remove` together, or refuse all of it past the
 * limits. Writing the manifest renames the draft from its `name`.
 */
export async function changePluginDraft(
  db: Database,
  { put, remove, ...draft }: Draft & { put: DraftText[]; remove: string[] },
) {
  listed([...put.map(({ path }) => path), ...remove]);
  const rows = withSizes(put);
  return db.transaction(async (tx) => {
    await lockDraft(tx, draft);
    const current = await tx
      .select({ path: pluginDraftFiles.path, size: pluginDraftFiles.size })
      .from(pluginDraftFiles)
      .where(eq(pluginDraftFiles.draftId, draft.draftId));
    const after = new Map(current.map(({ path, size }) => [path, size]));
    for (const path of remove) after.delete(path);
    for (const { path, size } of rows) after.set(path, size);
    checkFiles([...after].map(([path, size]) => ({ path, size })));

    if (remove.length > 0) {
      await tx
        .delete(pluginDraftFiles)
        .where(
          and(eq(pluginDraftFiles.draftId, draft.draftId), inArray(pluginDraftFiles.path, remove)),
        );
    }
    if (put.length > 0) {
      await tx
        .insert(pluginDraftFiles)
        .values(rows.map((row) => ({ ...row, draftId: draft.draftId })))
        .onConflictDoUpdate({
          target: [pluginDraftFiles.draftId, pluginDraftFiles.path],
          set: { text: sql`excluded.text`, size: sql`excluded.size` },
        });
    }
    const name = nameFrom(put.find(({ path }) => path === MANIFEST_FILE)?.text);
    await tx
      .update(pluginDrafts)
      .set({ updatedAt: sql`now()`, ...(name === undefined ? {} : { name }) })
      .where(eq(pluginDrafts.id, draft.draftId));
    return summaryOf(tx, draft);
  });
}

/** Delete a draft with its files and build. */
export async function deletePluginDraft(db: Database, { accountId, draftId }: Draft) {
  const gone = await db
    .delete(pluginDrafts)
    .where(and(eq(pluginDrafts.id, draftId), eq(pluginDrafts.ownerId, accountId)))
    .returning({ id: pluginDrafts.id });
  if (gone.length === 0) throw notFound();
}

/**
 * Replace the draft's build with a built folder, checked as a library
 * upload is (`checkUpload`). Its hash.
 */
export async function putPluginDraftBuild(
  db: Database,
  { files, ...draft }: Draft & { files: { path: string; data: Uint8Array }[] },
) {
  const { byPath, hash } = await checkUpload(files);
  await db.transaction(async (tx) => {
    await lockDraft(tx, draft);
    await tx.delete(pluginDraftBuildFiles).where(eq(pluginDraftBuildFiles.draftId, draft.draftId));
    await tx
      .insert(pluginDraftBuildFiles)
      .values([...byPath].map(([path, data]) => ({ draftId: draft.draftId, path, data })));
    await tx
      .update(pluginDrafts)
      .set({ buildHash: hash })
      .where(eq(pluginDrafts.id, draft.draftId));
  });
  return { hash };
}

/**
 * A file of the caller's own draft build with that hash, if its manifest
 * names `pluginId`: what the file route serves under `draft-<hash>`.
 */
export async function pluginDraftBuildFile(
  db: Database,
  {
    accountId,
    pluginId,
    hash,
    path,
  }: { accountId: string; pluginId: string; hash: string; path: string },
) {
  const rows = await db
    .select({ path: pluginDraftBuildFiles.path, data: pluginDraftBuildFiles.data })
    .from(pluginDraftBuildFiles)
    .innerJoin(pluginDrafts, eq(pluginDrafts.id, pluginDraftBuildFiles.draftId))
    .where(
      and(
        eq(pluginDrafts.ownerId, accountId),
        eq(pluginDrafts.buildHash, hash),
        inArray(pluginDraftBuildFiles.path, [MANIFEST_FILE, path]),
      ),
    );
  const manifest = rows.find((row) => row.path === MANIFEST_FILE);
  const file = rows.find((row) => row.path === path);
  if (!manifest || !file) return null;
  if (manifestFields(new TextDecoder().decode(manifest.data)).id !== pluginId) return null;
  // A copy on its own `ArrayBuffer`, as a response body takes.
  return new Uint8Array(file.data);
}
