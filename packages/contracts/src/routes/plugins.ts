import { Manifest, PluginFile, PluginId } from '@wikistow/plugin-sdk/manifest';
import { z } from 'zod';
import { Timestamp } from '../records/encoding.ts';
import type { RouteDef } from '../route.ts';

/*
 * The plugin library (ADR 0002): built plugins members upload, which every
 * signed-in account sees and may install. Installing is approving a
 * version's hash in the person's own account data; the server keeps no
 * record of who installed what.
 */

/** The most one version may hold, in bytes and files. */
export const MAX_VERSION_BYTES = 10 * 1024 * 1024;
export const MAX_VERSION_FILES = 500;
/** A version's `script` at most: Chromium won't start a `data:` worker over 2 MB. */
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

export const LibraryVersion = z.strictObject({
  hash: PluginHash,
  manifest: Manifest,
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
  /** The account that uploaded the ID first, which alone uploads its versions. */
  owner: z.strictObject({ name: z.string() }),
  /** Whether the caller is the owner. */
  mine: z.boolean(),
  /** Newest first. */
  versions: z.array(LibraryVersion).min(1),
});
export type LibraryPlugin = z.infer<typeof LibraryPlugin>;

/** Every plugin in the library, by ID. */
export const listPlugins = {
  method: 'GET',
  path: '/api/plugins',
  response: z.strictObject({ plugins: z.array(LibraryPlugin) }),
} as const satisfies RouteDef;

/**
 * Upload a built plugin folder, every file in it, as a new version. The
 * server checks it as the desktop checks a folder (`checkPlugin`) and
 * within the limits above. Its manifest's ID is claimed for the caller if
 * nobody has it; otherwise only its owner may upload. Uploading a version
 * the library already has answers it again. People only, not agents.
 */
export const uploadPlugin = {
  method: 'POST',
  path: '/api/plugins',
  body: z.strictObject({ files: z.array(UploadFile).min(1).max(MAX_VERSION_FILES) }),
  response: z.strictObject({ pluginId: PluginId, version: LibraryVersion }),
  status: 201,
} as const satisfies RouteDef;

/** Remove a whole plugin, every version's files with it. Its owner or an administrator. */
export const removePlugin = {
  method: 'DELETE',
  path: '/api/plugins/:pluginId',
  params: z.object({ pluginId: PluginId }),
  response: z.object({ ok: z.literal(true) }),
} as const satisfies RouteDef;

/**
 * Remove one version and its files. Its owner or an administrator. The
 * plugin goes with its last version, and its ID is free again.
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
