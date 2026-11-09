import { pluginDraftRoutes, pluginProposalRoutes } from '@wikistow/contracts';
import {
  changePluginDraft,
  checkPluginDraftAccess,
  createPluginDraft,
  declinePluginProposal,
  deletePluginDraft,
  listPluginDrafts,
  listPluginProposals,
  listSharedPluginDrafts,
  openPluginProposal,
  proposePluginDraft,
  putPluginDraftBuild,
  readPluginDraft,
  readPluginDraftBinaryFiles,
  readPluginDraftShares,
  readPluginDraftWorkshop,
  putPluginDraftWorkshop,
  readDraftProposal,
  readPluginProposal,
  sharePluginDraft,
  unsharePluginDraft,
  type Database,
  type PluginStore,
} from '@wikistow/server';
import type { EarlyCaller, Routes } from '../http/mount.ts';
import { toApiError } from './content.ts';

// Opening the workshop and the model's file writes, a few a minute.
const LIMIT = { windowSeconds: 60, max: 120 };
// Making one is rare: a new plugin, a version to change, a project folder.
const CREATE_LIMIT = { windowSeconds: 600, max: 30 };
// A draft's 4 MB of text escaped as JSON, or of fonts and images in base64.
const CREATE_BODY = 6 * 1024 * 1024;
// One font or image of at most 1 MB, in base64.
const BINARY_BODY = 2 * 1024 * 1024;

/** A file's base64url as bytes. */
const bytesOf = ({ path, data }: { path: string; data: string }) => ({
  path,
  data: Buffer.from(data, 'base64url'),
});
// The kept workshop, saved a few seconds after each change while the workshop is in use.
const WORKSHOP_LIMIT = { windowSeconds: 60, max: 60 };
// A build each time a browser previews one, up to 10 MB in base64.
const BUILD_LIMIT = { windowSeconds: 600, max: 120 };
const BUILD_BODY = 15 * 1024 * 1024;

/**
 * Plugin drafts (ADR 0004, `pluginDraftRoutes`), and proposals of copies
 * back to their plugins' owners (#315, `pluginProposalRoutes`): people
 * only, never agents, each their own drafts and those shared with them
 * (#315). The changes route keeps the app's usual
 * 1 MiB body, so the model's writes never wait for a large-body slot; a
 * font or image the person adds takes one. The library's file route
 * serves the builds (`mountPluginRoutes`).
 */
export function mountPluginDraftRoutes(
  routes: Routes,
  { db, plugins }: { db: Database; plugins: PluginStore },
) {
  // A build's or binary file's body is read only for someone the draft reaches. A malformed ID
  // is left to the params check.
  const ownerFirst = async (params: Record<string, string>, { accountId }: EarlyCaller) => {
    const draftId = pluginDraftRoutes.DraftId.safeParse(params['draftId']);
    if (draftId.success) {
      await checkPluginDraftAccess(db, { accountId, draftId: draftId.data }).catch(toApiError);
    }
  };

  routes.account(
    pluginDraftRoutes.listDrafts,
    async (_input, { principal }) => ({ drafts: await listPluginDrafts(db, principal.accountId) }),
    { rateLimit: LIMIT },
  );

  routes.account(
    pluginDraftRoutes.createDraft,
    async ({ body: { binary, ...body } }, { principal }) => ({
      draft: await createPluginDraft(db, plugins, {
        accountId: principal.accountId,
        ...body,
        binary: binary?.map(bytesOf),
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
    pluginDraftRoutes.getDraftBinaryFiles,
    async ({ params }, { principal }) => ({
      files: (
        await readPluginDraftBinaryFiles(db, { accountId: principal.accountId, ...params }).catch(
          toApiError,
        )
      ).map(({ path, data }) => ({ path, data: Buffer.from(data).toString('base64url') })),
    }),
    { rateLimit: LIMIT },
  );

  routes.account(
    pluginDraftRoutes.putDraftBinaryFile,
    async ({ params, body }, { principal }) => ({
      draft: await changePluginDraft(db, {
        accountId: principal.accountId,
        ...params,
        put: [],
        putBinary: [bytesOf(body)],
        remove: [],
      }).catch(toApiError),
    }),
    { rateLimit: LIMIT, bodyLimit: BINARY_BODY, beforeBody: ownerFirst },
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
    pluginDraftRoutes.getDraftWorkshop,
    ({ params }, { principal }) =>
      readPluginDraftWorkshop(db, { accountId: principal.accountId, ...params }).catch(toApiError),
    { rateLimit: LIMIT },
  );

  routes.account(
    pluginDraftRoutes.putDraftWorkshop,
    async ({ params, body }, { principal }) => ({
      revision: await putPluginDraftWorkshop(db, {
        accountId: principal.accountId,
        ...params,
        ...body,
      }).catch(toApiError),
    }),
    { rateLimit: WORKSHOP_LIMIT },
  );

  routes.account(
    pluginDraftRoutes.clearDraftWorkshop,
    async ({ params }, { principal }) => {
      await putPluginDraftWorkshop(db, {
        accountId: principal.accountId,
        ...params,
        workshop: null,
      }).catch(toApiError);
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
        files: body.files.map(bytesOf),
      }).catch(toApiError),
    { rateLimit: BUILD_LIMIT, bodyLimit: BUILD_BODY, beforeBody: ownerFirst },
  );

  routes.account(
    pluginDraftRoutes.listSharedDrafts,
    async (_input, { principal }) => ({
      drafts: await listSharedPluginDrafts(db, principal.accountId),
    }),
    { rateLimit: LIMIT },
  );

  routes.account(
    pluginDraftRoutes.getDraftShares,
    async ({ params }, { principal }) => ({
      people: await readPluginDraftShares(db, { accountId: principal.accountId, ...params }).catch(
        toApiError,
      ),
    }),
    { rateLimit: LIMIT },
  );

  routes.account(
    pluginDraftRoutes.shareDraft,
    async ({ params, body }, { principal }) => ({
      people: await sharePluginDraft(db, {
        accountId: principal.accountId,
        ...params,
        ...body,
      }).catch(toApiError),
    }),
    { rateLimit: LIMIT },
  );

  routes.account(
    pluginDraftRoutes.unshareDraft,
    async ({ params }, { principal }) => {
      await unsharePluginDraft(db, { accountId: principal.accountId, ...params }).catch(toApiError);
      return { ok: true as const };
    },
    { rateLimit: LIMIT },
  );

  routes.account(
    pluginProposalRoutes.getDraftProposal,
    ({ params }, { principal }) =>
      readDraftProposal(db, { accountId: principal.accountId, ...params }).catch(toApiError),
    { rateLimit: LIMIT },
  );

  // Sending one is rare, as making a draft is. Its files are read from the draft, not the body.
  routes.account(
    pluginProposalRoutes.proposeDraft,
    async ({ params }, { principal }) => ({
      proposal: await proposePluginDraft(db, { accountId: principal.accountId, ...params }).catch(
        toApiError,
      ),
    }),
    { rateLimit: CREATE_LIMIT },
  );

  routes.account(
    pluginProposalRoutes.listProposals,
    async (_input, { principal }) => ({
      proposals: await listPluginProposals(db, principal.accountId),
    }),
    { rateLimit: LIMIT },
  );

  routes.account(
    pluginProposalRoutes.getProposal,
    ({ params }, { principal }) =>
      readPluginProposal(db, plugins, { accountId: principal.accountId, ...params }).catch(
        toApiError,
      ),
    { rateLimit: LIMIT },
  );

  routes.account(
    pluginProposalRoutes.openProposal,
    async ({ params, body }, { principal }) => ({
      draft: await openPluginProposal(db, {
        accountId: principal.accountId,
        ...params,
        ...body,
      }).catch(toApiError),
    }),
    { rateLimit: CREATE_LIMIT },
  );

  routes.account(
    pluginProposalRoutes.declineProposal,
    async ({ params }, { principal }) => {
      await declinePluginProposal(db, { accountId: principal.accountId, ...params }).catch(
        toApiError,
      );
      return { ok: true as const };
    },
    { rateLimit: LIMIT },
  );
}
