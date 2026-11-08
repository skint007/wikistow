import { PluginFile, PluginId } from '@wikistow/plugin-sdk/manifest';
import { z } from 'zod';
import { Timestamp } from '../records/encoding.ts';
import { IdentityId } from '../records/ids.ts';
import type { RouteDef } from '../route.ts';
import { PluginHash, UploadFile, MAX_VERSION_FILES } from './plugins.ts';

/*
 * Plugin drafts (ADR 0004): the workshop's files, saved on the server as
 * the assistant writes them, so work carries over between devices. Each
 * draft also keeps, for each person, the build their browser last
 * previewed, served from the library's file route under `draft-<hash>` to
 * them only. People only, never agents. Its owner may share it with named
 * people (#315), who read and change its files, build it and keep a
 * workshop on it of their own; anyone else's draft answers `not-found`.
 * Only the owner deletes or shares it.
 */

/** The most drafts one account keeps. An 11th needs `replaces`. */
export const MAX_DRAFTS = 10;
/**
 * The most a draft holds: files, bytes of one text file in UTF-8, bytes of
 * one font or image, and bytes in all. A font gets more than a text file:
 * a single weight of a full font is often past 256 KB.
 */
export const MAX_DRAFT_FILES = 200;
export const MAX_DRAFT_FILE_BYTES = 256 * 1024;
export const MAX_DRAFT_BINARY_FILE_BYTES = 1024 * 1024;
export const MAX_DRAFT_BYTES = 4 * 1024 * 1024;

/** The kinds of text file a draft holds: source, styles, data and notes. */
export const DRAFT_FILE_KINDS = [
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.json',
  '.css',
  '.svg',
  '.md',
  '.txt',
];

/**
 * The kinds of binary file a draft holds, under `public/` only: fonts and
 * images, kept as bytes. The person adds them; the model lists and deletes
 * them but can't write them.
 */
export const DRAFT_BINARY_KINDS = ['.woff2', '.woff', '.png', '.jpg', '.webp', '.gif'];

/**
 * Folders and names of letters, digits, `_`, `.` and `-`, each starting
 * with a letter, digit or `_` (so no `..` and no hidden files), at most 64
 * characters, at most five folders deep.
 */
const DRAFT_PATH = /^([A-Za-z0-9_][A-Za-z0-9._-]{0,63}\/){0,5}[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$/;

const kindOf = (path: string) => {
  const dot = path.lastIndexOf('.');
  return dot > path.lastIndexOf('/') ? path.slice(dot).toLowerCase() : '';
};

/** Whether a draft holds the file at `path` as bytes: a font or image (`DRAFT_BINARY_KINDS`). */
export const isBinaryDraftPath = (path: string) => DRAFT_BINARY_KINDS.includes(kindOf(path));

/** Why a draft can't hold a file at `path`, or null when it can. */
export const draftPathProblem = (path: string) =>
  DRAFT_PATH.test(path) &&
  (DRAFT_FILE_KINDS.includes(kindOf(path)) ||
    (isBinaryDraftPath(path) && path.startsWith('public/')))
    ? null
    : `“${path}” isn’t a draft file. Use a relative path such as src/ui.tsx, with no “..”, ending in ${DRAFT_FILE_KINDS.join(', ')}, or for a font or image public/<name> ending in ${DRAFT_BINARY_KINDS.join(', ')}.`;

/** A file's path in a draft (`draftPathProblem`), text or binary. */
export const DraftPath = z.string().superRefine((path, ctx) => {
  const problem = draftPathProblem(path);
  if (problem) ctx.addIssue({ code: 'custom', message: problem });
});

/** A draft's text file and its text. Postgres text holds no NUL. */
export const DraftFile = z.strictObject({
  path: DraftPath.refine(
    (path) => !isBinaryDraftPath(path),
    'A font or image is a binary file: send its bytes',
  ),
  text: z
    .string()
    .max(MAX_DRAFT_FILE_BYTES)
    .refine((text) => !text.includes('\0'), 'A draft file can’t hold a NUL character'),
});
export type DraftFile = z.infer<typeof DraftFile>;

/** A draft's font or image under `public/`, its bytes as an upload carries them. */
export const DraftBinaryFile = z.strictObject({
  path: DraftPath.refine(isBinaryDraftPath, 'Only a font or image is a binary file'),
  data: UploadFile.shape.data,
});
export type DraftBinaryFile = z.infer<typeof DraftBinaryFile>;

export const DraftId = z.uuid();

/** A library version, by its plugin ID and hash. */
const VersionRef = z.strictObject({ pluginId: PluginId, hash: PluginHash });

/**
 * A draft without its files. `name` is its manifest's name as last saved,
 * else "Untitled plugin". `from` is the library version it started from,
 * which may since have been removed. `files` and `size` count its fonts
 * and images too. `updatedAt` moves with its files, not with a build.
 */
export const DraftSummary = z.strictObject({
  id: DraftId,
  name: z.string(),
  from: VersionRef.nullable(),
  files: z.number().int().nonnegative(),
  size: z.number().int().nonnegative(),
  updatedAt: Timestamp,
});
export type DraftSummary = z.infer<typeof DraftSummary>;

const DraftParams = z.object({ draftId: DraftId });

/** The caller's drafts, most recently changed first. */
export const listDrafts = {
  method: 'GET',
  path: '/api/plugin-drafts',
  response: z.strictObject({ drafts: z.array(DraftSummary).max(MAX_DRAFTS) }),
} as const satisfies RouteDef;

/**
 * Make a draft: empty, from `files` and `binary` (its fonts and images),
 * or from a library version's `source/` (`from`), which anyone who may
 * fetch the version may do. A version of another account's plugin gets a
 * new ID of the caller's own, `<id>-copy` or `-copy-<n>`, written into its
 * manifest. With `MAX_DRAFTS` already, it is refused with `draft-limit`
 * unless `replaces` names one of the caller's drafts, which is deleted
 * with it. Send `binary` only with files in it: a server older than it
 * refuses the field.
 */
export const createDraft = {
  method: 'POST',
  path: '/api/plugin-drafts',
  body: z
    .strictObject({
      from: VersionRef.optional(),
      files: z.array(DraftFile).max(MAX_DRAFT_FILES).optional(),
      binary: z.array(DraftBinaryFile).max(MAX_DRAFT_FILES).optional(),
      replaces: DraftId.optional(),
    })
    .refine(
      (body) => !(body.from && (body.files || body.binary)),
      'A draft starts from a version or from files',
    ),
  response: z.strictObject({ draft: DraftSummary }),
  status: 201,
} as const satisfies RouteDef;

/**
 * A draft and every text file's text, sorted by path. Its fonts and images
 * are read with `getDraftBinaryFiles`, so an app older than them reads a
 * draft as before.
 */
export const getDraft = {
  method: 'GET',
  path: '/api/plugin-drafts/:draftId',
  params: DraftParams,
  response: z.strictObject({
    draft: DraftSummary,
    files: z.array(DraftFile).max(MAX_DRAFT_FILES),
  }),
} as const satisfies RouteDef;

/**
 * Write text files and remove files of either kind together, within the
 * limits, or nothing changes. A path is named at most once. Removing a
 * file the draft hasn't got does nothing. Writing `wikistow-plugin.json`
 * renames the draft from its `name`. The body stays within the app's
 * usual 1 MiB.
 */
export const changeDraft = {
  method: 'POST',
  path: '/api/plugin-drafts/:draftId/changes',
  params: DraftParams,
  body: z.strictObject({
    put: z.array(DraftFile).max(MAX_DRAFT_FILES).default([]),
    remove: z.array(DraftPath).max(MAX_DRAFT_FILES).default([]),
  }),
  response: z.strictObject({ draft: DraftSummary }),
} as const satisfies RouteDef;

/**
 * A draft's fonts and images, sorted by path: those `getDraft` leaves out.
 * Each path is read as any plain plugin path, so a kind a later server
 * adds doesn't keep this app from opening the draft.
 */
export const getDraftBinaryFiles = {
  method: 'GET',
  path: '/api/plugin-drafts/:draftId/binary-files',
  params: DraftParams,
  response: z.strictObject({
    files: z
      .array(z.strictObject({ path: PluginFile, data: UploadFile.shape.data }))
      .max(MAX_DRAFT_FILES),
  }),
} as const satisfies RouteDef;

/**
 * Add a font or image to a draft, or replace one, within the limits. Its
 * own route, as a font's base64 can be past the changes route's 1 MiB.
 */
export const putDraftBinaryFile = {
  method: 'POST',
  path: '/api/plugin-drafts/:draftId/binary-files',
  params: DraftParams,
  body: DraftBinaryFile,
  response: z.strictObject({ draft: DraftSummary }),
} as const satisfies RouteDef;

/** Delete one of the caller's own drafts, with its files, builds, kept workshops and shares. */
export const deleteDraft = {
  method: 'DELETE',
  path: '/api/plugin-drafts/:draftId',
  params: DraftParams,
  response: z.object({ ok: z.literal(true) }),
} as const satisfies RouteDef;

/**
 * Replace the caller's build of the draft with a built folder, every file
 * as a library upload carries them, checked as one. Its files are then
 * served at `draftFileUrl(<manifest ID>, hash, path)` to the caller only.
 */
export const putDraftBuild = {
  method: 'PUT',
  path: '/api/plugin-drafts/:draftId/build',
  params: DraftParams,
  body: z.strictObject({ files: z.array(UploadFile).min(1).max(MAX_VERSION_FILES) }),
  response: z.strictObject({ hash: PluginHash }),
} as const satisfies RouteDef;

/**
 * The most a draft's kept workshop holds, as JSON in UTF-8: within the
 * app's usual 1 MiB body, as is everything the model is sent in one request.
 */
export const MAX_DRAFT_WORKSHOP_BYTES = 768 * 1024;

/** Counts each save and clear of a draft's kept workshop, from 0. */
const WorkshopRevision = z.number().int().nonnegative();

/**
 * What the workshop keeps with a draft (#314) for the caller: their
 * conversation, versions and sample pages, plain text like the draft's
 * files. Each person who reaches the draft keeps their own (#315). The app that wrote
 * it reads it; the server only keeps it, within `MAX_DRAFT_WORKSHOP_BYTES`.
 * `workshop` is null when nothing is kept. A save names the `revision` it
 * follows.
 */
export const getDraftWorkshop = {
  method: 'GET',
  path: '/api/plugin-drafts/:draftId/workshop',
  params: DraftParams,
  response: z.strictObject({ workshop: z.json().nullable(), revision: WorkshopRevision }),
} as const satisfies RouteDef;

/**
 * Keep `workshop` with the draft, in place of what was kept, if `revision`
 * is still the latest: else `stale-head`, as when another device kept its
 * own meanwhile. Answers the new revision. It doesn't move `updatedAt`.
 */
export const putDraftWorkshop = {
  method: 'PUT',
  path: '/api/plugin-drafts/:draftId/workshop',
  params: DraftParams,
  body: z.strictObject({ workshop: z.json(), revision: WorkshopRevision }),
  response: z.strictObject({ revision: WorkshopRevision }),
} as const satisfies RouteDef;

/** Forget the draft's kept workshop, for **Clear conversation**, whatever its revision. Its files stay. */
export const clearDraftWorkshop = {
  method: 'DELETE',
  path: '/api/plugin-drafts/:draftId/workshop',
  params: DraftParams,
  response: z.object({ ok: z.literal(true) }),
} as const satisfies RouteDef;

/** The most people one draft is shared with. */
export const MAX_DRAFT_SHARES = 20;

/** Someone a draft is shared with: their person's identity, and their name on the server. */
export const DraftPerson = z.strictObject({ identityId: IdentityId, name: z.string() });
export type DraftPerson = z.infer<typeof DraftPerson>;

/**
 * Drafts other people shared with the caller (#315), most recently changed
 * first, each with its owner's name. Its own route: `listDrafts` keeps to
 * the caller's own, which older apps offer to delete.
 */
export const listSharedDrafts = {
  method: 'GET',
  path: '/api/shared-plugin-drafts',
  response: z.strictObject({
    drafts: z.array(
      z.strictObject({ draft: DraftSummary, owner: z.strictObject({ name: z.string() }) }),
    ),
  }),
} as const satisfies RouteDef;

/** Whom the caller's own draft is shared with, by name. */
export const getDraftShares = {
  method: 'GET',
  path: '/api/plugin-drafts/:draftId/shares',
  params: DraftParams,
  response: z.strictObject({ people: z.array(DraftPerson).max(MAX_DRAFT_SHARES) }),
} as const satisfies RouteDef;

/**
 * Share the caller's own draft with a person, named by the identity the
 * people picker lists (`GET /api/people`), up to `MAX_DRAFT_SHARES`.
 * Sharing again does nothing. Not with themselves, nor an agent.
 */
export const shareDraft = {
  method: 'POST',
  path: '/api/plugin-drafts/:draftId/shares',
  params: DraftParams,
  body: z.strictObject({ identityId: IdentityId }),
  response: z.strictObject({ people: z.array(DraftPerson).max(MAX_DRAFT_SHARES) }),
} as const satisfies RouteDef;

/**
 * Stop sharing a draft with a person: its owner stops sharing with anyone,
 * and a person it's shared with leaves it. Their build and kept workshop
 * of it go too.
 */
export const unshareDraft = {
  method: 'DELETE',
  path: '/api/plugin-drafts/:draftId/shares/:identityId',
  params: z.object({ draftId: DraftId, identityId: IdentityId }),
  response: z.object({ ok: z.literal(true) }),
} as const satisfies RouteDef;

/** The file route's key for a draft build: not the bare hash, which an installed copy uses. */
export const draftKey = (hash: string) => `draft-${hash}`;

/** Where a draft build's file is served. Paths are plain (`PluginFile`), so need no encoding. */
export const draftFileUrl = (pluginId: string, hash: string, path: string) =>
  `/plugins/${pluginId}/${draftKey(hash)}/${path}`;
