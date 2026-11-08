import { PluginId } from '@wikistow/plugin-sdk/manifest';
import { z } from 'zod';
import { Timestamp } from '../records/encoding.ts';
import type { RouteDef } from '../route.ts';
import { PluginHash, UploadFile, MAX_VERSION_FILES } from './plugins.ts';

/*
 * Plugin drafts (ADR 0004): the workshop's files, saved on the server as
 * the assistant writes them, so work carries over between devices. Each
 * draft also keeps the one build a browser last previewed, served from the
 * library's file route under `draft-<hash>` to its owner only. People
 * only, never agents; another person's draft answers `not-found`.
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

/** A draft's fonts and images, sorted by path: those `getDraft` leaves out. */
export const getDraftBinaryFiles = {
  method: 'GET',
  path: '/api/plugin-drafts/:draftId/binary-files',
  params: DraftParams,
  response: z.strictObject({ files: z.array(DraftBinaryFile).max(MAX_DRAFT_FILES) }),
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

/** Delete a draft, with its files and build. */
export const deleteDraft = {
  method: 'DELETE',
  path: '/api/plugin-drafts/:draftId',
  params: DraftParams,
  response: z.object({ ok: z.literal(true) }),
} as const satisfies RouteDef;

/**
 * Replace the draft's build with a built folder, every file as a library
 * upload carries them, checked as one. Its files are then served at
 * `draftFileUrl(<manifest ID>, hash, path)` to the draft's owner only.
 */
export const putDraftBuild = {
  method: 'PUT',
  path: '/api/plugin-drafts/:draftId/build',
  params: DraftParams,
  body: z.strictObject({ files: z.array(UploadFile).min(1).max(MAX_VERSION_FILES) }),
  response: z.strictObject({ hash: PluginHash }),
} as const satisfies RouteDef;

/** The file route's key for a draft build: not the bare hash, which an installed copy uses. */
export const draftKey = (hash: string) => `draft-${hash}`;

/** Where a draft build's file is served. Paths are plain (`PluginFile`), so need no encoding. */
export const draftFileUrl = (pluginId: string, hash: string, path: string) =>
  `/plugins/${pluginId}/${draftKey(hash)}/${path}`;
