import {
  ApiError,
  CryptoError,
  moveOperations,
  pageOperations,
  PageTooLarge,
  revisePayload,
  searchOperations,
  spaceOperations,
  type ClientContext,
  type OpenedPayload,
  type PayloadChanges,
} from '@wikistow/client';
import { FolderId, PageId, RevisionId, SpaceId, structureRoutes } from '@wikistow/contracts';
import type { PluginScope } from '@wikistow/contracts';
import {
  PluginError,
  type FolderEntry,
  type FolderRef,
  type PageAccess,
  type PageChange,
  type PageRef,
  type Pages,
  type PageVersion,
} from '@wikistow/plugin-sdk';
import { leastAccess } from '@wikistow/plugin-sdk/manifest';
import { z } from 'zod';
import { DraftConflict } from '../page/draft-session';
import { vaultStore } from '../vault/store';

/** Writes a plugin may make a minute, which bounds loops between plugins. */
const WRITES_PER_MINUTE = 30;

/** What the page operations need to know about the plugin calling them. */
export type Caller = {
  id: string;
  /** The most the manifest asked for. */
  access: PageAccess;
  /** The person's page access settings for it, read at each call. */
  scopes: () => readonly PluginScope[];
  /** Still loaded: once it isn't, every call fails as `unloaded`. */
  live: () => boolean;
  /** Counts a write against its limit, or throws `rate-limited`. */
  write: () => void;
  /** Told of each draft it saves, so it isn't told of them as events. */
  wrote: (page: PageRef, revision: string) => void;
  /** Told when it changed a space's tree (a folder made, something moved), so the app shows it. */
  changed: (spaceId: string) => void;
};

/** A caller whose saves to a page open in this window's draft view go through its editor. */
export type EditingCaller = Caller & {
  /**
   * Save through the editor if the page is open in this window's draft
   * view, so the person's editor stays current; null if it isn't open.
   */
  open: (page: PageRef, base: string, change: PageChange) => Promise<PageVersion | null>;
};

/** The open session, or `locked`. */
export function session(): ClientContext {
  const vault = vaultStore.get();
  if (vault.status !== 'unlocked') throw new PluginError('locked', 'The vault is locked');
  return vault.ctx;
}

/** A client failure as a plugin is told of it: a code and a short message, no detail. */
export function pluginError(error: unknown): PluginError {
  if (error instanceof PluginError) return error;
  if (error instanceof z.ZodError) return new PluginError('invalid', 'Invalid arguments or ID');
  if (error instanceof PageTooLarge) return new PluginError('too-large', error.message);
  if (error instanceof DraftConflict) return new PluginError('conflict', error.message);
  if (error instanceof ApiError || error instanceof CryptoError) {
    switch (error.code) {
      case 'stale-head':
        return new PluginError('conflict', 'Someone saved this page since that revision');
      case 'not-found':
        return new PluginError('not-found', 'There is no such page or folder');
      case 'forbidden':
      case 'missing-key':
        return new PluginError('forbidden', 'The person can’t do that there');
      case 'unsupported-format':
        return new PluginError('unsupported', error.message);
    }
  }
  return new PluginError('failed', error instanceof Error ? error.message : 'Something went wrong');
}

const namespace = (caller: Pick<Caller, 'id'>) => `plugin.${caller.id}`;

/** A version as a plugin gets it: plain data, its own namespace only. */
function versionOf(
  caller: Pick<Caller, 'id'>,
  info: { spaceId: string; pageId: string; parentId: string | null },
  revision: string,
  version: PageVersion['version'],
  opened: OpenedPayload,
): PageVersion {
  if (opened.kind !== 'current') {
    throw new PluginError('unsupported', 'A newer WikiStow wrote this page');
  }
  const { payload } = opened;
  return {
    spaceId: info.spaceId,
    pageId: info.pageId,
    folderId: info.parentId,
    title: payload.title,
    markdown: payload.markdown,
    revision,
    version,
    data: payload.extensions[namespace(caller)] ?? null,
  };
}

/** The version of a page the person sees: the draft where they edit it, else the publication. */
export async function readPage(caller: Pick<Caller, 'id'>, ctx: ClientContext, ref: PageRef) {
  const pageId = PageId.parse(ref.pageId);
  const info = await pageOperations.loadPage(ctx, pageId);
  if (info.spaceId !== ref.spaceId) throw new PluginError('not-found', 'There is no such page');
  const { draftHead, publishedHead } = info.heads;
  const [version, revision] = draftHead
    ? (['draft', draftHead] as const)
    : (['published', publishedHead] as const);
  if (!revision) throw new PluginError('not-found', 'This page has no version to read');
  const opened = await pageOperations.openRevisionOf(
    ctx,
    { spaceId: info.spaceId, pageId },
    version,
    revision,
  );
  return { info, opened, version: versionOf(caller, info, revision, version, opened.opened) };
}

/** A version named by the page shown: what a command or panel's page handle reads. */
export async function readShown(
  caller: Pick<Caller, 'id'>,
  ctx: ClientContext,
  ref: PageRef,
  shown: { version: PageVersion['version']; revision: string },
): Promise<PageVersion> {
  const pageId = PageId.parse(ref.pageId);
  const info = await pageOperations.loadPage(ctx, pageId);
  const page = { spaceId: info.spaceId, pageId };
  const revision = RevisionId.parse(shown.revision);
  const opened = await pageOperations.openRevisionOf(ctx, page, shown.version, revision);
  return versionOf(caller, info, revision, shown.version, opened.opened);
}

/** `change` as the payload changes it makes, its data in the plugin's own namespace. */
export const payloadChanges = (caller: Pick<Caller, 'id'>, change: PageChange): PayloadChanges => ({
  ...(change.title === undefined ? {} : { title: change.title }),
  ...(change.markdown === undefined ? {} : { markdown: change.markdown }),
  ...(change.data === undefined ? {} : { extensions: { [namespace(caller)]: change.data } }),
});

/** The payload for `change` on top of what was read. */
const revised = (caller: Pick<Caller, 'id'>, opened: OpenedPayload, change: PageChange) =>
  revisePayload(opened, payloadChanges(caller, change));

/**
 * Save `change` as the page's next draft, on top of `base`. A newer draft
 * is a conflict: nothing is merged or retried.
 */
export async function saveOn(
  caller: Pick<Caller, 'id' | 'wrote'>,
  ctx: ClientContext,
  ref: PageRef,
  base: string,
  change: PageChange,
): Promise<PageVersion> {
  const pageId = PageId.parse(ref.pageId);
  const basedOn = RevisionId.parse(base);
  const info = await pageOperations.loadPage(ctx, pageId);
  if (info.spaceId !== ref.spaceId) throw new PluginError('not-found', 'There is no such page');
  if (info.heads.draftHead === null) {
    throw new PluginError('forbidden', 'The person can’t edit this page');
  }
  const page = { spaceId: info.spaceId, pageId };
  const opened = await pageOperations.openRevisionOf(ctx, page, 'draft', basedOn, { fresh: true });
  const payload = revised(caller, opened.opened, change);
  const written = await pageOperations.saveDraft(ctx, {
    page,
    basedOn,
    basedOnRegion: opened.region,
    payload,
  });
  caller.wrote(page, written.revisionId);
  return versionOf(caller, info, written.revisionId, 'draft', {
    kind: 'current',
    payload: written.payload,
  });
}

/** Counts a plugin's writes over the last minute. */
export function writeLimit() {
  const writes: number[] = [];
  return () => {
    const now = Date.now();
    while (writes.length > 0 && (writes[0] ?? 0) <= now - 60_000) writes.shift();
    if (writes.length >= WRITES_PER_MINUTE) {
      throw new PluginError('rate-limited', `At most ${WRITES_PER_MINUTE} writes a minute`);
    }
    writes.push(now);
  };
}

/**
 * The page operations for one plugin. Each call is checked against the
 * plugin's page access, as the person set it now and capped by its
 * manifest, and then runs the operation the app itself uses, so the
 * person's own permissions and the server's checks still apply.
 */
export function pagesFor(caller: EditingCaller): Pages {
  const { write } = caller;

  /** Each node's parent in a space, by IDs alone, listed fresh. */
  const parentsIn = async (ctx: ClientContext, spaceId: SpaceId) => {
    const tree = await ctx.api.call(structureRoutes.tree, { params: { spaceId } });
    return new Map<string, string | null>(
      [...tree.folders, ...tree.pages].map((node) => [node.id, node.parentId]),
    );
  };

  /**
   * The access the plugin has at a node: the most any matching setting
   * gives. `trees` keeps each space's listing for one call that asks often.
   */
  const accessAt = async (
    ctx: ClientContext,
    spaceId: SpaceId,
    nodeId: string | null,
    trees = new Map<SpaceId, ReturnType<typeof parentsIn>>(),
  ): Promise<PageAccess> => {
    const scopes = caller.scopes().filter((scope) => scope.spaceId === spaceId);
    if (scopes.length === 0) return 'none';
    const listing = trees.get(spaceId) ?? parentsIn(ctx, spaceId);
    trees.set(spaceId, listing);
    const parents = await listing;
    if (nodeId !== null && !parents.has(nodeId)) {
      throw new PluginError('not-found', 'There is no such page or folder');
    }
    // The node, then each folder above it.
    const above = new Set<string>();
    for (let id = nodeId; id !== null && !above.has(id); id = parents.get(id) ?? null)
      above.add(id);
    let best: PageAccess = 'none';
    for (const scope of scopes) {
      if (scope.folderId !== null && !above.has(scope.folderId)) continue;
      if (scope.access === 'write' || best === 'none') best = scope.access;
    }
    return leastAccess(best, caller.access);
  };

  const require = async (
    ctx: ClientContext,
    spaceId: SpaceId,
    nodeId: string | null,
    needs: 'read' | 'write',
  ) => {
    const has = await accessAt(ctx, spaceId, nodeId);
    if (has === 'write' || has === needs) return;
    throw new PluginError(
      'not-granted',
      needs === 'write'
        ? 'This plugin may not change pages there'
        : 'This plugin may not read there',
    );
  };

  const folderOf = (ref: FolderRef) => ({
    spaceId: SpaceId.parse(ref.spaceId),
    folderId: ref.folderId === null ? null : FolderId.parse(ref.folderId),
  });

  const guarded =
    <A extends unknown[], R>(run: (ctx: ClientContext, ...args: A) => Promise<R>) =>
    async (...args: A): Promise<R> => {
      const unloaded = new PluginError('unloaded', 'The plugin was turned off');
      if (!caller.live()) throw unloaded;
      let result: R;
      try {
        result = await run(session(), ...args);
      } catch (error) {
        throw pluginError(error);
      }
      // Done after it unloaded: whatever it did stands, but the plugin isn't told.
      if (!caller.live()) throw unloaded;
      return result;
    };

  return {
    read: guarded(async (ctx, ref) => {
      const spaceId = SpaceId.parse(ref.spaceId);
      await require(ctx, spaceId, PageId.parse(ref.pageId), 'read');
      return (await readPage(caller, ctx, ref)).version;
    }),

    list: guarded(async (ctx, ref) => {
      const { spaceId, folderId } = folderOf(ref);
      await require(ctx, spaceId, folderId, 'read');
      const tree = await spaceOperations.loadTree(ctx, spaceId);
      return [
        ...tree.folders
          .filter((folder) => folder.parentId === folderId)
          .map((folder): FolderEntry => ({
            kind: 'folder',
            spaceId,
            folderId: folder.id,
            name: searchOperations.nameOf(folder.metadata),
          })),
        ...tree.pages
          .filter((page) => page.parentId === folderId)
          .map((page): FolderEntry => ({
            kind: 'page',
            spaceId,
            pageId: page.id,
            title: page.title,
          })),
      ];
    }),

    search: guarded(async (ctx, text, options) => {
      // Its settings may name a space the person can no longer open.
      const readable = new Set(await searchOperations.readableSpaces(ctx));
      const spaceIds = [
        ...new Set(caller.scopes().map((scope) => SpaceId.parse(scope.spaceId))),
      ].filter((spaceId) => readable.has(spaceId));
      if (spaceIds.length === 0 || caller.access === 'none') return [];
      const limit = options?.limit ?? 20;
      const index = await searchOperations.indexSpaces(ctx, { spaceIds });
      // Pages outside its folders are left out after ranking, so rank them
      // all: with filters alone, every page ranks the same, by title.
      const hits = index.search(text, { limit: index.size });
      const trees = new Map<SpaceId, ReturnType<typeof parentsIn>>();
      const found = [];
      for (const { doc, title } of hits) {
        // A page gone from the tree since it was indexed is left out.
        const has = await accessAt(ctx, doc.spaceId, doc.pageId, trees).catch((error: unknown) => {
          if (error instanceof PluginError && error.code === 'not-found') return 'none';
          throw error;
        });
        if (has === 'none') continue;
        found.push({
          spaceId: doc.spaceId,
          pageId: doc.pageId,
          title: title.text,
          draft: doc.draft,
        });
        if (found.length >= limit) break;
      }
      return found;
    }),

    create: guarded(async (ctx, ref, { title, markdown = '', data }) => {
      const { spaceId, folderId } = folderOf(ref);
      await require(ctx, spaceId, folderId, 'write');
      write();
      const pageId = await pageOperations.createPage(ctx, {
        spaceId,
        parentId: folderId,
        title,
        markdown,
      });
      const page = { spaceId, pageId };
      const made = await readPage(caller, ctx, page);
      if (data === undefined) {
        caller.wrote(page, made.version.revision);
        return made.version;
      }
      return saveOn(caller, ctx, page, made.version.revision, { data });
    }),

    createFolder: guarded(async (ctx, ref, name) => {
      const { spaceId, folderId } = folderOf(ref);
      await require(ctx, spaceId, folderId, 'write');
      write();
      const made = await spaceOperations.createFolder(ctx, { spaceId, parentId: folderId, name });
      caller.changed(spaceId);
      return { spaceId, folderId: made };
    }),

    saveDraft: guarded(async (ctx, ref, { base, ...change }) => {
      await require(ctx, SpaceId.parse(ref.spaceId), PageId.parse(ref.pageId), 'write');
      write();
      return (await caller.open(ref, base, change)) ?? saveOn(caller, ctx, ref, base, change);
    }),

    move: guarded(async (ctx, node, parent) => {
      const { spaceId, folderId } = folderOf(parent);
      if (node.spaceId !== spaceId) throw new PluginError('invalid', 'Moves stay in one space');
      const nodeId = z.union([PageId, FolderId]).parse(node.id);
      await require(ctx, spaceId, nodeId, 'write');
      await require(ctx, spaceId, folderId, 'write');
      write();
      const preview = await moveOperations.previewMove(ctx, {
        spaceId,
        nodeId,
        parentId: folderId,
      });
      // Who can read would change: the person looks that over in the app.
      if (preview.crossing) {
        throw new PluginError(
          'forbidden',
          'This move would change who can read; move it in the app',
        );
      }
      await moveOperations.moveNode(ctx, { preview });
      caller.changed(spaceId);
    }),
  };
}
