import { Manifest, PluginFile, PluginId } from '@wikistow/plugin-sdk/manifest';
import { z } from 'zod';
import { Timestamp } from '../records/encoding.ts';
import type { RouteDef } from '../route.ts';

/*
 * The plugin library (ADR 0002): built plugins members upload, which
 * signed-in accounts see and may install. Installing is approving a
 * version's hash in the person's own account data; the server keeps no
 * record of who installed what. A plugin is Shared or Only me (ADR 0004).
 */

/** The most one version may hold, in bytes and files. */
export const MAX_VERSION_BYTES = 10 * 1024 * 1024;
export const MAX_VERSION_FILES = 500;
/**
 * A version's `script` at most: Chromium won't start a `data:` worker over
 * 2 MB. The desktop app holds its folder installs and workshop previews to it too.
 */
export const MAX_SCRIPT_BYTES = 1024 * 1024;

/** A version's hash: SHA-256 in hex over its files (`pluginHash` in the SDK). */
export const PluginHash = z.string().regex(/^[0-9a-f]{64}$/);

/**
 * A file's bytes in an upload: unpadded base64url, as `Base64`. Checked
 * without its pattern, whose repeated group overflows the regex stack on a
 * file of several megabytes.
 */
const FileData = z
  .string()
  .regex(/^[A-Za-z0-9_-]*$/)
  .refine((data) => data.length % 4 !== 1, 'Not base64url');

/** A file of an upload: its path in the built folder, and its bytes. */
export const UploadFile = z.strictObject({
  path: PluginFile.max(200),
  data: FileData,
});

/**
 * Why an upload can't carry the file at `path`, naming it as `shown`, or
 * null when it can. Checked before anything is sent, since the server's
 * refusal names only the file's position.
 */
export const uploadPathProblem = (path: string, shown = path) =>
  UploadFile.shape.path.safeParse(path).success
    ? null
    : `${shown} can’t be uploaded: file and folder names in a library plugin use only letters, digits, _, . and -.`;

export const LibraryVersion = z.strictObject({
  hash: PluginHash,
  manifest: Manifest,
  /** Every file's path, sorted. The hash covers them all, not only those the manifest names. */
  files: z.array(PluginFile),
  /** Every file's bytes together. */
  size: z.number().int().nonnegative(),
  uploadedAt: Timestamp,
});
export type LibraryVersion = z.infer<typeof LibraryVersion>;

/**
 * A plugin in the library. Its name, description, trust level and most
 * page access are its newest version's (`versions[0].manifest`).
 */
export const LibraryPlugin = z.strictObject({
  id: PluginId,
  /** The account that uploaded the ID first, which alone ever uploads its versions. */
  owner: z.strictObject({ name: z.string() }),
  /** Whether the caller is the owner. */
  mine: z.boolean(),
  /** Newest first. */
  versions: z.array(LibraryVersion).min(1),
});
export type LibraryPlugin = z.infer<typeof LibraryPlugin>;

/**
 * Who a plugin is listed to: everyone, or (`private`, Only me) its owner
 * and anyone who names one of its versions' hashes in the listing's `have`.
 * Its files are served by hash either way.
 */
export const PluginVisibility = z.enum(['shared', 'private']);
export type PluginVisibility = z.infer<typeof PluginVisibility>;

/** The most hashes one listing's `have` names. */
export const MAX_HAVE = 100;

/** Hashes as `have` carries them: comma-separated. */
export const haveQuery = (hashes: readonly string[]) => hashes.slice(0, MAX_HAVE).join(',');

/**
 * Every plugin in the library the caller may see, by ID: every Shared one,
 * their own, and each Only me one with a version whose hash is in `have`,
 * the hashes the caller approved (`haveQuery`). So a plugin that went Only
 * me stays listed, with its newer versions, for the people who installed it.
 */
export const listPlugins = {
  method: 'GET',
  path: '/api/plugins',
  query: z.object({
    have: z
      .string()
      .max(MAX_HAVE * 65)
      .transform((text) => (text === '' ? [] : text.split(',')))
      .pipe(z.array(PluginHash).max(MAX_HAVE))
      .optional(),
  }),
  response: z.strictObject({ plugins: z.array(LibraryPlugin) }),
} as const satisfies RouteDef;

/**
 * The IDs of the caller's own Only me plugins. Not a field of the listing,
 * which older apps parse strictly.
 */
export const privatePlugins = {
  method: 'GET',
  path: '/api/plugins/private',
  response: z.strictObject({ ids: z.array(PluginId) }),
} as const satisfies RouteDef;

/** Make the caller's plugin Shared or Only me. Its owner only. */
export const setVisibility = {
  method: 'PUT',
  path: '/api/plugins/:pluginId/visibility',
  params: z.object({ pluginId: PluginId }),
  body: z.strictObject({ visibility: PluginVisibility }),
  response: z.object({ ok: z.literal(true) }),
} as const satisfies RouteDef;

/**
 * Upload a built plugin folder, every file in it, as a new version. The
 * server checks it as the desktop checks a folder (`checkPlugin`) and
 * within the limits above. Its manifest's ID is claimed for the caller if
 * nobody has it; otherwise only its owner may upload. Uploading a version
 * the library already has answers it again. `visibility` sets a new ID's
 * (Shared if left out) and changes an existing one's only when given.
 * People only, not agents.
 */
export const uploadPlugin = {
  method: 'POST',
  path: '/api/plugins',
  body: z.strictObject({
    files: z.array(UploadFile).min(1).max(MAX_VERSION_FILES),
    visibility: PluginVisibility.optional(),
  }),
  response: z.strictObject({ pluginId: PluginId, version: LibraryVersion }),
  status: 201,
} as const satisfies RouteDef;

/**
 * Remove a whole plugin, every version and its files. Its owner or an
 * administrator. The ID stays the owner's, who may upload to it again.
 */
export const removePlugin = {
  method: 'DELETE',
  path: '/api/plugins/:pluginId',
  params: z.object({ pluginId: PluginId }),
  response: z.object({ ok: z.literal(true) }),
} as const satisfies RouteDef;

/**
 * Remove one version and its files. Its owner or an administrator. A
 * plugin with no versions left isn't listed; its ID stays the owner's.
 */
export const removeVersion = {
  method: 'DELETE',
  path: '/api/plugins/:pluginId/versions/:hash',
  params: z.object({ pluginId: PluginId, hash: PluginHash }),
  response: z.object({ ok: z.literal(true) }),
} as const satisfies RouteDef;

/**
 * A version's file, for any signed-in session, outside `/api`. Sent with
 * `Content-Security-Policy: default-src 'none'`, `nosniff`, the type from
 * its extension (`fileType` in the SDK), and cached privately for good,
 * since a hash's files never change.
 */
export const FILE_PATH = '/plugins/:pluginId/:hash/*';

/** Where a version's file is served. Paths are plain (`PluginFile`), so need no encoding. */
export const fileUrl = (pluginId: string, hash: string, path: string) =>
  `/plugins/${pluginId}/${hash}/${path}`;
