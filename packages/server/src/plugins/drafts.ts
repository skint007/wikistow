import { pluginDraftRoutes } from '@wikistow/contracts';
import type { Json } from '@wikistow/plugin-sdk';
import { MANIFEST_FILE } from '@wikistow/plugin-sdk/manifest';
import { and, count, desc, eq, inArray, isNotNull, isNull, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { ContentError } from '../content/errors.ts';
import type { Database } from '../db/client.ts';
import {
  identities,
  pluginDraftBuildFiles,
  pluginDraftBuilds,
  pluginDraftFiles,
  pluginDrafts,
  pluginDraftShares,
  pluginDraftWorkshops,
  plugins,
  pluginVersions,
  users,
} from '../db/schema/index.ts';
import { checkUpload, folderNamed } from './library.ts';
import type { PluginStore } from './store.ts';

/*
 * Plugin drafts (ADR 0004): the workshop's files as the assistant last
 * saved them, at most `MAX_DRAFTS` per account, each with the build each
 * person's browser last previewed. Every function takes the caller's
 * account. A draft reaches its owner and the people they shared it with
 * (#315); anyone else's is `not-found`, the same as a missing one.
 */

const {
  DraftBinaryFile,
  DraftFile,
  isBinaryDraftPath,
  MAX_DRAFTS,
  MAX_DRAFT_SHARES,
  MAX_DRAFT_BINARY_FILE_BYTES,
  MAX_DRAFT_BYTES,
  MAX_DRAFT_FILE_BYTES,
  MAX_DRAFT_FILES,
  MAX_DRAFT_WORKSHOP_BYTES,
} = pluginDraftRoutes;

const KB = 1024;
const MB = 1024 * 1024;
const UNTITLED = 'Untitled plugin';
const SOURCE = 'source/';

export type DraftText = { path: string; text: string };
/** A font or image under `public/`, as bytes. */
export type DraftBytes = { path: string; data: Uint8Array };
type Draft = { accountId: string; draftId: string };

const notFound = () => new ContentError('not-found', 'No such plugin draft');

/** Drafts `accountId` reaches: their own, and those shared with them. */
const reaches = (accountId: string) =>
  or(
    eq(pluginDrafts.ownerId, accountId),
    sql`exists (select 1 from ${pluginDraftShares} where ${pluginDraftShares.draftId} = ${pluginDrafts.id} and ${pluginDraftShares.accountId} = ${accountId})`,
  );
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

/** A draft's or proposal's name: its manifest's, else "Untitled plugin". */
export const draftName = (texts: DraftText[]) =>
  nameFrom(texts.find(({ path }) => path === MANIFEST_FILE)?.text) ?? UNTITLED;

/** Refuse a draft's files, all of them as they would be, past the limits. */
export function checkFiles(files: { path: string; size: number }[]) {
  if (files.length > MAX_DRAFT_FILES) {
    throw new ContentError('too-large', `A draft holds ${MAX_DRAFT_FILES} files at most.`);
  }
  for (const { path, size } of files) {
    if (
      isBinaryDraftPath(path) ? size <= MAX_DRAFT_BINARY_FILE_BYTES : size <= MAX_DRAFT_FILE_BYTES
    )
      continue;
    throw new ContentError(
      'too-large',
      isBinaryDraftPath(path)
        ? `${path} is too large: a font or image in a draft is ${MAX_DRAFT_BINARY_FILE_BYTES / MB} MB at most.`
        : `${path} is too large: a draft file holds ${MAX_DRAFT_FILE_BYTES / KB} KB at most.`,
    );
  }
  if (files.reduce((total, { size }) => total + size, 0) > MAX_DRAFT_BYTES) {
    throw new ContentError('too-large', `A draft holds ${MAX_DRAFT_BYTES / MB} MB at most.`);
  }
  const both = folderNamed(files.map(({ path }) => path));
  if (both) throw invalid(`“${both}” is also the name of a folder in the draft.`);
}

/** Files as the draft's rows hold them, with their sizes: a text's in UTF-8, or the bytes'. */
export const rowsOf = (texts: DraftText[], binary: DraftBytes[]) => [
  ...texts.map(({ path, text }) => ({ path, text, data: null, size: Buffer.byteLength(text) })),
  ...binary.map(({ path, data }) => ({ path, text: null, data, size: data.length })),
];

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

/** A draft the caller reaches. */
async function summaryOf(db: Database, { accountId, draftId }: Draft) {
  const [summary] = await summaries(db, and(eq(pluginDrafts.id, draftId), reaches(accountId)));
  if (!summary) throw notFound();
  return summary;
}

/** The draft, locked for this transaction, if the caller reaches it. */
async function lockDraft(tx: Database, { accountId, draftId }: Draft) {
  const [draft] = await tx
    .select({ id: pluginDrafts.id })
    .from(pluginDrafts)
    .where(and(eq(pluginDrafts.id, draftId), reaches(accountId)))
    .for('update');
  if (!draft) throw notFound();
}

/** Whether the caller reaches `draftId`: checked before a large body is read. */
export async function checkPluginDraftAccess(db: Database, draft: Draft) {
  await summaryOf(db, draft);
}

/** The caller's drafts, most recently changed first. */
export const listPluginDrafts = (db: Database, accountId: string) =>
  summaries(db, eq(pluginDrafts.ownerId, accountId));

/** Drafts others shared with the caller, most recently changed first, with their owners' names. */
export async function listSharedPluginDrafts(db: Database, accountId: string) {
  const shared = await db
    .select({ draftId: pluginDraftShares.draftId, owner: users.name })
    .from(pluginDraftShares)
    .innerJoin(pluginDrafts, eq(pluginDrafts.id, pluginDraftShares.draftId))
    .innerJoin(users, eq(users.id, pluginDrafts.ownerId))
    .where(eq(pluginDraftShares.accountId, accountId));
  if (shared.length === 0) return [];
  const owners = new Map(shared.map(({ draftId, owner }) => [draftId, owner]));
  const drafts = await summaries(db, inArray(pluginDrafts.id, [...owners.keys()]));
  return drafts.map((draft) => ({ draft, owner: { name: owners.get(draft.id) ?? '' } }));
}

/** A draft and every text file's text, by path. */
export async function readPluginDraft(db: Database, draft: Draft) {
  const summary = await summaryOf(db, draft);
  const rows = await db
    .select({ path: pluginDraftFiles.path, text: pluginDraftFiles.text })
    .from(pluginDraftFiles)
    .where(and(eq(pluginDraftFiles.draftId, draft.draftId), isNotNull(pluginDraftFiles.text)))
    .orderBy(pluginDraftFiles.path);
  const files = rows.flatMap(({ path, text }) => (text === null ? [] : [{ path, text }]));
  return { draft: summary, files };
}

/** A draft's fonts and images, by path: what `readPluginDraft` leaves out. */
export async function readPluginDraftBinaryFiles(db: Database, draft: Draft) {
  await summaryOf(db, draft);
  const rows = await db
    .select({ path: pluginDraftFiles.path, data: pluginDraftFiles.data })
    .from(pluginDraftFiles)
    .where(and(eq(pluginDraftFiles.draftId, draft.draftId), isNotNull(pluginDraftFiles.data)))
    .orderBy(pluginDraftFiles.path);
  return rows.flatMap(({ path, data }) => (data === null ? [] : [{ path, data }]));
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
    ...drafted.flatMap((row) => manifestFields(row.text ?? undefined).id ?? []),
  ]);
  for (let n = 1; ; n++) {
    const candidate = copyName(id, n);
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * A library version's `source/` files, without the prefix, as a draft's:
 * its text, and its fonts and images under `public/` as bytes. Another
 * account's plugin gets a new ID (`copyId`) in its manifest; the rest of
 * the source is as it was.
 */
export async function sourceOf(
  db: Database,
  store: PluginStore,
  accountId: string,
  { pluginId, hash }: { pluginId: string; hash: string },
): Promise<{ texts: DraftText[]; binary: DraftBytes[] }> {
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
  const binary: DraftBytes[] = [];
  for (const file of version.files) {
    if (!file.startsWith(SOURCE)) continue;
    const bytes = await store.get(hash, file);
    // Removed meanwhile.
    if (!bytes) throw new ContentError('not-found', 'No such version');
    const path = file.slice(SOURCE.length);
    if (isBinaryDraftPath(path)) {
      // Checked by its path only: its bytes are the version's own.
      const checked = DraftBinaryFile.shape.path.safeParse(path);
      if (!checked.success) throw invalid(checked.error.issues[0]?.message ?? `${file} won’t do.`);
      binary.push({ path, data: bytes });
      continue;
    }
    let text: string;
    try {
      text = decoder.decode(bytes);
    } catch {
      throw invalid(`${file} isn’t a text file, so a draft can’t hold it.`);
    }
    const checked = DraftFile.safeParse({ path, text });
    if (!checked.success) throw invalid(checked.error.issues[0]?.message ?? `${file} won’t do.`);
    files.push(checked.data);
  }
  if (version.ownerId === accountId) return { texts: files, binary };

  const id = await copyId(db, accountId, pluginId);
  return { texts: withId(files, id, `This version’s ${MANIFEST_FILE} isn’t readable.`), binary };
}

/**
 * `texts` with the manifest's `id` set to `id`, its JSON written out again,
 * or refused with `unreadable` when the manifest isn't a JSON object.
 */
export function withId(texts: DraftText[], id: string, unreadable: string) {
  return texts.map((file) => {
    if (file.path !== MANIFEST_FILE) return file;
    const fields = z.record(z.string(), z.unknown()).safeParse(parseJson(file.text));
    if (!fields.success) throw invalid(unreadable);
    return { path: file.path, text: `${JSON.stringify({ ...fields.data, id }, null, 2)}\n` };
  });
}

/**
 * Make a draft: empty, from `files` and `binary`, or from a library
 * version's source. With `MAX_DRAFTS` already, refused with `draft-limit`
 * unless `replaces` names one of the caller's drafts, which goes in the
 * same transaction.
 */
export async function createPluginDraft(
  db: Database,
  store: PluginStore,
  {
    accountId,
    from,
    files = [],
    binary = [],
    replaces,
  }: {
    accountId: string;
    from?: { pluginId: string; hash: string } | undefined;
    files?: DraftText[] | undefined;
    binary?: DraftBytes[] | undefined;
    replaces?: string | undefined;
  },
) {
  const { texts, binary: bytes } = from
    ? await sourceOf(db, store, accountId, from)
    : { texts: files, binary };
  return storePluginDraft(db, { accountId, from, texts, binary: bytes, replaces });
}

/**
 * Store a new draft of `texts` and `binary`, within the limits, as
 * `createPluginDraft` does, noting the version it started from. `within`
 * runs first in the same transaction, as opening a proposal deletes it.
 */
export async function storePluginDraft(
  db: Database,
  {
    accountId,
    from,
    texts,
    binary,
    replaces,
    within,
  }: {
    accountId: string;
    from?: { pluginId: string; hash: string } | undefined;
    texts: DraftText[];
    binary: DraftBytes[];
    replaces?: string | undefined;
    within?: (tx: Database) => Promise<void>;
  },
) {
  const rows = rowsOf(texts, binary);
  listed(rows.map(({ path }) => path));
  checkFiles(rows);
  const name = draftName(texts);

  return db.transaction(async (tx) => {
    await within?.(tx);
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
    if (rows.length > 0) {
      await tx.insert(pluginDraftFiles).values(rows.map((row) => ({ ...row, draftId: draft.id })));
    }
    return summaryOf(tx, { accountId, draftId: draft.id });
  });
}

/**
 * Write `put` (text) and `putBinary` (fonts and images) and remove `remove`
 * together, or refuse all of it past the limits. Writing the manifest
 * renames the draft from its `name`.
 */
export async function changePluginDraft(
  db: Database,
  {
    put,
    putBinary = [],
    remove,
    ...draft
  }: Draft & { put: DraftText[]; putBinary?: DraftBytes[]; remove: string[] },
) {
  const rows = rowsOf(put, putBinary);
  listed([...rows.map(({ path }) => path), ...remove]);
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

    const removed = remove.filter((path) => current.some((file) => file.path === path));
    if (removed.length > 0) {
      await tx
        .delete(pluginDraftFiles)
        .where(
          and(eq(pluginDraftFiles.draftId, draft.draftId), inArray(pluginDraftFiles.path, removed)),
        );
    }
    if (rows.length > 0) {
      await tx
        .insert(pluginDraftFiles)
        .values(rows.map((row) => ({ ...row, draftId: draft.draftId })))
        .onConflictDoUpdate({
          target: [pluginDraftFiles.draftId, pluginDraftFiles.path],
          set: { text: sql`excluded.text`, data: sql`excluded.data`, size: sql`excluded.size` },
        });
    }
    // Only a change to its files moves the draft up the list.
    if (removed.length > 0 || rows.length > 0) {
      const name = nameFrom(put.find(({ path }) => path === MANIFEST_FILE)?.text);
      await tx
        .update(pluginDrafts)
        .set({ updatedAt: sql`now()`, ...(name === undefined ? {} : { name }) })
        .where(eq(pluginDrafts.id, draft.draftId));
    }
    return summaryOf(tx, draft);
  });
}

/**
 * The workshop the caller keeps with a draft (#314), as their app sent it,
 * or null, and its revision: their own, whoever else reaches the draft.
 */
export async function readPluginDraftWorkshop(db: Database, draft: Draft) {
  await summaryOf(db, draft);
  const [row] = await db
    .select({ workshop: pluginDraftWorkshops.workshop, revision: pluginDraftWorkshops.revision })
    .from(pluginDraftWorkshops)
    .where(yourWorkshop(draft));
  return {
    workshop: row?.workshop == null ? null : z.json().parse(JSON.parse(row.workshop)),
    revision: row?.revision ?? 0,
  };
}

const yourWorkshop = ({ accountId, draftId }: Draft) =>
  and(eq(pluginDraftWorkshops.draftId, draftId), eq(pluginDraftWorkshops.accountId, accountId));

/**
 * Keep `workshop` with a draft for the caller, or with null forget it,
 * refused past `MAX_DRAFT_WORKSHOP_BYTES`. A save names the `revision` it
 * follows, 0 before the first, and is refused with `stale-head` after
 * another; a clear (`null`) names none. The new revision. The draft stays
 * where it is in the list.
 */
export async function putPluginDraftWorkshop(
  db: Database,
  {
    workshop,
    revision,
    ...draft
  }:
    | (Draft & { workshop: Json; revision: number })
    | (Draft & { workshop: null; revision?: undefined }),
) {
  const text = workshop === null ? null : JSON.stringify(workshop);
  if (text !== null && Buffer.byteLength(text) > MAX_DRAFT_WORKSHOP_BYTES) {
    throw new ContentError(
      'too-large',
      `A draft keeps ${MAX_DRAFT_WORKSHOP_BYTES / KB} KB of its workshop at most.`,
    );
  }
  await summaryOf(db, draft);
  const next = sql`${pluginDraftWorkshops.revision} + 1`;
  const [kept] =
    revision === undefined || revision === 0
      ? // The first save makes the row; a clear, whatever the revision, counts one more.
        await db
          .insert(pluginDraftWorkshops)
          .values({ ...draft, workshop: text, revision: 1 })
          .onConflictDoUpdate({
            target: [pluginDraftWorkshops.draftId, pluginDraftWorkshops.accountId],
            set: { workshop: text, revision: next },
            ...(revision === 0 ? { where: eq(pluginDraftWorkshops.revision, 0) } : {}),
          })
          .returning({ revision: pluginDraftWorkshops.revision })
      : await db
          .update(pluginDraftWorkshops)
          .set({ workshop: text, revision: next })
          .where(and(yourWorkshop(draft), eq(pluginDraftWorkshops.revision, revision)))
          .returning({ revision: pluginDraftWorkshops.revision });
  if (kept) return kept.revision;
  throw new ContentError(
    'stale-head',
    'The workshop was kept from another device since. Open the draft again to carry on from there.',
  );
}

/** Delete one of the caller's own drafts with its files, builds, kept workshops and shares. */
export async function deletePluginDraft(db: Database, { accountId, draftId }: Draft) {
  const gone = await db
    .delete(pluginDrafts)
    .where(and(eq(pluginDrafts.id, draftId), eq(pluginDrafts.ownerId, accountId)))
    .returning({ id: pluginDrafts.id });
  if (gone.length === 0) throw notFound();
}

/**
 * Replace the caller's build of a draft they reach with a built folder,
 * checked as a library upload is (`checkUpload`). Its hash.
 */
export async function putPluginDraftBuild(
  db: Database,
  { files, ...draft }: Draft & { files: { path: string; data: Uint8Array }[] },
) {
  const { byPath, hash } = await checkUpload(files);
  await db.transaction(async (tx) => {
    await lockDraft(tx, draft);
    // Its files go with it.
    await tx
      .delete(pluginDraftBuilds)
      .where(
        and(
          eq(pluginDraftBuilds.draftId, draft.draftId),
          eq(pluginDraftBuilds.accountId, draft.accountId),
        ),
      );
    await tx.insert(pluginDraftBuilds).values({ ...draft, hash });
    await tx
      .insert(pluginDraftBuildFiles)
      .values([...byPath].map(([path, data]) => ({ ...draft, path, data })));
  });
  return { hash };
}

/**
 * A file of the caller's own build of a draft with that hash, if its
 * manifest names `pluginId`: what the file route serves under
 * `draft-<hash>`. Someone a draft is no longer shared with has no build of it.
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
    .innerJoin(
      pluginDraftBuilds,
      and(
        eq(pluginDraftBuilds.draftId, pluginDraftBuildFiles.draftId),
        eq(pluginDraftBuilds.accountId, pluginDraftBuildFiles.accountId),
      ),
    )
    .where(
      and(
        eq(pluginDraftBuilds.accountId, accountId),
        eq(pluginDraftBuilds.hash, hash),
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

/** The account of a person's live identity, or null. */
async function accountOf(db: Database, identityId: string) {
  const [row] = await db
    .select({ accountId: identities.accountId })
    .from(identities)
    .where(
      and(
        eq(identities.id, identityId),
        eq(identities.kind, 'human'),
        isNull(identities.revokedAt),
      ),
    );
  return row?.accountId ?? null;
}

/** One of the caller's own drafts, locked for this transaction. */
async function lockOwn(tx: Database, { accountId, draftId }: Draft) {
  const [draft] = await tx
    .select({ id: pluginDrafts.id })
    .from(pluginDrafts)
    .where(and(eq(pluginDrafts.id, draftId), eq(pluginDrafts.ownerId, accountId)))
    .for('update');
  if (!draft) throw notFound();
}

/** The people a draft is shared with, by name, oldest share first. */
async function sharesOf(db: Database, draftId: string) {
  return db
    .select({ identityId: identities.id, name: users.name })
    .from(pluginDraftShares)
    .innerJoin(users, eq(users.id, pluginDraftShares.accountId))
    .innerJoin(
      identities,
      and(
        eq(identities.accountId, pluginDraftShares.accountId),
        eq(identities.kind, 'human'),
        isNull(identities.revokedAt),
      ),
    )
    .where(eq(pluginDraftShares.draftId, draftId))
    .orderBy(pluginDraftShares.createdAt);
}

/** Whom the caller's own draft is shared with. */
export async function readPluginDraftShares(db: Database, draft: Draft) {
  await lockOwn(db, draft);
  return sharesOf(db, draft.draftId);
}

/**
 * Share the caller's own draft with the person of `identityId`, up to
 * `MAX_DRAFT_SHARES`; again does nothing. Whom it's shared with.
 */
export async function sharePluginDraft(
  db: Database,
  { identityId, ...draft }: Draft & { identityId: string },
) {
  return db.transaction(async (tx) => {
    await lockOwn(tx, draft);
    const person = await accountOf(tx, identityId);
    if (!person) throw new ContentError('not-found', 'No such person');
    if (person === draft.accountId) throw invalid('This draft is yours already.');
    const [held] = await tx
      .select({ n: count() })
      .from(pluginDraftShares)
      .where(eq(pluginDraftShares.draftId, draft.draftId));
    if ((held?.n ?? 0) >= MAX_DRAFT_SHARES) {
      throw invalid(`A draft is shared with ${MAX_DRAFT_SHARES} people at most.`);
    }
    await tx
      .insert(pluginDraftShares)
      .values({ draftId: draft.draftId, accountId: person })
      .onConflictDoNothing();
    return sharesOf(tx, draft.draftId);
  });
}

/**
 * Stop sharing a draft with the person of `identityId`: the owner removes
 * any of them, or the person leaves it themselves. Their build and kept
 * workshop of it go too.
 */
export async function unsharePluginDraft(
  db: Database,
  { identityId, ...draft }: Draft & { identityId: string },
) {
  const person = await accountOf(db, identityId);
  await db.transaction(async (tx) => {
    const [row] = await tx
      .select({ ownerId: pluginDrafts.ownerId })
      .from(pluginDrafts)
      .where(and(eq(pluginDrafts.id, draft.draftId), reaches(draft.accountId)))
      .for('update');
    if (!row || (row.ownerId !== draft.accountId && person !== draft.accountId)) throw notFound();
    // Not shared with someone who isn't a person; the owner's own things stay.
    if (!person || person === row.ownerId) return;
    const { draftId } = draft;
    await tx
      .delete(pluginDraftShares)
      .where(and(eq(pluginDraftShares.draftId, draftId), eq(pluginDraftShares.accountId, person)));
    await tx
      .delete(pluginDraftBuilds)
      .where(and(eq(pluginDraftBuilds.draftId, draftId), eq(pluginDraftBuilds.accountId, person)));
    await tx
      .delete(pluginDraftWorkshops)
      .where(
        and(eq(pluginDraftWorkshops.draftId, draftId), eq(pluginDraftWorkshops.accountId, person)),
      );
  });
}
