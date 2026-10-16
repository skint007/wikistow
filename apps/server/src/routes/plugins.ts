import { pluginRoutes } from '@wikistow/contracts';
import { fileType } from '@wikistow/plugin-sdk/files';
import {
  listPlugins,
  pluginDraftBuildFile,
  pluginFile,
  privatePlugins,
  removePlugin,
  setPluginVisibility,
  uploadPlugin,
  type Database,
  type PluginStore,
} from '@wikistow/server';
import { ApiError } from '../http/errors.ts';
import type { Routes } from '../http/mount.ts';
import { toApiError } from './content.ts';

// An upload is the most expensive thing a person does here: reading,
// checking, hashing and writing up to 10 MB. It also takes a large-body
// slot, so one account sends one at a time.
const UPLOAD_LIMIT = { windowSeconds: 600, max: 20 };
// Each version's files in base64, with room for 500 paths around them.
const UPLOAD_BODY = 15 * 1024 * 1024;
const WRITE_LIMIT = { windowSeconds: 60, max: 60 };
const FETCH_LIMIT = { windowSeconds: 60, max: 120 };
// A few plugins' files on each page load, cached for good after that; or
// a desktop fetching every file of the versions it installs (up to 500 each).
const FILE_LIMIT = { windowSeconds: 60, max: 2000 };

const FILE = /^\/plugins\/([^/]+)\/([^/]+)\/(.+)$/;
// A draft build's key (ADR 0004), apart from the installed copy's bare hash.
const DRAFT_KEY = /^draft-([0-9a-f]{64})$/;

/** The plugin library (ADR 0002, `pluginRoutes`): people only, never agents. */
export function mountPluginRoutes(
  routes: Routes,
  { db, plugins }: { db: Database; plugins: PluginStore },
) {
  routes.account(
    pluginRoutes.listPlugins,
    async ({ query }, { principal }) => ({
      plugins: await listPlugins(db, principal.accountId, query.have),
    }),
    { rateLimit: FETCH_LIMIT },
  );

  routes.account(
    pluginRoutes.privatePlugins,
    async (_input, { principal }) => ({ ids: await privatePlugins(db, principal.accountId) }),
    { rateLimit: FETCH_LIMIT },
  );

  routes.account(
    pluginRoutes.setVisibility,
    async ({ params, body }, { principal }) => {
      await setPluginVisibility(db, {
        accountId: principal.accountId,
        pluginId: params.pluginId,
        visibility: body.visibility,
      }).catch(toApiError);
      return { ok: true as const };
    },
    { rateLimit: WRITE_LIMIT },
  );

  routes.account(
    pluginRoutes.uploadPlugin,
    ({ body }, { principal }) =>
      uploadPlugin(db, plugins, {
        accountId: principal.accountId,
        files: body.files.map(({ path, data }) => ({ path, data: Buffer.from(data, 'base64url') })),
        visibility: body.visibility,
      }).catch(toApiError),
    { rateLimit: UPLOAD_LIMIT, bodyLimit: UPLOAD_BODY },
  );

  routes.account(
    pluginRoutes.removePlugin,
    async ({ params }, { principal }) => {
      await removePlugin(db, plugins, {
        accountId: principal.accountId,
        admin: principal.role === 'admin',
        pluginId: params.pluginId,
      }).catch(toApiError);
      return { ok: true as const };
    },
    { rateLimit: WRITE_LIMIT },
  );

  routes.account(
    pluginRoutes.removeVersion,
    async ({ params }, { principal }) => {
      await removePlugin(db, plugins, {
        accountId: principal.accountId,
        admin: principal.role === 'admin',
        ...params,
      }).catch(toApiError);
      return { ok: true as const };
    },
    { rateLimit: WRITE_LIMIT },
  );

  // A library version's file under its hash, or one of the caller's own
  // draft builds' under `draft-<hash>`.
  const fileFor = (accountId: string, pluginId: string, key: string, path: string) => {
    const draft = DRAFT_KEY.exec(key)?.[1];
    if (draft !== undefined) {
      return pluginDraftBuildFile(db, { accountId, pluginId, hash: draft, path });
    }
    return pluginRoutes.PluginHash.safeParse(key).success
      ? pluginFile(db, plugins, { pluginId, hash: key, path })
      : null;
  };

  routes.file(
    pluginRoutes.FILE_PATH,
    async (c, principal) => {
      const [, pluginId = '', key = '', path = ''] = FILE.exec(c.req.path) ?? [];
      const bytes = await fileFor(principal.accountId, pluginId, key, path);
      if (!bytes) throw new ApiError('not-found', 'Not found');
      // A hash's files never change. Its own policy, which the app-wide
      // headers leave in place: whatever the file is, nothing in it runs
      // or loads anything if opened on its own.
      return c.body(bytes, 200, {
        'content-type': fileType(path),
        'content-length': String(bytes.length),
        'content-security-policy': "default-src 'none'",
        'cache-control': 'private, max-age=31536000, immutable',
      });
    },
    { rateLimit: FILE_LIMIT },
  );
}
