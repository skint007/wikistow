import { pluginDraftRoutes } from '@wikistow/contracts';
import {
  changePluginDraft,
  checkPluginDraftOwner,
  createPluginDraft,
  deletePluginDraft,
  listPluginDrafts,
  putPluginDraftBuild,
  readPluginDraft,
  type Database,
  type PluginStore,
} from '@wikistow/server';
import type { EarlyCaller, Routes } from '../http/mount.ts';
import { toApiError } from './content.ts';

// Opening the workshop and the model's file writes, a few a minute.
const LIMIT = { windowSeconds: 60, max: 120 };
// Making one is rare: a new plugin, a version to change, a project folder.
const CREATE_LIMIT = { windowSeconds: 600, max: 30 };
// A draft's 4 MB of text, escaped as JSON.
const CREATE_BODY = 6 * 1024 * 1024;
// A build each time a browser previews one, up to 10 MB in base64.
const BUILD_LIMIT = { windowSeconds: 600, max: 120 };
const BUILD_BODY = 15 * 1024 * 1024;

/**
 * Plugin drafts (ADR 0004, `pluginDraftRoutes`): people only, never
 * agents, each their own drafts. The changes route keeps the app's usual
 * 1 MiB body, so the model's writes never wait for a large-body slot.
 * The library's file route serves the builds (`mountPluginRoutes`).
 */
export function mountPluginDraftRoutes(
  routes: Routes,
  { db, plugins }: { db: Database; plugins: PluginStore },
) {
  // A build's body is read only for the draft's owner. A malformed ID is
  // left to the params check.
  const ownerFirst = async (params: Record<string, string>, { accountId }: EarlyCaller) => {
    const draftId = pluginDraftRoutes.DraftId.safeParse(params['draftId']);
    if (draftId.success) {
      await checkPluginDraftOwner(db, { accountId, draftId: draftId.data }).catch(toApiError);
    }
  };

  routes.account(
    pluginDraftRoutes.listDrafts,
    async (_input, { principal }) => ({ drafts: await listPluginDrafts(db, principal.accountId) }),
    { rateLimit: LIMIT },
  );

  routes.account(
    pluginDraftRoutes.createDraft,
    async ({ body }, { principal }) => ({
      draft: await createPluginDraft(db, plugins, {
        accountId: principal.accountId,
        ...body,
      }).catch(toApiError),
    }),
    { rateLimit: CREATE_LIMIT, bodyLimit: CREATE_BODY },
  );

  routes.account(
    pluginDraftRoutes.getDraft,
    ({ params }, { principal }) =>
      readPluginDraft(db, { accountId: principal.accountId, ...params }).catch(toApiError),
    { rateLimit: LIMIT },
  );

  routes.account(
    pluginDraftRoutes.changeDraft,
    async ({ params, body }, { principal }) => ({
      draft: await changePluginDraft(db, {
        accountId: principal.accountId,
        ...params,
        ...body,
      }).catch(toApiError),
    }),
    { rateLimit: LIMIT },
  );

  routes.account(
    pluginDraftRoutes.deleteDraft,
    async ({ params }, { principal }) => {
      await deletePluginDraft(db, { accountId: principal.accountId, ...params }).catch(toApiError);
      return { ok: true as const };
    },
    { rateLimit: LIMIT },
  );

  routes.account(
    pluginDraftRoutes.putDraftBuild,
    ({ params, body }, { principal }) =>
      putPluginDraftBuild(db, {
        accountId: principal.accountId,
        ...params,
        files: body.files.map(({ path, data }) => ({ path, data: Buffer.from(data, 'base64url') })),
      }).catch(toApiError),
    { rateLimit: BUILD_LIMIT, bodyLimit: BUILD_BODY, beforeBody: ownerFirst },
  );
}
