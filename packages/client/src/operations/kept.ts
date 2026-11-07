// Pages kept on the device for offline use (ADR 0009, decisions 1 to 3):
// what is kept, how it is read back, and the keeper that keeps it current.
import {
  FolderId,
  MetadataRevisionId,
  PageId,
  PublicIdentity,
  RevisionId,
  RevisionRecord,
  RevisionRecordV2,
  Share,
  SpaceId,
  pageRoutes,
  sharingRoutes,
  structureRoutes,
  type Audience,
} from '@wikistow/contracts';
import { z } from 'zod';
import { decodeUtf8, utf8 } from '../encoding.ts';
import { CryptoError } from '../errors.ts';
import { parseMetadata } from '../metadata.ts';
import { Format, parsePayload, type PagePayload } from '../payload.ts';
import { RegionJson } from '../regions.ts';
import { keptSealer, type KeptSealer, type KeptStore } from '../kept-store.ts';
import type { PrivateIdentity } from '../identity.ts';
import type { InstallationId } from '../ids.ts';
import { fetchRevisions, pageLabels, type PageRef, type Wanted } from './pages.ts';
import { OfflineQueue } from './queue.ts';
import { sharedWithMe, type SharedItem } from './sharing.ts';
import type { LoadedMetadata, OpenedRevision } from './records.ts';
import { unreachable } from './search.ts';
import type { ClientContext } from './session.ts';
import { loadSpaceOrder, loadSpaces, loadStructure, type loadTree } from './spaces.ts';

/** A space's tree as last listed: its folders' names and looks, and its pages' heads, no titles. */
export type KeptTree = Awaited<ReturnType<typeof loadStructure>>;

/** The spaces this person holds, with their names, their order, and Shared with me, as last listed. */
export type KeptSpaceList = {
  spaces: Awaited<ReturnType<typeof loadSpaces>>;
  order: Awaited<ReturnType<typeof loadSpaceOrder>>;
  shared: SharedItem[];
};

/**
 * A kept version of a page: which, the blob hashes of every attachment it
 * lists (`files`) and of its images (`images`), and those whose blobs are
 * kept (`blobs`): its images, once downloaded, and other files once opened
 * on the device.
 */
export type KeptVersion = { id: RevisionId; files: string[]; images: string[]; blobs: string[] };

/**
 * A page kept on the device: whether it was opened here (what **Pages I
 * open** keeps), and its kept versions, the published one and, for an
 * editor, the draft.
 */
export type KeptPage = { pageId: PageId; opened: boolean; versions: KeptVersion[] };

/** What the device keeps of one space: its tree, when it was listed, and its kept pages. */
export type KeptSpace = {
  listedAt: string;
  tree: KeptTree;
  pages: ReadonlyMap<PageId, KeptPage>;
};

/** Which pages are kept: every page this person can see, or those opened on the device. */
export type KeepScope = 'every' | 'opened';

export type KeepProgress = { pages: number; total: number };

// The formats items are kept in, read back as checked here. Sealed by this
// person's key, so a bad item is one damaged or from an older format, and is
// read as nothing kept.

const KeptRegion = RegionJson;

const KeptMetadata = z
  .strictObject({
    head: MetadataRevisionId,
    opened: z.discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('current'), metadata: z.unknown() }),
      z.strictObject({ kind: z.literal('newer-format'), format: Format }),
    ]),
    region: KeptRegion,
  })
  .transform(({ head, opened, region }): LoadedMetadata => ({
    head,
    // Throws on a shape it doesn't know, which reads the item as nothing kept.
    opened: opened.kind === 'current' ? parseMetadata(opened.metadata) : opened,
    region,
  }));

const KeptTreeJson = z.strictObject({
  space: z
    .strictObject({
      id: SpaceId,
      role: structureRoutes.AccessRole,
      canPublish: z.boolean(),
      permissionVersion: z.number().int(),
      metadata: KeptMetadata.nullable(),
    })
    .nullable(),
  shares: z.array(structureRoutes.ShareSummary),
  folders: z.array(
    z.strictObject({
      id: FolderId,
      parentId: FolderId.nullable(),
      permissionVersion: z.number().int(),
      metadata: KeptMetadata.nullable(),
    }),
  ),
  pages: z.array(structureRoutes.PageSummary),
  agentActivity: structureRoutes.tree.response.shape.agentActivity,
}) satisfies z.ZodType<KeptTree, unknown>;

const KeptSpaceJson = z.strictObject({
  listedAt: z.iso.datetime(),
  tree: KeptTreeJson,
  pages: z.array(
    z.strictObject({
      pageId: PageId,
      opened: z.boolean(),
      versions: z.array(
        z.strictObject({
          id: RevisionId,
          files: z.array(z.string()),
          images: z.array(z.string()),
          blobs: z.array(z.string()),
        }),
      ),
    }),
  ),
});

const KeptSpaceListJson = z.strictObject({
  spaces: z.array(
    z.strictObject({
      id: SpaceId,
      kind: z.enum(['personal', 'shared']),
      role: structureRoutes.AccessRole,
      canPublish: z.boolean(),
      permissionVersion: z.number().int(),
      metadata: KeptMetadata.nullable(),
    }),
  ),
  order: structureRoutes.spaceOrder.response,
  shared: z.array(
    z.strictObject({
      share: Share,
      role: sharingRoutes.ShareRole,
      canPublish: z.boolean(),
      folderId: FolderId.nullable(),
      root: KeptMetadata.nullable(),
      sharedBy: z
        .strictObject({ identity: PublicIdentity, label: z.string().nullable() })
        .nullable(),
    }),
  ),
}) satisfies z.ZodType<KeptSpaceList, unknown>;

/** The index item: the spaces kept, and the list as last loaded. */
const KeptIndexJson = z.strictObject({
  spaces: z.array(SpaceId),
  list: KeptSpaceListJson.nullable(),
});

const KeptVersionJson = z.strictObject({
  record: z.union([RevisionRecord, RevisionRecordV2]),
  // A kept version is always one this app could read (`parsePayload`).
  payload: z.unknown(),
  region: KeptRegion,
  keyVersion: z.number().int().nullable(),
});

/** How much the reader's downloads for pages not kept yet may hold, at most. */
const RECENT_BYTES = 32 * 1024 * 1024;

const INDEX = 'index';
const spaceItem = (spaceId: SpaceId) => `space ${spaceId}`;
const versionItem = (revisionId: RevisionId) => `version ${revisionId}`;
const blobItem = (blobHash: string) => `blob ${blobHash}`;

/** Each attachment's blob hash that the version lists, and those of its images. */
function filesOf(payload: PagePayload) {
  return {
    files: payload.attachments.map((ref) => ref.blobHash),
    images: payload.attachments
      .filter((ref) => ref.mediaType.startsWith('image/'))
      .map((ref) => ref.blobHash),
  };
}

/**
 * What this device keeps for offline use, for one session (`ctx.keptContent`):
 * pages' versions, the images they show, trees and the space list, each its
 * own item in `store`, sealed for this person on this server (`keptSealer`).
 * It holds the index of what's kept in memory, as last read or written, so
 * reads for something not kept never reach the store. Another tab may change
 * the store meanwhile; reading what it let go gives nothing, so the caller
 * goes to the server, and the keeper reads the index again before each run.
 * Stops writing once the session ends (`close`). Its `queue` holds the
 * changes made offline, sealed the same way.
 */
export class KeptContent {
  readonly store: KeptStore;
  readonly queue: OfflineQueue;
  readonly #sealer: KeptSealer;
  #spaces = new Map<SpaceId, KeptSpace>();
  #list: KeptSpaceList | null = null;
  // Every kept version, by the page that keeps it, and every kept blob.
  #versions = new Map<RevisionId, { spaceId: SpaceId; pageId: PageId }>();
  #blobs = new Set<string>();
  // Blobs the reader downloaded for a page not kept yet, for the keeper
  // about to keep it, so they aren't downloaded twice. Memory only.
  #recent = new Map<string, Uint8Array>();
  #recentBytes = 0;
  #closed = false;

  private constructor(store: KeptStore, sealer: KeptSealer, installationId: InstallationId) {
    this.store = store;
    this.#sealer = sealer;
    this.queue = new OfflineQueue(store, sealer, installationId);
  }

  /** What `store` keeps for this person on this server. Nothing readable counts as nothing kept. */
  static async open(
    store: KeptStore,
    who: { identity: PrivateIdentity; installationId: InstallationId },
  ): Promise<KeptContent> {
    const kept = new KeptContent(store, keptSealer(who), who.installationId);
    await kept.reload();
    return kept;
  }

  /** Read the index of what's kept again, as another tab may have changed it. */
  async reload(): Promise<void> {
    const index = await this.#readJson(INDEX, KeptIndexJson);
    const spaces = new Map<SpaceId, KeptSpace>();
    for (const spaceId of index?.spaces ?? []) {
      const json = await this.#readJson(spaceItem(spaceId), KeptSpaceJson);
      if (!json) continue;
      const pages = new Map(json.pages.map((page) => [page.pageId, page]));
      spaces.set(spaceId, { listedAt: json.listedAt, tree: json.tree, pages });
    }
    this.#list = index?.list ?? null;
    this.#spaces = spaces;
    this.#reindex();
  }

  /** The spaces kept. */
  spaceIds(): SpaceId[] {
    return [...this.#spaces.keys()];
  }

  /** What's kept of `spaceId`: its tree as last listed, and its kept pages. */
  space(spaceId: SpaceId): KeptSpace | undefined {
    return this.#spaces.get(spaceId);
  }

  /** The space list and order as last loaded, or null. */
  spaceList(): KeptSpaceList | null {
    return this.#list;
  }

  /** The page as kept, or undefined if it isn't. */
  page(spaceId: SpaceId, pageId: PageId): KeptPage | undefined {
    return this.#spaces.get(spaceId)?.pages.get(pageId);
  }

  /** How many pages are kept, and how many bytes everything kept takes. */
  async usage(): Promise<{ pages: number; bytes: number }> {
    let pages = 0;
    for (const space of this.#spaces.values()) {
      for (const page of space.pages.values()) if (page.versions.length > 0) pages += 1;
    }
    const items = await this.store.items.list();
    return { pages, bytes: items.reduce((sum, item) => sum + item.size, 0) };
  }

  /** Whether `revisionId` is kept. */
  hasVersion(revisionId: RevisionId): boolean {
    return this.#versions.has(revisionId);
  }

  /**
   * The pages of `tree` whose version this person sees is kept: what
   * offline shows of the space (ADR 0009, decision 4). The draft for an
   * editor, else the publication.
   */
  shownPages(tree: KeptTree): KeptTree['pages'] {
    return tree.pages.filter((page) => {
      const head = page.draftHead ?? page.publishedHead;
      return head !== null && this.hasVersion(head);
    });
  }

  /**
   * A kept version, opened, if it is the one wanted: of that space, page and
   * audience. Its region and key version are as it was last opened, so a
   * write still opens its base fresh. Undefined if it isn't kept.
   */
  async version(wanted: {
    spaceId: SpaceId;
    pageId: PageId;
    audience: Audience;
    revisionId: RevisionId;
  }): Promise<OpenedRevision | undefined> {
    const keeping = this.#versions.get(wanted.revisionId);
    if (keeping?.spaceId !== wanted.spaceId || keeping.pageId !== wanted.pageId) return;
    const json = await this.#readJson(versionItem(wanted.revisionId), KeptVersionJson);
    if (!json) return;
    const { record } = json;
    if (
      record.revisionId !== wanted.revisionId ||
      record.spaceId !== wanted.spaceId ||
      record.pageId !== wanted.pageId ||
      record.audience !== wanted.audience
    )
      return;
    try {
      const opened = parsePayload(json.payload);
      if (opened.kind !== 'current') return;
      return { record, opened, region: json.region, keyVersion: json.keyVersion };
    } catch {
      return;
    }
  }

  /** A blob the reader just downloaded for a page not kept then, once. */
  takeOpened(blobHash: string): Uint8Array | undefined {
    const blob = this.#recent.get(blobHash);
    if (!blob) return;
    this.#recent.delete(blobHash);
    this.#recentBytes -= blob.length;
    return blob;
  }

  #remember(blobHash: string, blob: Uint8Array) {
    if (this.#closed || this.#recent.has(blobHash) || blob.length > RECENT_BYTES) return;
    this.#recent.set(blobHash, blob);
    this.#recentBytes += blob.length;
    for (const [oldest, kept] of this.#recent) {
      if (this.#recentBytes <= RECENT_BYTES) break;
      this.#recent.delete(oldest);
      this.#recentBytes -= kept.length;
    }
  }

  hasBlob(blobHash: string): boolean {
    return this.#blobs.has(blobHash);
  }

  /**
   * A kept attachment's blob, as the server served it, or one added offline
   * that waits in the queue, or null if neither holds it.
   */
  async blob(blobHash: string): Promise<Uint8Array | null> {
    if (!this.#blobs.has(blobHash)) return this.queue.blob(blobHash);
    return this.#readBytes(blobItem(blobHash));
  }

  /**
   * After an attachment of `page` was downloaded: keep its blob with each
   * kept version listing it (decision 1: other files are kept once opened).
   */
  async attachmentOpened(page: PageRef, blobHash: string, blob: Uint8Array): Promise<void> {
    const lacking = (versions: readonly KeptVersion[] | undefined) =>
      versions?.some((v) => v.files.includes(blobHash) && !v.blobs.includes(blobHash));
    const before = this.page(page.spaceId, page.pageId);
    // A page, or a version, about to be kept: the keeper takes it from here (`takeOpened`).
    if (!before?.versions.some((v) => v.files.includes(blobHash))) {
      return this.#remember(blobHash, blob);
    }
    // Most reads are of a blob kept already.
    if (!lacking(before.versions)) return;
    await this.store.exclusive(async () => {
      // As another tab may have kept more of the space meanwhile.
      await this.reload();
      const space = this.#spaces.get(page.spaceId);
      const kept = space?.pages.get(page.pageId);
      if (!space || !kept) return;
      const listing = kept.versions.filter(
        (version) => version.files.includes(blobHash) && !version.blobs.includes(blobHash),
      );
      if (listing.length === 0) return;
      if (!this.#blobs.has(blobHash)) await this.#writeBytes(blobItem(blobHash), blob);
      const versions = kept.versions.map((version) =>
        listing.includes(version) ? { ...version, blobs: [...version.blobs, blobHash] } : version,
      );
      const pages = new Map(space.pages).set(page.pageId, { ...kept, versions });
      await this.keepSpace(page.spaceId, { ...space, pages });
    });
  }

  /**
   * Mark a kept page as opened on the device, so **Pages I open** keeps it.
   * False if it isn't kept, for the keeper to keep it.
   */
  async markOpened(page: PageRef): Promise<boolean> {
    return this.store.exclusive(async () => {
      await this.reload();
      const space = this.#spaces.get(page.spaceId);
      const kept = space?.pages.get(page.pageId);
      if (!space || !kept) return false;
      if (kept.opened) return true;
      const pages = new Map(space.pages).set(page.pageId, { ...kept, opened: true });
      await this.keepSpace(page.spaceId, { ...space, pages });
      return true;
    });
  }

  // What the keeper writes, from within `store.exclusive`.

  async keepVersion(opened: OpenedRevision & { opened: { kind: 'current' } }): Promise<void> {
    const { record, region, keyVersion } = opened;
    const json = { record, payload: opened.opened.payload, region, keyVersion };
    await this.#writeBytes(versionItem(record.revisionId), utf8(JSON.stringify(json)));
  }

  /**
   * After a kept version was opened again from the server (`fresh`): keep
   * it with the region and key version it opened with now, as after a move
   * or share, so later sessions read those from here.
   */
  async refreshVersion(opened: OpenedRevision): Promise<void> {
    if (!this.hasVersion(opened.record.revisionId) || opened.opened.kind !== 'current') return;
    await this.keepVersion({ ...opened, opened: opened.opened });
  }

  async keepBlob(blobHash: string, blob: Uint8Array): Promise<void> {
    await this.#writeBytes(blobItem(blobHash), blob);
    this.#blobs.add(blobHash);
  }

  /** Keep `space` as what's kept of `spaceId`, its versions and blobs written first. */
  async keepSpace(spaceId: SpaceId, space: KeptSpace): Promise<void> {
    const json = { listedAt: space.listedAt, tree: space.tree, pages: [...space.pages.values()] };
    await this.#writeBytes(spaceItem(spaceId), utf8(JSON.stringify(json)));
    const known = this.#spaces.has(spaceId);
    this.#spaces.set(spaceId, space);
    this.#reindex();
    if (!known) await this.#writeIndex();
  }

  /** Let go of a space whole: its versions and blobs go at the next `collect`. */
  async dropSpace(spaceId: SpaceId): Promise<void> {
    if (!this.#spaces.delete(spaceId)) return;
    this.#reindex();
    await this.#writeIndex();
  }

  async keepList(list: KeptSpaceList): Promise<void> {
    this.#list = list;
    await this.#writeIndex();
  }

  /**
   * Delete every item the index no longer names: versions and blobs let go
   * of, items another run wrote and never named, a space dropped.
   */
  async collect(): Promise<void> {
    if (this.#closed) return;
    const name = (what: string) => this.#sealer.name(what);
    const named = new Set([name(INDEX)]);
    for (const spaceId of this.#spaces.keys()) named.add(name(spaceItem(spaceId)));
    for (const revisionId of this.#versions.keys()) named.add(name(versionItem(revisionId)));
    for (const blobHash of this.#blobs) named.add(name(blobItem(blobHash)));
    const unnamed = (await this.store.items.list())
      .map((item) => item.name)
      .filter((item) => !named.has(item));
    if (unnamed.length > 0 && !this.#closed) await this.store.items.remove(unnamed);
  }

  /** Stop writing: the session ended. What's kept stays, sealed. */
  close(): void {
    this.#closed = true;
    this.queue.close();
    this.#recent.clear();
    this.#recentBytes = 0;
  }

  get closed(): boolean {
    return this.#closed;
  }

  #reindex() {
    this.#versions.clear();
    this.#blobs.clear();
    for (const [spaceId, space] of this.#spaces) {
      for (const page of space.pages.values()) {
        for (const version of page.versions) {
          this.#versions.set(version.id, { spaceId, pageId: page.pageId });
          for (const blob of version.blobs) this.#blobs.add(blob);
        }
      }
    }
  }

  async #writeIndex() {
    const json = { spaces: [...this.#spaces.keys()], list: this.#list };
    await this.#writeBytes(INDEX, utf8(JSON.stringify(json)));
  }

  async #writeBytes(what: string, plaintext: Uint8Array) {
    if (this.#closed) return;
    const name = this.#sealer.name(what);
    await this.store.items.write(name, this.#sealer.seal(name, plaintext));
  }

  async #readBytes(what: string): Promise<Uint8Array | null> {
    const name = this.#sealer.name(what);
    const sealed = await this.store.items.read(name).catch(() => null);
    return sealed && this.#sealer.open(name, sealed);
  }

  async #readJson<T>(what: string, schema: z.ZodType<T, unknown>): Promise<T | null> {
    const plaintext = await this.#readBytes(what);
    if (!plaintext) return null;
    try {
      return schema.parse(JSON.parse(decodeUtf8(plaintext, 'kept item')));
    } catch {
      return null;
    }
  }
}

/** The vault locked, access changed, or the caller gave up while keeping. What was kept stays. */
export class KeepingStopped extends Error {
  constructor() {
    super('Keeping stopped');
    this.name = 'KeepingStopped';
  }
}

/** Where the keeper gets what it keeps: the server, through the operations (`serverSource`), or a test's fake. */
export type KeeperSource = {
  /** The space list and order, and every space this person holds or has a share in. */
  spaces(): Promise<{ list: KeptSpaceList; ids: SpaceId[] }>;
  /** A space's tree, or null when it is gone, closed to this person, or fails its checks. */
  tree(spaceId: SpaceId): Promise<KeptTree | null>;
  /** The versions `wanted`, opened, as `fetchRevisions` opens them; absent or throwing for one that doesn't open. */
  versions(
    spaceId: SpaceId,
    wanted: ReadonlyMap<RevisionId, Wanted>,
  ): Promise<Map<RevisionId, () => OpenedRevision>>;
  /** An attachment's blob, as the server serves it. */
  blob(blobHash: string): Promise<Uint8Array>;
};

/** What the keeper keeps, from the server. */
export function serverSource(ctx: ClientContext): KeeperSource {
  return {
    async spaces() {
      const [spaces, order, opened] = await Promise.all([
        loadSpaces(ctx),
        loadSpaceOrder(ctx),
        // Shared with me as its page shows it, or null if it fails.
        // With the session's space keys, not worked out afresh at every run.
        sharedWithMe(ctx, { refresh: false }).catch(() => null),
      ]);
      // One shared space failing its checks there mustn't stop the keeping:
      // the list kept before stays, and the shared spaces come from the route.
      const shared = opened ?? ctx.keptContent?.spaceList()?.shared ?? [];
      const sharedIn = opened
        ? opened.map((item) => item.share.spaceId)
        : (await ctx.api.call(sharingRoutes.sharedWithMe)).shares.map((s) => s.share.spaceId);
      const ids = new Set([...spaces.map((s) => s.id), ...sharedIn]);
      return { list: { spaces, order, shared }, ids: [...ids] };
    },
    async tree(spaceId) {
      try {
        return await loadStructure(ctx, spaceId);
      } catch (error) {
        if (error instanceof CryptoError || unreachable(error)) return null;
        throw error;
      }
    },
    // From memory first, where the index or the reader just opened them.
    versions: (spaceId, wanted) => fetchRevisions(ctx, spaceId, wanted),
    blob: (blobHash) =>
      ctx.api.download(
        pageRoutes.BLOB_DOWNLOAD_PATH.replace(':hash', encodeURIComponent(blobHash)),
      ),
  };
}

/** Versions opened at a time, as the index opens them. */
const CHUNK = 100;

/**
 * Keep what's in `scope` current on this device (ADR 0009, decision 3): list
 * `spaces` (every one for `'all'`) again, and for each page in scope, open
 * the heads it doesn't keep yet (the published version, and for an editor
 * the draft) and keep them with the images they list. **Every page** keeps
 * each page listed; **Pages I open** only those opened here, `opened` among
 * them. Then let go: a version replaced, a page out of scope or no longer
 * listed, a space gone or closed to this person, with the blobs nothing
 * kept lists. Trees and the space list are kept as listed. A page with a
 * change queued keeps the version the change is based on, with its files,
 * whatever the listing says, until the change is resolved (decision 3).
 *
 * Runs with nothing else changing what's kept (`KeptStore.exclusive`). Stops
 * with `KeepingStopped` if the vault locks, access changes (the revision
 * cache is cleared) or `signal` aborts, and with the server's error if a
 * request fails; what it kept by then stays. Does nothing without
 * `ctx.keptContent`.
 */
export async function keep(
  ctx: ClientContext,
  {
    scope,
    spaces = 'all',
    opened = [],
    source = serverSource(ctx),
    signal,
    onProgress,
  }: {
    scope: KeepScope;
    spaces?: 'all' | readonly SpaceId[];
    opened?: readonly PageRef[];
    source?: KeeperSource;
    signal?: AbortSignal;
    onProgress?: (progress: KeepProgress) => void;
  },
): Promise<void> {
  const kept = ctx.keptContent;
  if (!kept) return;
  const generation = ctx.revisions.generation;
  const live = () => {
    if (signal?.aborted || kept.closed || ctx.revisions.generation !== generation) {
      throw new KeepingStopped();
    }
  };
  await kept.store.exclusive(async () => {
    await kept.reload();
    const bases = await kept.queue.bases();
    live();
    // What a queued change needs of `before`, a space as kept: those pages,
    // with only the versions their changes are based on.
    const needed = (before: KeptSpace | undefined) =>
      [...(before?.pages.values() ?? [])].flatMap((page) => {
        const base = bases.get(page.pageId);
        const versions = page.versions.filter((version) => version.id === base);
        return versions.length > 0 ? [{ ...page, versions }] : [];
      });
    let ids: SpaceId[];
    if (spaces === 'all') {
      const listed = await source.spaces();
      live();
      await kept.keepList(listed.list);
      ids = listed.ids;
      for (const spaceId of kept.spaceIds()) {
        if (!ids.includes(spaceId)) await letGoOf(kept, spaceId, needed(kept.space(spaceId)));
      }
    } else {
      ids = [...new Set([...spaces, ...opened.map((page) => page.spaceId)])];
    }
    const trees: { spaceId: SpaceId; tree: KeptTree; inScope: KeptTree['pages'] }[] = [];
    for (const spaceId of ids) {
      const tree = await source.tree(spaceId);
      live();
      if (!tree) {
        await letGoOf(kept, spaceId, needed(kept.space(spaceId)));
        continue;
      }
      const openedHere = new Set(opened.filter((p) => p.spaceId === spaceId).map((p) => p.pageId));
      const inScope = tree.pages.filter(
        (page) =>
          scope === 'every' || openedHere.has(page.id) || kept.page(spaceId, page.id)?.opened,
      );
      trees.push({ spaceId, tree, inScope });
    }
    const progress = { pages: 0, total: trees.reduce((sum, t) => sum + t.inScope.length, 0) };
    onProgress?.({ ...progress });
    for (const { spaceId, tree, inScope } of trees) {
      const openedHere = new Set(opened.filter((p) => p.spaceId === spaceId).map((p) => p.pageId));
      const pages = new Map<PageId, KeptPage>();
      for (let at = 0; at < inScope.length; at += CHUNK) {
        const chunk = inScope.slice(at, at + CHUNK);
        for (const page of await keepPages(kept, source, spaceId, chunk, live)) {
          const before = kept.page(spaceId, page.pageId);
          const markedOpened = openedHere.has(page.pageId) || before?.opened === true;
          pages.set(page.pageId, { ...page, opened: markedOpened });
        }
        progress.pages += chunk.length;
        onProgress?.({ ...progress });
      }
      // A queued change's base stays, beside the page's heads now.
      for (const page of needed(kept.space(spaceId))) {
        const now = pages.get(page.pageId);
        const versions = now?.versions ?? [];
        const missing = page.versions.filter((v) => !versions.some((kept) => kept.id === v.id));
        pages.set(page.pageId, { ...page, ...now, versions: [...versions, ...missing] });
      }
      live();
      await kept.keepSpace(spaceId, { listedAt: new Date().toISOString(), tree, pages });
    }
    live();
    await kept.collect();
  });
}

/**
 * Let go of a space no longer listed, or closed to this person, but for
 * the pages `needed` by changes queued for them, kept as they were.
 */
async function letGoOf(kept: KeptContent, spaceId: SpaceId, needed: KeptPage[]) {
  const space = kept.space(spaceId);
  if (!space || needed.length === 0) return kept.dropSpace(spaceId);
  const pages = new Map(needed.map((page) => [page.pageId, page]));
  await kept.keepSpace(spaceId, { ...space, pages });
}

/** Each of `pages`' heads kept, those not kept yet opened and kept with their images. */
async function keepPages(
  kept: KeptContent,
  source: KeeperSource,
  spaceId: SpaceId,
  pages: KeptTree['pages'],
  live: () => void,
): Promise<Omit<KeptPage, 'opened'>[]> {
  const heads = (page: KeptTree['pages'][number]) => {
    const found: [RevisionId, Audience][] = [];
    if (page.publishedHead) found.push([page.publishedHead, 'published']);
    if (page.draftHead && page.draftHead !== page.publishedHead) {
      found.push([page.draftHead, 'draft']);
    }
    return found;
  };
  const wanted = new Map<RevisionId, Wanted>();
  for (const page of pages) {
    for (const [head, audience] of heads(page)) {
      if (!kept.hasVersion(head)) wanted.set(head, { pageId: page.id, audience });
    }
  }
  const fetched = wanted.size > 0 ? await source.versions(spaceId, wanted) : new Map();
  live();
  const opened = new Map<RevisionId, Omit<KeptVersion, 'blobs'>>();
  for (const [revisionId, open] of fetched) {
    let version: OpenedRevision;
    try {
      version = open();
    } catch {
      continue;
    }
    // A version this app can't read isn't kept: an updated app opens it from the server.
    if (version.opened.kind !== 'current') continue;
    await kept.keepVersion({ ...version, opened: version.opened });
    opened.set(revisionId, { id: revisionId, ...filesOf(version.opened.payload) });
  }
  const keeping: Omit<KeptPage, 'opened'>[] = [];
  for (const page of pages) {
    const before = kept.page(spaceId, page.id);
    const versions: KeptVersion[] = [];
    for (const [head] of heads(page)) {
      const version = opened.get(head) ?? before?.versions.find((v) => v.id === head);
      if (!version) continue;
      // Its images, those a run before failed to download too, each once.
      for (const blobHash of new Set(version.images)) {
        if (kept.closed || kept.hasBlob(blobHash)) continue;
        try {
          await kept.keepBlob(blobHash, kept.takeOpened(blobHash) ?? (await source.blob(blobHash)));
        } catch {
          // Kept without it: the next run tries again.
        }
        live();
      }
      // With any other file of its own opened here, just now or before.
      for (const blobHash of new Set(version.files)) {
        const opened = kept.hasBlob(blobHash) ? undefined : kept.takeOpened(blobHash);
        if (opened) await kept.keepBlob(blobHash, opened);
      }
      const blobs = [...new Set(version.files)].filter((blobHash) => kept.hasBlob(blobHash));
      versions.push({ ...version, blobs });
    }
    keeping.push({ pageId: page.id, versions });
  }
  return keeping;
}

// Reading what's kept, offline (ADR 0009, decision 4): the same shapes the
// server's answers load as, from the lists, trees and versions last kept.

/**
 * What was asked for isn't kept on this device, as a page never opened here
 * with **Pages I open**, or nothing is kept at all.
 */
export class NotKept extends Error {
  constructor() {
    super('Not kept on this device');
    this.name = 'NotKept';
  }
}

/** The space list, its order and Shared with me, as last kept (`loadSpaces`, `sharedWithMe`). */
export function keptSpaceList(ctx: ClientContext): KeptSpaceList {
  const list = ctx.keptContent?.spaceList();
  if (!list) throw new NotKept();
  return list;
}

/** What the tree shows for a kept page whose version doesn't open. */
const UNLABELLED = { title: null, emoji: null, icon: null, symbol: null, region: null };

/**
 * A space's tree as last kept, in `loadTree`'s shape: its folders, and its
 * pages whose shown version is kept, each labelled from that version. The
 * other pages are left out, as this device can't name them.
 */
export async function keptTree(
  ctx: ClientContext,
  spaceId: SpaceId,
): Promise<Awaited<ReturnType<typeof loadTree>>> {
  const kept = ctx.keptContent;
  const space = kept?.space(spaceId);
  if (!kept || !space) throw new NotKept();
  const pages = kept.shownPages(space.tree);
  const labels = await pageLabels(ctx, spaceId, pages);
  return {
    ...space.tree,
    pages: pages.map((page) => ({ ...page, ...(labels.get(page.id) ?? UNLABELLED) })),
  };
}

/**
 * The pages of a space this device lists but keeps no shown version of, by
 * ID: links to them read as not kept, rather than missing. Empty if the
 * space isn't kept.
 */
export function notKeptIn(ctx: ClientContext, spaceId: SpaceId): Set<PageId> {
  const kept = ctx.keptContent;
  const space = kept?.space(spaceId);
  if (!kept || !space) return new Set();
  const shown = new Set(kept.shownPages(space.tree).map((page) => page.id));
  return new Set(space.tree.pages.filter((page) => !shown.has(page.id)).map((page) => page.id));
}

/**
 * What opening a kept page says of it (`loadPage`), worked out from its
 * space's tree as kept: its heads, and this person's role there, as the
 * server works it out: the nearest share at or above the page, else the
 * space's own. What only the server knows (how many versions were
 * published, an agent's edit) is left at nothing.
 */
export function keptPageInfo(
  ctx: ClientContext,
  pageId: PageId,
): z.output<typeof pageRoutes.PageInfo> {
  const kept = ctx.keptContent;
  for (const spaceId of kept?.spaceIds() ?? []) {
    const tree = kept?.space(spaceId)?.tree;
    const page = tree && kept?.shownPages(tree).find((p) => p.id === pageId);
    if (!tree || !page) continue;
    const parents = new Map(tree.folders.map((folder) => [folder.id, folder.parentId]));
    const seen = new Set<FolderId>();
    let grant: Pick<KeptTree['shares'][number], 'role' | 'canPublish'> | undefined;
    for (let id = page.parentId; id !== null && !seen.has(id); id = parents.get(id) ?? null) {
      seen.add(id);
      grant = tree.shares.find((share) => share.rootId === id);
      if (grant) break;
    }
    grant ??= tree.shares.find((share) => share.rootId === null) ?? tree.space ?? undefined;
    if (!grant) continue;
    return {
      pageId,
      spaceId,
      parentId: page.parentId,
      permissionVersion: page.permissionVersion,
      role: grant.role,
      canPublish: grant.canPublish,
      heads: {
        draftHead: page.draftHead,
        publishedHead: page.publishedHead,
        publishedCount: 0,
        draftChanges: page.draftChanges,
      },
      agentEdit: null,
      readerHistoryFrom: null,
    };
  }
  throw new NotKept();
}
