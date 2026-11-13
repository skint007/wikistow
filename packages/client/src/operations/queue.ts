// Changes made offline (ADR 0009, decision 7): the queue a device keeps of
// them, sealed, and their sending once the server answers.
import {
  FolderId,
  type InstallationId,
  MetadataRevisionId,
  PageId,
  Position,
  publicLinkRoutes,
  RevisionId,
  SpaceId,
  type pageRoutes,
} from '@wikistow/contracts';
import { z } from 'zod';
import { ApiError, noAnswer } from '../api/client.ts';
import { COVER_NAMESPACE, coverLeftBehind, reviseCover } from '../cover.ts';
import { decodeUtf8, utf8 } from '../encoding.ts';
import { CryptoError } from '../errors.ts';
import { newId } from '../ids.ts';
import type { KeptSealer, KeptStore } from '../kept-store.ts';
import { NodeMetadata, reviseMetadata } from '../metadata.ts';
import { parsePayload, type AttachmentRef, type PagePayload } from '../payload.ts';
import { OWNER_REGION, RegionJson, regionInTree, type Region } from '../regions.ts';
import { resealAttachment, sealAttachment } from '../revision.ts';
import type { ReadWikilinks } from '../link-table.ts';
import { moveNode, previewMove } from './moves.ts';
import { arrange } from './order.ts';
import { positionBetween } from '../positions.ts';
import {
  attachmentTarget,
  createPage,
  deleteNode,
  labelCover,
  loadPage,
  publishPage,
  saveDraft,
  uploadBlob,
  type PageRef,
} from './pages.ts';
import type { SavedVersion } from './search.ts';
import type { LoadedMetadata } from './records.ts';
import type { ClientContext } from './session.ts';
import { createFolderAs, loadStructure, updateMetadata, type loadTree } from './spaces.ts';

/**
 * Why an entry stopped, and waits for the person: someone saved the page
 * since its base (`conflict`), the page or the folder it goes in is gone or
 * out of reach (`gone`), or the server refused it for another reason.
 */
const Failure = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('conflict') }),
  z.strictObject({ kind: z.literal('gone') }),
  z.strictObject({ kind: z.literal('refused'), message: z.string() }),
]);
export type QueueFailure = z.output<typeof Failure>;

const Payload = z.json().transform((json, ctx) => {
  try {
    const opened = parsePayload(json);
    if (opened.kind === 'current') return opened.payload;
  } catch {
    // Reported below.
  }
  ctx.addIssue({ code: 'custom', message: 'Not a payload this app reads' });
  return z.NEVER;
});

/**
 * What a send was about to write, recorded before its request: the IDs it
 * uses, the entry's version it carries, and that version's payload, kept
 * until it is known to have landed. `partial` is a page made offline whose
 * first step leaves its attachments for the second.
 */
const Sending = z.strictObject({
  revisionId: RevisionId,
  version: z.number().int(),
  payload: Payload,
  partial: z.boolean(),
});
type Sending = z.output<typeof Sending>;

const QueuedPageJson = z.strictObject({
  kind: z.literal('page'),
  id: PageId,
  spaceId: SpaceId,
  /** A page made offline, until it is made on the server: where, and its first draft's ID. */
  newPage: z.strictObject({ parentId: FolderId.nullable(), revisionId: RevisionId }).nullable(),
  /** The draft this one goes on top of; null only while `newPage` isn't made. */
  basedOn: RevisionId.nullable(),
  /** The region its link table was worked out for, as the draft view opened it. */
  region: RegionJson.nullable(),
  payload: Payload,
  /** Counts up with each save into the entry. */
  version: z.number().int(),
  sending: Sending.nullable(),
  /** The pages the person picked for ambiguous links, by key (`LinkWrite.chosen`). */
  picks: z.record(z.string(), PageId),
  failure: Failure.nullable(),
  at: z.number(),
});
export type QueuedPage = z.output<typeof QueuedPageJson>;

const QueuedFolderJson = z.strictObject({
  kind: z.literal('folder'),
  id: FolderId,
  spaceId: SpaceId,
  parentId: FolderId.nullable(),
  metadata: NodeMetadata,
  /** What the tree names its name by until it is made. */
  head: MetadataRevisionId,
  /** A request to make it got no answer: it may be on the server already. */
  tried: z.literal(true).exactOptional(),
  failure: Failure.nullable(),
  at: z.number(),
});
export type QueuedFolder = z.output<typeof QueuedFolderJson>;

// What a rename changes: the name, emoji, colour, and icon by name. The
// image waits for the connection (#330).
const FolderChanges = z.strictObject({
  name: NodeMetadata.shape.name.exactOptional(),
  emoji: z.string().max(32).nullable().exactOptional(),
  tint: z.string().max(32).exactOptional(),
  extensions: NodeMetadata.shape.extensions.exactOptional(),
});
export type FolderChanges = z.output<typeof FolderChanges>;

/**
 * A folder the server has, renamed or given a new look offline: what
 * changed, on top of its metadata as the person saw it (`base`). A folder
 * made offline takes such changes into its own entry instead.
 */
const QueuedRenameJson = z.strictObject({
  kind: z.literal('rename'),
  id: FolderId,
  spaceId: SpaceId,
  base: z.strictObject({ head: MetadataRevisionId, metadata: NodeMetadata, region: RegionJson }),
  changes: FolderChanges,
  /** The version about to be sent, under its ID, with the changes it carries. */
  sending: z
    .strictObject({ metadataRevisionId: MetadataRevisionId, changes: FolderChanges })
    .nullable(),
  failure: Failure.nullable(),
  at: z.number(),
});
export type QueuedRename = z.output<typeof QueuedRenameJson>;

/**
 * A page or folder the server has, deleted offline: it goes to the trash
 * when sent. `name` names it should the server refuse, as the tree no
 * longer shows it.
 */
const QueuedDeleteJson = z.strictObject({
  kind: z.literal('delete'),
  id: z.union([PageId, FolderId]),
  node: z.enum(['page', 'folder']),
  spaceId: SpaceId,
  name: z.string(),
  /** A request went: one sent again, refused as `not-found`, landed then. */
  tried: z.literal(true).exactOptional(),
  failure: Failure.nullable(),
  at: z.number(),
});
export type QueuedDelete = z.output<typeof QueuedDeleteJson>;

/**
 * A page or folder the server has, moved within its space offline (#331):
 * under `parentId`, or to the top of the space for null. Only a move
 * within one share waits here, as one across a share's edge changes who
 * can read it. A later move takes the place of this one. `name` names it
 * should the server refuse. Nothing is recorded before its request: the
 * item's place says whether a move whose answer was lost landed. With
 * `position`, it goes there among what is in `parentId` (#400): a reorder
 * within its folder waits here too, as a move to where it is already.
 */
const QueuedMoveJson = z.strictObject({
  kind: z.literal('move'),
  id: z.union([PageId, FolderId]),
  node: z.enum(['page', 'folder']),
  spaceId: SpaceId,
  name: z.string(),
  parentId: FolderId.nullable(),
  position: Position.nullable().exactOptional(),
  failure: Failure.nullable(),
  at: z.number(),
});
export type QueuedMove = z.output<typeof QueuedMoveJson>;

/**
 * A page published offline (#331): the draft it publishes, `draftHead`,
 * once the server has it, and until then the page's change as it stood
 * when the person pressed Publish (`draft`, at that change's `version`),
 * so what is typed after goes after it. `sending` is the version about to
 * be sent, under its ID: that draft's, then the publication's.
 */
const QueuedPublishJson = z.strictObject({
  kind: z.literal('publish'),
  id: PageId,
  spaceId: SpaceId,
  title: z.string(),
  draftHead: RevisionId.nullable(),
  draft: z.strictObject({ version: z.number().int(), payload: Payload }).nullable(),
  sending: z.strictObject({ revisionId: RevisionId }).nullable(),
  failure: Failure.nullable(),
  at: z.number(),
});
export type QueuedPublish = z.output<typeof QueuedPublishJson>;

const QueueEntryJson = z.discriminatedUnion('kind', [
  QueuedPageJson,
  QueuedFolderJson,
  QueuedRenameJson,
  QueuedDeleteJson,
  QueuedMoveJson,
  QueuedPublishJson,
]);
export type QueueEntry =
  | QueuedPage
  | QueuedFolder
  | QueuedRename
  | QueuedDelete
  | QueuedMove
  | QueuedPublish;

/**
 * Which entry: a page or folder has at most one of each kind. Its own
 * (`page` or `folder`) holds it made offline, or its draft; each other
 * kind is one change to it, sent in the order made with the rest.
 */
export type QueueKey = Pick<QueueEntry, 'kind' | 'id'>;

// The kinds of change a page or folder can have waiting beside its own entry.
const CHANGE_KINDS = [
  'rename',
  'delete',
  'move',
  'publish',
] as const satisfies readonly QueueEntry['kind'][];

/** Whether `entry` is the item itself made offline, which the server doesn't have yet. */
export const madeOffline = (entry: QueueEntry): entry is QueuedFolder | QueuedPage =>
  entry.kind === 'folder' || (entry.kind === 'page' && entry.newPage !== null);

// Whether an item made offline may be on the server after all: a request
// to make it went, and its answer was lost.
const mayHaveLanded = (entry: QueuedFolder | QueuedPage) =>
  entry.kind === 'folder' ? entry.tried === true : entry.sending !== null;

/**
 * Whether deleting the item `entry` waits for drops it for good: made
 * offline, and never sent, so the server doesn't have it (`OfflineQueue.delete`).
 */
export const droppedOnDelete = (entry: QueueEntry): boolean =>
  madeOffline(entry) && !mayHaveLanded(entry);

/**
 * What changed in the queue, for whatever shows it: a draft saved into an
 * entry (`saved`), an entry added, gone, or stopped (`changed`), a version
 * about to be sent under its ID (`recorded`), which every session with the
 * page counts as its own, one that landed (`landed`), which they take
 * as their base, and a rename or delete that landed (`sent`), after which
 * what reads the space, its search and the trash, reads it again.
 */
export type QueueEvent =
  | { kind: 'saved'; entry: QueuedPage }
  | { kind: 'changed'; spaceId: SpaceId; id: PageId | FolderId }
  | { kind: 'sent'; spaceId: SpaceId }
  | { kind: 'recorded'; spaceId: SpaceId; pageId: PageId; revisionId: RevisionId }
  | { kind: 'landed'; spaceId: SpaceId; pageId: PageId; revisionId: RevisionId };

// How long after a change landed a save on its base still goes on top of it.
const LANDING_MS = 10_000;

// Entries and their files share the queue's store. Names start with what
// they are, so they can be counted before anyone unlocks.
const ENTRY = 'e';
const BLOB = 'b';

/**
 * How many changes `store` holds that haven't been sent, read before any
 * vault opens, for the warnings before signing out or in as someone else
 * (ADR 0009, decision 10).
 */
export async function queuedChanges(store: KeptStore): Promise<number> {
  const items = await store.queue.list();
  return items.filter((item) => item.name.startsWith(ENTRY)).length;
}

// The files an entry names, by hash: a draft's, and the one being sent.
const filesOf = (entry: QueueEntry): string[] =>
  (entry.kind === 'page'
    ? [...entry.payload.attachments, ...(entry.sending?.payload.attachments ?? [])]
    : entry.kind === 'publish' && entry.draft
      ? entry.draft.payload.attachments
      : []
  ).map((ref) => ref.blobHash);

// Whether a page made offline needs two steps: uploads need the page.
const hasFiles = (payload: PagePayload) => payload.attachments.length > 0;

// Its first step: made without its files, and without the banner or icon
// they show, as `createFromTemplate` does.
function withoutFiles(payload: PagePayload): PagePayload {
  const covered = payload.extensions[COVER_NAMESPACE] !== undefined;
  return {
    ...payload,
    attachments: [],
    extensions: covered
      ? {
          ...payload.extensions,
          ...reviseCover(payload.extensions, coverLeftBehind(payload.extensions, new Set())),
        }
      : payload.extensions,
  };
}

/**
 * Changes made offline, waiting on the device for the account it keeps
 * for (ADR 0009, decision 7): new folders, new pages and drafts, one entry
 * per page, and folders renamed and pages and folders deleted, one entry
 * each (`QueueKey`), each sealed like any kept item, with the files added
 * offline, sealed for their page's draft. Entries go to the server in the order
 * made (`send`), each with the IDs it recorded before its request, so an
 * answer lost on the way is told from a change that never landed.
 *
 * What the app writes goes in through the page writer (`createPageWriter`),
 * which decides what goes here; whatever only reads the queue takes a
 * `QueueReader`.
 */
export class OfflineQueue {
  readonly #store: KeptStore;
  readonly #sealer: KeptSealer;
  readonly #installationId: InstallationId;
  readonly #listeners = new Set<(event: QueueEvent) => void>();
  // Each page whose change landed and went: the draft that change was based
  // on, and the version that landed, so a save already on its way into it,
  // on that same base, goes on top of what landed.
  readonly #landedOn = new Map<PageId, { base: RevisionId; landed: RevisionId; at: number }>();
  #closed = false;
  #last = 0;

  constructor(store: KeptStore, sealer: KeptSealer, installationId: InstallationId) {
    this.#store = store;
    this.#sealer = sealer;
    this.#installationId = installationId;
  }

  /** Hear of each change to the queue made here, until the returned function is called. */
  subscribe(listener: (event: QueueEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => void this.#listeners.delete(listener);
  }

  #emit(event: QueueEvent) {
    for (const listener of this.#listeners) listener(event);
  }

  /** The session ended: nothing more is sent or written. What's queued stays, sealed. */
  close(): void {
    this.#closed = true;
    this.#listeners.clear();
  }

  // An item's own entry keeps the name it always had, so queues kept before
  // other kinds existed still open.
  #entryName = ({ kind, id }: QueueKey) =>
    ENTRY +
    this.#sealer.name(
      kind === 'page' || kind === 'folder' ? `queued ${id}` : `queued ${kind} ${id}`,
    );
  #blobName = (blobHash: string) => BLOB + this.#sealer.name(`queued blob ${blobHash}`);

  // A new entry's first version: never one an entry for the page had before,
  // so a window that saw an entry that went can't take a new one for it.
  #firstVersion() {
    return Date.now() * 1000 + Math.floor(Math.random() * 1000);
  }

  // Each later than the one before, so entries keep the order they were made in.
  #at() {
    this.#last = Math.max(Date.now(), this.#last + 1);
    return this.#last;
  }

  async #read(name: string): Promise<QueueEntry | null> {
    const sealed = await this.#store.queue.read(name).catch(() => null);
    const plaintext = sealed && this.#sealer.open(name, sealed);
    if (!plaintext) return null;
    try {
      return QueueEntryJson.parse(JSON.parse(decodeUtf8(plaintext, 'queued change')));
    } catch {
      return null;
    }
  }

  async #write(entry: QueueEntry) {
    if (this.#closed) return;
    const name = this.#entryName(entry);
    await this.#store.queue.write(name, this.#sealer.seal(name, utf8(JSON.stringify(entry))));
  }

  /** Every entry, in the order made. One that doesn't open counts as none. */
  async entries(): Promise<QueueEntry[]> {
    const names = (await this.#store.queue.list())
      .map((item) => item.name)
      .filter((name) => name.startsWith(ENTRY));
    const entries = await Promise.all(names.map((name) => this.#read(name)));
    return entries.filter((entry) => entry !== null).sort((a, b) => a.at - b.at);
  }

  /** A page's or folder's own entry, made offline or holding its draft, or null. */
  async entry(id: PageId | FolderId): Promise<QueuedPage | QueuedFolder | null> {
    const entry = await this.#read(this.#entryName({ kind: 'page', id }));
    return entry?.kind === 'page' || entry?.kind === 'folder' ? entry : null;
  }

  /** Every entry waiting for a page or folder: its own, and each change to it, in the order made. */
  async waiting(id: PageId | FolderId): Promise<QueueEntry[]> {
    const read = await Promise.all([
      this.entry(id),
      ...CHANGE_KINDS.map((kind) => this.#keyed({ kind, id })),
    ]);
    return read.filter((entry) => entry !== null).sort((a, b) => a.at - b.at);
  }

  // The entry under `key`, or null.
  async #keyed(key: QueueKey): Promise<QueueEntry | null> {
    const entry = await this.#read(this.#entryName(key));
    return entry?.kind === key.kind && entry.id === key.id ? entry : null;
  }

  async #page(pageId: PageId): Promise<QueuedPage | null> {
    const entry = await this.entry(pageId);
    return entry?.kind === 'page' ? entry : null;
  }

  async #rename(folderId: FolderId): Promise<QueuedRename | null> {
    const entry = await this.#keyed({ kind: 'rename', id: folderId });
    return entry?.kind === 'rename' ? entry : null;
  }

  async #publish(pageId: PageId): Promise<QueuedPublish | null> {
    const entry = await this.#keyed({ kind: 'publish', id: pageId });
    return entry?.kind === 'publish' ? entry : null;
  }

  /**
   * A publish about to go, or be replaced, while the draft it was saving
   * first may have landed, its answer lost: the page's change takes that
   * save on as its own, so it is sent again under the same ID, and what was
   * typed after goes on top of it, never as a conflict with itself. Only
   * from within `queueExclusive`.
   */
  async #handOver(publish: QueuedPublish) {
    if (!publish.draft || !publish.sending) return;
    const change = await this.#page(publish.id);
    if (!change || change.sending) return;
    const { revisionId } = publish.sending;
    const { version, payload } = publish.draft;
    await this.#write({ ...change, sending: { revisionId, version, payload, partial: false } });
  }

  /**
   * Save `payload`, the draft of `page` as typed, on this device. Into the
   * page's entry if it has one, keeping its base, unless the person chose
   * to save theirs on top of someone else's after a conflict (`onTop`, or
   * an entry stopped as one): then `basedOn`.
   * Otherwise a new entry on top of `basedOn`. `seen` is the entry's version
   * the caller last saw, or null if it saw none: an entry another tab or
   * window saved into since, or made, is a conflict (`stale-head`), as the
   * server would answer. Returns the entry's version now.
   */
  async saveDraft({
    page,
    basedOn,
    region,
    payload,
    seen,
    onTop = false,
    linkChoices,
  }: {
    page: PageRef;
    basedOn: RevisionId;
    region: Region | null;
    payload: PagePayload;
    seen: number | null;
    onTop?: boolean;
    linkChoices?: ReadonlyMap<string, PageId>;
  }): Promise<number> {
    const picks = Object.fromEntries(linkChoices ?? []);
    const { entry, made } = await this.#store.queueExclusive(async () => {
      const before = await this.#page(page.pageId);
      if (before && before.version !== seen) {
        throw new ApiError(409, 'stale-head', 'This page was changed in another window');
      }
      // Only a page the server has: one made offline goes on top of nothing.
      const rebased =
        (onTop || before?.failure?.kind === 'conflict') &&
        before !== null &&
        before.newPage === null &&
        before.basedOn !== basedOn;
      // The change the caller saw landed and went just now: this goes on top
      // of it, if the caller hadn't heard yet and is still on its base.
      const went = before ? undefined : this.#landedOn.get(page.pageId);
      this.#landedOn.delete(page.pageId);
      const landed =
        went?.base === basedOn && Date.now() - went.at < LANDING_MS ? went.landed : undefined;
      const entry: QueuedPage = before
        ? {
            ...before,
            payload,
            picks,
            version: before.version + 1,
            // What was being sent on the old base is the person's no more.
            ...(rebased && { basedOn, failure: null, sending: null }),
          }
        : {
            kind: 'page',
            id: page.pageId,
            spaceId: page.spaceId,
            newPage: null,
            basedOn: landed ?? basedOn,
            region,
            payload,
            version: this.#firstVersion(),
            sending: null,
            picks,
            failure: null,
            at: this.#at(),
          };
      await this.#write(entry);
      return { entry, made: !before || rebased };
    });
    this.#emit({ kind: 'saved', entry });
    if (made) this.#emit({ kind: 'changed', spaceId: page.spaceId, id: page.pageId });
    return entry.version;
  }

  /**
   * A draft view's save of `page` got no answer: keep it as an entry
   * already being sent under `revisionId`, so the next send resends it under
   * the same ID, and a `duplicate` then says it landed.
   */
  async lost({
    page,
    basedOn,
    region,
    payload,
    revisionId,
    linkChoices,
  }: {
    page: PageRef;
    basedOn: RevisionId;
    region: Region | null;
    payload: PagePayload;
    revisionId: RevisionId;
    linkChoices?: ReadonlyMap<string, PageId>;
  }): Promise<number> {
    const first = this.#firstVersion();
    const entry = await this.#store.queueExclusive(async () => {
      const before = await this.#page(page.pageId);
      if (before) return before;
      const entry: QueuedPage = {
        kind: 'page',
        id: page.pageId,
        spaceId: page.spaceId,
        newPage: null,
        basedOn,
        region,
        payload,
        version: first,
        sending: { revisionId, version: first, payload, partial: false },
        picks: Object.fromEntries(linkChoices ?? []),
        failure: null,
        at: this.#at(),
      };
      await this.#write(entry);
      return entry;
    });
    this.#emit({ kind: 'recorded', spaceId: page.spaceId, pageId: page.pageId, revisionId });
    this.#emit({ kind: 'changed', spaceId: page.spaceId, id: page.pageId });
    return entry.version;
  }

  /**
   * A new page in `spaceId`, under `parentId`, which may be a folder made
   * offline, holding `payload`. Its ID and its first draft's are made now,
   * or are `pageId` and `revisionId`. A `revisionId` given is one a request
   * that got no answer already used for `payload`: it is recorded as being
   * sent, so what is typed into the page later goes on top of it.
   */
  async newPage({
    spaceId,
    parentId,
    payload,
    pageId = newId(PageId),
    revisionId: sent,
  }: {
    spaceId: SpaceId;
    parentId: FolderId | null;
    payload: PagePayload;
    pageId?: PageId;
    revisionId?: RevisionId;
  }): Promise<QueuedPage> {
    const revisionId = sent ?? newId(RevisionId);
    const first = this.#firstVersion();
    const entry: QueuedPage = {
      kind: 'page',
      id: pageId,
      spaceId,
      newPage: { parentId, revisionId },
      basedOn: null,
      region: null,
      payload,
      version: first,
      sending: sent ? { revisionId, version: first, payload, partial: false } : null,
      picks: {},
      failure: null,
      at: this.#at(),
    };
    await this.#store.queueExclusive(() => this.#write(entry));
    this.#emit({ kind: 'changed', spaceId, id: pageId });
    return entry;
  }

  /** A new folder in `spaceId`, under `parentId`, holding `metadata` (`newFolderMetadata`). */
  async newFolder({
    spaceId,
    parentId,
    metadata,
    folderId = newId(FolderId),
    tried = false,
  }: {
    spaceId: SpaceId;
    parentId: FolderId | null;
    metadata: NodeMetadata;
    folderId?: FolderId;
    /** A request to make it already went, and got no answer. */
    tried?: boolean;
  }): Promise<QueuedFolder> {
    const entry: QueuedFolder = {
      kind: 'folder',
      id: folderId,
      spaceId,
      parentId,
      metadata,
      head: newId(MetadataRevisionId),
      ...(tried && { tried: true }),
      failure: null,
      at: this.#at(),
    };
    await this.#store.queueExclusive(() => this.#write(entry));
    this.#emit({ kind: 'changed', spaceId, id: folderId });
    return entry;
  }

  /**
   * Rename a folder, or change its look, on this device: `changes` on top
   * of `current`, its metadata as the person saw it. A folder made offline
   * takes them into its own entry; another folder into its rename entry,
   * on top of those there already. `metadataRevisionId` is one a request
   * that got no answer already used for them: it is recorded as being sent.
   */
  async rename({
    spaceId,
    folderId,
    current,
    changes,
    metadataRevisionId,
  }: {
    spaceId: SpaceId;
    folderId: FolderId;
    current: LoadedMetadata;
    changes: FolderChanges;
    metadataRevisionId?: MetadataRevisionId;
  }): Promise<void> {
    await this.#store.queueExclusive(async () => {
      const own = await this.entry(folderId);
      if (own?.kind === 'folder') {
        const metadata = reviseMetadata({ kind: 'current', metadata: own.metadata }, changes);
        return this.#write({ ...own, metadata });
      }
      // Renamed again while one waits, stopped or not: added to it, and a
      // conflict still waits for the person's choice.
      const before = await this.#rename(folderId);
      if (before) {
        return this.#write({ ...before, changes: mergeChanges(before.changes, changes) });
      }
      if (current.opened.kind !== 'current') {
        // Throws, as saving it online would.
        reviseMetadata(current.opened, changes);
        return;
      }
      await this.#write({
        kind: 'rename',
        id: folderId,
        spaceId,
        base: { head: current.head, metadata: current.opened.metadata, region: current.region },
        changes,
        sending: metadataRevisionId ? { metadataRevisionId, changes } : null,
        failure: null,
        at: this.#at(),
      });
    });
    this.#emit({ kind: 'changed', spaceId, id: folderId });
  }

  /**
   * Delete a page or folder on this device. One made offline goes with its
   * entry, and whatever was made offline in it, as the server never had
   * them (`'dropped'`). Another waits to go to the trash, after the
   * changes made before it (`'waiting'`), as does one made offline whose
   * request may have landed: it is made, then put in the trash.
   */
  async delete({
    spaceId,
    id,
    node,
    name,
    tried = false,
  }: {
    spaceId: SpaceId;
    id: PageId | FolderId;
    node: 'page' | 'folder';
    name: string;
    /** A request for it already went, and got no answer. */
    tried?: boolean;
  }): Promise<'dropped' | 'waiting'> {
    const toTrash = async (entry: Omit<QueuedDelete, 'kind' | 'failure' | 'at'>) => {
      if (await this.#keyed({ kind: 'delete', id: entry.id })) return;
      await this.#write({ kind: 'delete', ...entry, failure: null, at: this.#at() });
    };
    const { outcome, gone } = await this.#store.queueExclusive(async () => {
      const own = await this.entry(id);
      if (own && droppedOnDelete(own)) {
        const entries = await this.entries();
        const parents = new Map<string, FolderId | null>(
          entries.flatMap((entry) => (madeOffline(entry) ? [[entry.id, parentOf(entry)]] : [])),
        );
        const inside = (at: string | null | undefined): boolean =>
          at === id || (at != null && inside(parents.get(at)));
        const gone = entries.filter((entry) => madeOffline(entry) && inside(entry.id));
        for (const entry of gone) await this.#remove(entry);
        // What was moved into it goes to the trash with it, as it would online.
        for (const entry of entries) {
          if (entry.kind !== 'move' || !inside(entry.parentId)) continue;
          await this.#remove(entry);
          await toTrash({ id: entry.id, node: entry.node, spaceId, name: entry.name });
        }
        return { outcome: 'dropped' as const, gone };
      }
      await toTrash({ id, node, spaceId, name, ...(tried && { tried: true }) });
      // A page deleted isn't published first.
      const publish = node === 'page' ? await this.#keyed({ kind: 'publish', id }) : null;
      if (publish?.kind === 'publish') await this.#handOver(publish);
      if (publish) await this.#remove(publish);
      return { outcome: 'waiting' as const, gone: [] };
    });
    for (const entry of gone) this.#emit({ kind: 'changed', spaceId, id: entry.id });
    this.#emit({ kind: 'changed', spaceId, id });
    return outcome;
  }

  /**
   * Move a page or folder within its space on this device, under `parentId`
   * (null: the top of the space), within one share (#331). One made offline,
   * and never sent, moves in its own entry. Another waits in its move entry,
   * after the changes made before it, a later move taking the place of an
   * earlier one.
   */
  async move({
    spaceId,
    id,
    node,
    name,
    parentId,
    position,
  }: {
    spaceId: SpaceId;
    id: PageId | FolderId;
    node: 'page' | 'folder';
    name: string;
    parentId: FolderId | null;
    /** Where among what is there; left out, as the server places a move. */
    position?: Position | null;
  }): Promise<void> {
    await this.#store.queueExclusive(async () => {
      const own = await this.entry(id);
      // Made here, it is placed as the server places something new.
      if (own?.kind === 'folder' && !mayHaveLanded(own)) return this.#write({ ...own, parentId });
      if (own?.kind === 'page' && own.newPage && !mayHaveLanded(own)) {
        return this.#write({ ...own, newPage: { ...own.newPage, parentId } });
      }
      const before = await this.#keyed({ kind: 'move', id });
      // A later move takes the place of an earlier one, and of where that put it.
      const moved =
        before?.kind === 'move' ? before : { kind: 'move' as const, id, node, spaceId, name };
      await this.#write({
        kind: 'move',
        id: moved.id,
        node: moved.node,
        spaceId: moved.spaceId,
        name: moved.name,
        parentId,
        ...(position !== undefined && { position }),
        failure: null,
        // In the order made: after what it may need moved first.
        at: this.#at(),
      });
    });
    this.#emit({ kind: 'changed', spaceId, id });
  }

  /**
   * Publish a page on this device (#331): its draft as it stands now, the
   * page's change waiting here if it has one, else `draftHead`, the
   * server's. Sent after that change, and before what is typed after.
   * Publishing again takes the place of a publish still waiting.
   */
  async publish({
    page,
    title,
    draftHead,
  }: {
    page: PageRef;
    title: string;
    draftHead: RevisionId;
  }): Promise<void> {
    await this.#store.queueExclusive(async () => {
      const change = await this.#page(page.pageId);
      if (change?.newPage) throw new Error('A page made offline is published once it is made');
      const before = await this.#publish(page.pageId);
      if (before) await this.#handOver(before);
      await this.#write({
        kind: 'publish',
        id: page.pageId,
        spaceId: page.spaceId,
        title: change?.payload.title ?? title,
        draftHead: change ? null : draftHead,
        draft: change ? { version: change.version, payload: change.payload } : null,
        sending: null,
        failure: null,
        at: before?.at ?? this.#at(),
      });
    });
    this.#emit({ kind: 'changed', spaceId: page.spaceId, id: page.pageId });
  }

  /**
   * A file added to `page`'s draft offline: sealed for the draft now (protocol
   * section 5.3), and kept here until a save naming it lands.
   */
  async attach(
    page: PageRef,
    file: { name: string; mediaType: string; bytes: Uint8Array },
  ): Promise<AttachmentRef> {
    const { spaceId, pageId } = page;
    const { ref, blob } = sealAttachment({
      target: { installationId: this.#installationId, spaceId, pageId, audience: 'draft' },
      ...file,
    });
    await this.#keepBlob(ref.blobHash, blob);
    return ref;
  }

  async #keepBlob(blobHash: string, blob: Uint8Array) {
    if (this.#closed) return;
    const name = this.#blobName(blobHash);
    await this.#store.queue.write(name, this.#sealer.seal(name, blob));
  }

  /** A file added offline, as the server will serve it, or null if the queue doesn't hold it. */
  async blob(blobHash: string): Promise<Uint8Array | null> {
    const name = this.#blobName(blobHash);
    const sealed = await this.#store.queue.read(name).catch(() => null);
    return sealed && this.#sealer.open(name, sealed);
  }

  /**
   * Delete `entry`, and the files it names that no other entry does. A file
   * added since its last save, which no entry names yet, stays for the save
   * about to name it. Only from within `queueExclusive`.
   */
  async #remove(entry: QueueEntry) {
    const others = (await this.entries()).filter(
      (other) => other.id !== entry.id || other.kind !== entry.kind,
    );
    const named = new Set(others.flatMap(filesOf));
    const own = [...new Set(filesOf(entry))];
    const names = own.filter((blobHash) => !named.has(blobHash)).map((h) => this.#blobName(h));
    await this.#store.queue.remove([this.#entryName(entry), ...names]);
  }

  /** Those of `refs` whose files this queue holds, added offline and not sent yet. */
  async held(refs: readonly AttachmentRef[]): Promise<AttachmentRef[]> {
    if (refs.length === 0) return [];
    const names = new Set((await this.#store.queue.list()).map((item) => item.name));
    return refs.filter((ref) => names.has(this.#blobName(ref.blobHash)));
  }

  /**
   * Upload (`put`) the files of `refs` this queue holds, before a save of
   * their page's draft that names them: staged uploads last a day on the server.
   */
  async upload(
    refs: readonly AttachmentRef[],
    put: (blob: Uint8Array) => Promise<void>,
  ): Promise<void> {
    for (const ref of await this.held(refs)) {
      const blob = await this.blob(ref.blobHash);
      if (blob) await put(blob);
    }
  }

  /**
   * After a save from the draft view landed online naming `refs`: let go of
   * their files here, unless an entry names them.
   */
  async sent(refs: readonly AttachmentRef[]): Promise<void> {
    const held = await this.held(refs);
    if (held.length === 0) return;
    await this.#store.queueExclusive(async () => {
      const named = new Set((await this.entries()).flatMap(filesOf));
      const names = held
        .filter((ref) => !named.has(ref.blobHash))
        .map((ref) => this.#blobName(ref.blobHash));
      await this.#store.queue.remove(names);
    });
  }

  /** Forget a change, as the person chose. */
  async discard(key: QueueKey): Promise<void> {
    const entry = await this.#store.queueExclusive(async () => {
      const entry = await this.#keyed(key);
      if (entry?.kind === 'publish') await this.#handOver(entry);
      if (entry) await this.#remove(entry);
      return entry;
    });
    if (entry) this.#emit({ kind: 'changed', spaceId: entry.spaceId, id: key.id });
  }

  /** Send a stopped change again at the next `send`, as for a page restored from the trash. */
  async retry(key: QueueKey): Promise<void> {
    const entry = await this.#store.queueExclusive(async () => {
      const entry = await this.#keyed(key);
      if (entry?.failure) await this.#write({ ...entry, failure: null });
      return entry;
    });
    if (entry) this.#emit({ kind: 'changed', spaceId: entry.spaceId, id: key.id });
  }

  /**
   * For a rename stopped because someone changed the folder since
   * (`conflict`), the person chose to keep their own (Yours): send it
   * again on top of `theirs`, the folder's metadata now.
   */
  async renameOnTop(folderId: FolderId, theirs: LoadedMetadata): Promise<void> {
    if (theirs.opened.kind !== 'current') return;
    const { metadata } = theirs.opened;
    const entry = await this.#store.queueExclusive(async () => {
      const entry = await this.#rename(folderId);
      if (!entry) return null;
      const base = { head: theirs.head, metadata, region: theirs.region };
      await this.#write({ ...entry, base, sending: null, failure: null });
      return entry;
    });
    if (entry) this.#emit({ kind: 'changed', spaceId: entry.spaceId, id: folderId });
  }

  /**
   * The files of a page's change this device has, and those it doesn't,
   * such as one never opened here, for saving it as a new page elsewhere.
   */
  async filesHere(
    ctx: ClientContext,
    entry: QueuedPage,
  ): Promise<{ here: Map<string, Uint8Array>; missing: AttachmentRef[] }> {
    const here = new Map<string, Uint8Array>();
    const missing: AttachmentRef[] = [];
    for (const ref of entry.payload.attachments) {
      const blob =
        (await this.blob(ref.blobHash)) ??
        (await ctx.keptContent?.blob(ref.blobHash).catch(() => null));
      if (blob) here.set(ref.blobHash, blob);
      else missing.push(ref);
    }
    return { here, missing };
  }

  /**
   * For a page gone or out of reach (ADR 0009, decision 7): its change as a
   * new page at the top of `spaceId`, the person's home space, with its
   * title, text and the files this device has, sealed again for the new
   * page. Files it doesn't have are left out, and the banner or icon they
   * showed with them. The change for the page that's gone goes.
   */
  async saveAsNewPage(ctx: ClientContext, id: PageId, spaceId: SpaceId): Promise<PageId> {
    const entry = await this.#page(id);
    if (!entry) throw new ApiError(404, 'not-found', 'That change was already sent or discarded');
    const { here } = await this.filesHere(ctx, entry);
    const pageId = newId(PageId);
    const source = attachmentTarget(ctx, { spaceId: entry.spaceId, pageId: entry.id }, 'draft');
    const target = attachmentTarget(ctx, { spaceId, pageId }, 'draft');
    const attachments: AttachmentRef[] = [];
    for (const ref of entry.payload.attachments) {
      const blob = here.get(ref.blobHash);
      if (!blob) continue;
      const resealed = resealAttachment({ from: source, to: target, ref, blob });
      await this.#keepBlob(resealed.ref.blobHash, resealed.blob);
      attachments.push(resealed.ref);
    }
    const { extensions } = entry.payload;
    const kept = new Set(attachments.map((ref) => ref.id));
    const covered = extensions[COVER_NAMESPACE] !== undefined;
    const payload: PagePayload = {
      ...entry.payload,
      attachments,
      extensions: covered
        ? { ...extensions, ...reviseCover(extensions, coverLeftBehind(extensions, kept)) }
        : extensions,
    };
    await this.newPage({ spaceId, parentId: null, payload, pageId });
    await this.discard(entry);
    return pageId;
  }

  /**
   * Send what's queued, in the order made, through the same operations as
   * online, which seal with the share's keys of the moment and check the
   * region (decision 7). A page waits for the folder made offline it goes
   * in. Each request's IDs are recorded first; one resent after a lost
   * answer goes under them again, and `duplicate` then means it landed. An
   * entry the server refuses stops, with why (`failure`), and the rest go
   * on, unless they go in a folder that stopped. No answer stops sending
   * (`'offline'`), to go on when the server answers. One sender at a time
   * (`KeptStore.sending`): `'busy'` if another is sending. `read` reads a
   * draft's links, as for `saveDraft`.
   */
  async send(
    ctx: ClientContext,
    { read }: { read?: ReadWikilinks } = {},
  ): Promise<'sent' | 'offline' | 'busy'> {
    let outcome: 'sent' | 'offline' = 'sent';
    const ran = await this.#store.sending(async () => {
      outcome = await this.#sendAll(ctx, read);
    });
    return ran ? outcome : 'busy';
  }

  async #sendAll(ctx: ClientContext, read: ReadWikilinks | undefined): Promise<'sent' | 'offline'> {
    // Each round sends one request, and every one either removes an entry,
    // moves it a step on, or stops it; a page typed into meanwhile takes more.
    for (let round = 0; round < 10_000 && !this.#closed; round += 1) {
      const entries = await this.entries();
      const folders = new Map(
        entries.flatMap((entry) => (entry.kind === 'folder' ? [[entry.id, entry]] : [])),
      );
      const drafts = new Map(
        entries.flatMap((entry) => (entry.kind === 'page' ? [[entry.id, entry]] : [])),
      );
      const publishes = new Map(
        entries.flatMap((entry) => (entry.kind === 'publish' ? [[entry.id, entry]] : [])),
      );
      const moving = entries.some((entry) => entry.kind === 'move' && entry.failure === null);
      let next: QueueEntry | undefined;
      for (const entry of entries) {
        if (entry.failure) continue;
        // Where it goes, made offline: a folder that must be made first.
        const parentId = madeOffline(entry)
          ? parentOf(entry)
          : entry.kind === 'move'
            ? entry.parentId
            : null;
        const parent = parentId ? folders.get(parentId) : undefined;
        if (parent?.failure?.kind === 'gone') {
          await this.#stop(entry, { kind: 'gone' });
          continue;
        }
        if (parent) continue;
        // A delete waits while a change to the same item waits for the
        // person, as its draft goes first, and a publish while the page's draft does.
        const held = entries.some((other) => other.id === entry.id && other.failure);
        if (entry.kind === 'delete' && held) continue;
        // A delete waits for the moves waiting too: one made again goes in
        // its new order, and may take its item out of what is deleted.
        if (entry.kind === 'delete' && moving) continue;
        if (entry.kind === 'publish' && drafts.get(entry.id)?.failure) continue;
        // A publish goes between its draft as it stood and what was typed after.
        if (entry.kind === 'page' && publishesFirst(publishes.get(entry.id), entry)) continue;
        if (entry.kind === 'publish' && entry.draft) {
          const change = drafts.get(entry.id);
          if (change && !publishesFirst(entry, change)) continue;
        }
        next = entry;
        break;
      }
      if (!next) return 'sent';
      if ((await this.#sendOne(ctx, next, entries, read)) === 'offline') return 'offline';
    }
    return 'sent';
  }

  #sendOne(
    ctx: ClientContext,
    entry: QueueEntry,
    entries: readonly QueueEntry[],
    read: ReadWikilinks | undefined,
  ): Promise<'offline' | void> {
    switch (entry.kind) {
      case 'folder':
        return this.#sendFolder(ctx, entry, entries);
      case 'page':
        return this.#sendPage(ctx, entry, read);
      case 'rename':
        return this.#sendRename(ctx, entry);
      case 'delete':
        return this.#sendDelete(ctx, entry);
      case 'move':
        return this.#sendMove(ctx, entry);
      case 'publish':
        return this.#sendPublish(ctx, entry, entries, read);
    }
  }

  async #sendFolder(
    ctx: ClientContext,
    entry: QueuedFolder,
    entries: readonly QueueEntry[],
  ): Promise<'offline' | void> {
    const { id: folderId, spaceId, parentId } = entry;
    // Recorded before its request, as one whose answer is lost may be made.
    // Gone meanwhile, as when deleted, it isn't sent.
    const current = await this.#store.queueExclusive(async () => {
      const current = await this.entry(folderId);
      if (current?.kind !== 'folder' || current.failure) return null;
      if (!current.tried) await this.#write({ ...current, tried: true });
      return current;
    });
    if (!current) return;
    let { metadata } = current;
    try {
      await createFolderAs(ctx, { spaceId, parentId, folderId, metadata });
    } catch (error) {
      if (!(error instanceof ApiError && error.code === 'duplicate')) {
        const failure = failureOf(error);
        if (!failure) return 'offline';
        // An empty folder made offline whose parent is gone just goes.
        const holds = entries.some(
          (other) => other.id !== entry.id && madeOffline(other) && parentOf(other) === entry.id,
        );
        if (failure.kind === 'gone' && !holds) return this.discard(entry);
        return this.#stop(entry, failure);
      }
      // Made by an earlier request whose answer was lost: renamed since,
      // the name and look it holds now go too.
      const now = await this.entry(folderId);
      if (now?.kind === 'folder') {
        const owed = await this.#renameMade(ctx, now);
        if (owed === 'offline') return 'offline';
        if (owed === 'stopped') return;
        ({ metadata } = now);
      }
    }
    // It goes, unless renamed while this went: then the next round sends that.
    await this.#store.queueExclusive(async () => {
      const now = await this.entry(folderId);
      if (now?.kind === 'folder' && JSON.stringify(now.metadata) === JSON.stringify(metadata)) {
        await this.#remove(now);
      }
    });
    this.#emit({ kind: 'changed', spaceId, id: folderId });
  }

  // A folder made offline, on the server already: the name and look its
  // entry holds now, sent if the server's differ.
  async #renameMade(
    ctx: ClientContext,
    entry: QueuedFolder,
  ): Promise<'sent' | 'offline' | 'stopped'> {
    const { spaceId, id: folderId, metadata } = entry;
    try {
      const { folders } = await loadStructure(ctx, spaceId);
      const now = folders.find((folder) => folder.id === folderId)?.metadata;
      if (!now || now.opened.kind !== 'current') return 'sent';
      const changes = {
        name: metadata.name,
        emoji: metadata.emoji ?? null,
        ...(metadata.tint !== undefined && { tint: metadata.tint }),
        extensions: metadata.extensions,
      };
      if (reads(now.opened.metadata, changes)) return 'sent';
      await updateMetadata(ctx, {
        spaceId,
        subject: { kind: 'folder', folderId },
        current: now,
        changes,
      });
      return 'sent';
    } catch (error) {
      const failure = failureOf(error);
      if (!failure) return 'offline';
      await this.#stop(entry, failure);
      return 'stopped';
    }
  }

  async #sendRename(ctx: ClientContext, entry: QueuedRename): Promise<'offline' | void> {
    const sending = entry.sending ?? (await this.#recordRename(entry));
    if (!sending) return;
    const { spaceId, id: folderId, base } = entry;
    const send = (region: Region) =>
      updateMetadata(ctx, {
        spaceId,
        subject: { kind: 'folder', folderId },
        current: { head: base.head, opened: { kind: 'current', metadata: base.metadata }, region },
        changes: sending.changes,
        metadataRevisionId: sending.metadataRevisionId,
      });
    let landed: LoadedMetadata;
    try {
      try {
        landed = await send(base.region);
      } catch (error) {
        // Moved into or out of a share since it was queued, as `saveDraft`
        // finds: sealed again for the region its name is in now. The check
        // refused it before anything was sealed under the keys it had.
        const moved =
          (error instanceof ApiError || error instanceof CryptoError) &&
          error.code === 'region-mismatch';
        if (!moved) throw error;
        const { folders } = await loadStructure(ctx, spaceId);
        const now = folders.find((folder) => folder.id === folderId)?.metadata;
        if (!now) throw error;
        landed = await send(now.region);
      }
    } catch (error) {
      const failure = failureOf(error);
      if (!failure) return 'offline';
      if (failure.kind !== 'conflict') return this.#stop(entry, failure);
      // Changed since: by this very change, whose answer was lost, or to
      // what it asks for anyway. Then nothing is left to send.
      let now: LoadedMetadata | undefined;
      try {
        const { folders } = await loadStructure(ctx, spaceId);
        now = folders.find((folder) => folder.id === folderId)?.metadata ?? undefined;
      } catch (error) {
        const failure = failureOf(error);
        return failure ? this.#stop(entry, failure) : 'offline';
      }
      if (now?.opened.kind !== 'current' || !reads(now.opened.metadata, sending.changes)) {
        return this.#stop(entry, failure);
      }
      landed = now;
    }
    await this.#renameLanded(entry, landed);
  }

  // Record what the next rename request sends, before it is sent.
  async #recordRename(entry: QueuedRename): Promise<QueuedRename['sending']> {
    return this.#store.queueExclusive(async () => {
      const current = await this.#rename(entry.id);
      if (!current || current.failure) return null;
      if (current.sending) return current.sending;
      const sending = { metadataRevisionId: newId(MetadataRevisionId), changes: current.changes };
      await this.#write({ ...current, sending });
      return sending;
    });
  }

  // It landed as `landed`: the entry goes, unless renamed again meanwhile.
  // Then what's left goes on top of what landed.
  async #renameLanded(entry: QueuedRename, landed: LoadedMetadata) {
    await this.#store.queueExclusive(async () => {
      const current = await this.#rename(entry.id);
      if (!current) return;
      if (landed.opened.kind !== 'current' || reads(landed.opened.metadata, current.changes)) {
        return this.#remove(current);
      }
      const base = { head: landed.head, metadata: landed.opened.metadata, region: landed.region };
      await this.#write({ ...current, base, sending: null });
    });
    this.#emit({ kind: 'changed', spaceId: entry.spaceId, id: entry.id });
    this.#emit({ kind: 'sent', spaceId: entry.spaceId });
  }

  async #sendDelete(ctx: ClientContext, entry: QueuedDelete): Promise<'offline' | void> {
    // Recorded before its request, as its answer may be lost.
    const tried = await this.#store.queueExclusive(async () => {
      const current = await this.#keyed(entry);
      if (current?.kind !== 'delete' || current.failure) return null;
      if (!current.tried) await this.#write({ ...current, tried: true });
      return current.tried === true;
    });
    if (tried === null) return;
    try {
      await deleteNode(ctx, { spaceId: entry.spaceId, nodeId: entry.id });
    } catch (error) {
      const failure = failureOf(error);
      if (!failure) return 'offline';
      // Sent before, and its answer lost: it is in the trash already.
      const landed = tried && error instanceof ApiError && error.code === 'not-found';
      if (!landed) return this.#stop(entry, failure);
    }
    await this.discard(entry);
    this.#emit({ kind: 'sent', spaceId: entry.spaceId });
  }

  async #sendMove(ctx: ClientContext, entry: QueuedMove): Promise<'offline' | void> {
    const { spaceId, id: nodeId, parentId, position } = entry;
    try {
      // Checked as online: where it is now, and whether keys would change.
      const preview = await previewMove(ctx, {
        spaceId,
        nodeId,
        parentId,
        ...(position !== undefined && { position }),
      });
      // There already: moved by this, whose answer was lost, or by someone
      // else, or put in its place there, which a position sets again.
      if (preview.fromParentId !== parentId) {
        if (preview.crossing) return this.#stop(entry, MOVES_ACROSS);
        await moveNode(ctx, { preview });
      } else if (position !== undefined) {
        await arrange(ctx, { spaceId, parentId, positions: [{ nodeId, position }] });
      }
    } catch (error) {
      const failure = failureOf(error);
      if (!failure) return 'offline';
      // Into itself, or it moved meanwhile: the person moves it again.
      return this.#stop(entry, failure.kind === 'conflict' ? refused(error) : failure);
    }
    await this.#store.queueExclusive(async () => {
      const current = await this.#keyed(entry);
      // Moved again while this went: the next round sends that.
      if (
        current?.kind === 'move' &&
        current.parentId === parentId &&
        current.position === position
      ) {
        await this.#remove(current);
      }
    });
    this.#emit({ kind: 'changed', spaceId, id: nodeId });
    this.#emit({ kind: 'sent', spaceId });
  }

  async #sendPublish(
    ctx: ClientContext,
    entry: QueuedPublish,
    entries: readonly QueueEntry[],
    read: ReadWikilinks | undefined,
  ): Promise<'offline' | void> {
    const page = { spaceId: entry.spaceId, pageId: entry.id };
    const change = entries.find(
      (other): other is QueuedPage => other.kind === 'page' && other.id === entry.id,
    );
    if (entry.draft) {
      // Its draft went without it: discarded, or sent with what was typed after.
      const basedOn = change?.basedOn;
      if (!change || !basedOn) return this.#stop(entry, PUBLISH_CHANGED);
      return this.#sendPublishedDraft(ctx, entry, entry.draft, { ...change, basedOn }, read);
    }
    const draftHead = entry.draftHead;
    if (!draftHead) return this.#stop(entry, PUBLISH_CHANGED);
    const sending = entry.sending ?? (await this.#recordPublish(entry));
    if (!sending) return;
    try {
      const { heads } = await loadPage(ctx, entry.id);
      // Published already: by this, whose answer was lost.
      if (heads.publishedHead !== sending.revisionId) {
        // Its public copy changes too, which the person checks online (ADR 0005).
        const { links } = await ctx.api.call(publicLinkRoutes.list, {
          params: { spaceId: entry.spaceId },
        });
        if (links.some((link) => link.pageId === entry.id)) return this.#stop(entry, LINKED);
        await publishPage(ctx, page, {
          expected: { draftHead, publishedHead: heads.publishedHead },
          revisionId: sending.revisionId,
          ...(read && { read }),
        });
      }
    } catch (error) {
      const failure = failureOf(error);
      if (!failure) return 'offline';
      return this.#stop(entry, failure.kind === 'conflict' ? PUBLISH_CHANGED : failure);
    }
    await this.#store.queueExclusive(async () => {
      const current = await this.#publish(entry.id);
      // Published again while this went: the next round sends that.
      if (current?.sending?.revisionId === sending.revisionId) await this.#remove(current);
    });
    this.#emit({ kind: 'changed', spaceId: entry.spaceId, id: entry.id });
    this.#emit({ kind: 'sent', spaceId: entry.spaceId });
  }

  // A publish's draft as it stood, saved before what was typed after it,
  // which then goes on top of it.
  async #sendPublishedDraft(
    ctx: ClientContext,
    entry: QueuedPublish,
    draft: NonNullable<QueuedPublish['draft']>,
    change: QueuedPage & { basedOn: RevisionId },
    read: ReadWikilinks | undefined,
  ): Promise<'offline' | void> {
    const page = { spaceId: entry.spaceId, pageId: entry.id };
    const sending = entry.sending ?? (await this.#recordPublish(entry));
    if (!sending) return;
    const { revisionId } = sending;
    this.#emit({ kind: 'recorded', spaceId: entry.spaceId, pageId: entry.id, revisionId });
    try {
      await this.upload(draft.payload.attachments, (blob) => uploadBlob(ctx, page, 'draft', blob));
      await saveDraft(ctx, {
        page,
        basedOn: change.basedOn,
        payload: draft.payload,
        revisionId,
        ...(change.region && { tableRegion: change.region }),
        linkChoices: new Map(Object.entries(change.picks)),
        ...(read && { read }),
      });
    } catch (error) {
      if (!(error instanceof ApiError && error.code === 'duplicate')) {
        const failure = failureOf(error);
        if (!failure) return 'offline';
        return this.#stop(entry, failure.kind === 'conflict' ? PUBLISH_CHANGED : failure);
      }
    }
    await this.#store.queueExclusive(async () => {
      const current = await this.#publish(entry.id);
      if (current?.draft?.version === draft.version) {
        await this.#write({ ...current, draftHead: revisionId, draft: null, sending: null });
      }
      const after = await this.#page(entry.id);
      if (after?.basedOn === change.basedOn && !after.sending) {
        await this.#write({ ...after, basedOn: revisionId });
      }
      // Files the draft as it stood named, and nothing names now, are let go of.
      const named = new Set((await this.entries()).flatMap(filesOf));
      const loose = draft.payload.attachments.filter((ref) => !named.has(ref.blobHash));
      await this.#store.queue.remove(loose.map((ref) => this.#blobName(ref.blobHash)));
    });
    this.#emit({ kind: 'changed', spaceId: entry.spaceId, id: entry.id });
  }

  // Record what the next publish request sends, before it is sent.
  async #recordPublish(entry: QueuedPublish): Promise<QueuedPublish['sending']> {
    return this.#store.queueExclusive(async () => {
      const current = await this.#publish(entry.id);
      if (!current || current.failure) return null;
      if (current.sending) return current.sending;
      const sending = { revisionId: newId(RevisionId) };
      await this.#write({ ...current, sending });
      return sending;
    });
  }

  async #sendPage(
    ctx: ClientContext,
    entry: QueuedPage,
    read: ReadWikilinks | undefined,
  ): Promise<'offline' | void> {
    const page = { spaceId: entry.spaceId, pageId: entry.id };
    const attempt = entry.sending ?? (await this.#record(entry));
    if (!attempt) return;
    this.#emit({
      kind: 'recorded',
      spaceId: entry.spaceId,
      pageId: entry.id,
      revisionId: attempt.revisionId,
    });
    try {
      if (entry.newPage) {
        const { title, markdown, extensions } = attempt.payload;
        await createPage(ctx, {
          spaceId: entry.spaceId,
          parentId: entry.newPage.parentId,
          title,
          markdown,
          extensions,
          pageId: entry.id,
          revisionId: attempt.revisionId,
          linkChoices: new Map(Object.entries(entry.picks)),
        });
      } else if (entry.basedOn) {
        // Uploads are staged for a day: those of the files added offline go
        // up again before each save that names them.
        await this.upload(attempt.payload.attachments, (blob) =>
          uploadBlob(ctx, page, 'draft', blob),
        );
        await saveDraft(ctx, {
          page,
          basedOn: entry.basedOn,
          payload: attempt.payload,
          revisionId: attempt.revisionId,
          // Its table's entries go only where it was worked out for.
          ...(entry.region && { tableRegion: entry.region }),
          linkChoices: new Map(Object.entries(entry.picks)),
          ...(read && { read }),
        });
      }
    } catch (error) {
      if (!(error instanceof ApiError && error.code === 'duplicate')) {
        const failure = failureOf(error);
        return failure ? this.#stop(entry, failure) : 'offline';
      }
    }
    await this.#landed(entry, attempt);
  }

  // Record what the next request sends, before it is sent.
  async #record(entry: QueuedPage): Promise<Sending | null> {
    return this.#store.queueExclusive(async () => {
      const current = await this.#page(entry.id);
      if (!current || current.failure) return null;
      if (current.sending) return current.sending;
      const partial = current.newPage !== null && hasFiles(current.payload);
      const sending: Sending = {
        revisionId: current.newPage?.revisionId ?? newId(RevisionId),
        version: current.version,
        payload: partial ? withoutFiles(current.payload) : current.payload,
        partial,
      };
      await this.#write({ ...current, sending });
      return sending;
    });
  }

  // It landed: the entry goes, unless it was saved into meanwhile, or this
  // was a new page's first step. Then it is based on what landed, and sent next.
  async #landed(entry: QueuedPage, sent: Sending) {
    await this.#store.queueExclusive(async () => {
      // A publish of the draft as it stood then publishes what landed.
      const publish = await this.#publish(entry.id);
      if (publish?.draft?.version === sent.version && !sent.partial) {
        await this.#write({ ...publish, draftHead: sent.revisionId, draft: null });
      }
      const current = await this.#page(entry.id);
      if (!current) return;
      if (current.version === sent.version && !sent.partial) {
        const base = current.basedOn ?? current.newPage?.revisionId;
        if (base) this.#landedOn.set(entry.id, { base, landed: sent.revisionId, at: Date.now() });
        return this.#remove(current);
      }
      await this.#write({ ...current, newPage: null, basedOn: sent.revisionId, sending: null });
    });
    this.#emit({
      kind: 'landed',
      spaceId: entry.spaceId,
      pageId: entry.id,
      revisionId: sent.revisionId,
    });
    this.#emit({ kind: 'changed', spaceId: entry.spaceId, id: entry.id });
  }

  // Stopped, waiting for the person. What was recorded didn't land.
  async #stop(entry: QueueEntry, failure: QueueFailure) {
    await this.#store.queueExclusive(async () => {
      const current = await this.#keyed(entry);
      if (!current) return;
      if (current.kind === 'folder' || current.kind === 'delete' || current.kind === 'move') {
        return this.#write({ ...current, failure });
      }
      if (current.kind === 'rename' || current.kind === 'publish') {
        return this.#write({ ...current, failure, sending: null });
      }
      // Put on top of theirs meanwhile (Save mine on top): sent next, on that.
      const rebased = entry.kind === 'page' && current.basedOn !== entry.basedOn;
      await this.#write({ ...current, failure: rebased ? null : failure, sending: null });
      // Someone changed the page since Publish was pressed: the person looks
      // it over and publishes again, whatever they keep.
      const publish = await this.#publish(current.id);
      if (!rebased && failure.kind === 'conflict' && publish && !publish.failure) {
        await this.#write({ ...publish, failure: PUBLISH_CHANGED, sending: null });
      }
    });
    this.#emit({ kind: 'changed', spaceId: entry.spaceId, id: entry.id });
  }

  /**
   * The drafts waiting here for pages the server has, as `updateIndex` takes
   * a saved draft: on the draft they are based on, as typed (decision 9).
   */
  async drafts(): Promise<SavedVersion[]> {
    return (await this.entries()).flatMap((entry) =>
      entry.kind === 'page' && entry.basedOn
        ? [
            {
              spaceId: entry.spaceId,
              pageId: entry.id,
              basedOn: entry.basedOn,
              revisionId: entry.basedOn,
              payload: entry.payload,
            },
          ]
        : [],
    );
  }

  /**
   * The versions the queue's drafts are based on, by page: the keeper keeps
   * them, with their files, until their change is resolved (decision 3).
   */
  async bases(): Promise<Map<PageId, RevisionId>> {
    const bases = new Map<PageId, RevisionId>();
    for (const entry of await this.entries()) {
      if (entry.kind === 'page' && entry.basedOn) bases.set(entry.id, entry.basedOn);
    }
    return bases;
  }
}

/**
 * The queue as whatever only reads it takes it: what's waiting, the files a
 * change holds, and hearing of changes to it. Writes go through the page writer.
 */
export type QueueReader = Pick<
  OfflineQueue,
  'entries' | 'entry' | 'waiting' | 'drafts' | 'filesHere' | 'subscribe'
>;

/**
 * What the person can choose for a change waiting: send it again, discard
 * it, save it as a new page, or send a rename again on top of theirs.
 */
export type QueueChoices = Pick<
  OfflineQueue,
  'retry' | 'discard' | 'saveAsNewPage' | 'renameOnTop'
>;

/**
 * Why the server refused a send, or null for no answer or no session,
 * which leaves the change to be sent when it answers, or after signing in.
 */
function failureOf(error: unknown): QueueFailure | null {
  // A session that ended waits for the next one, which sends it (decision 10).
  if (noAnswer(error) || (error instanceof ApiError && error.status === 401)) return null;
  const code = error instanceof ApiError || error instanceof CryptoError ? error.code : null;
  if (code === 'stale-head') return { kind: 'conflict' };
  if (code === 'not-found' || code === 'forbidden') return { kind: 'gone' };
  return { kind: 'refused', message: error instanceof Error ? error.message : String(error) };
}

/** The server's refusal, as the person reads it. */
const refused = (error: unknown): QueueFailure => ({
  kind: 'refused',
  message: error instanceof Error ? error.message : String(error),
});

// Why a move or publish made offline stopped, beyond what the server said.
const MOVES_ACROSS: QueueFailure = {
  kind: 'refused',
  message:
    'Moving it there now changes who can read it, so it moves online only. Move it there again once you’re back online.',
};
const PUBLISH_CHANGED: QueueFailure = {
  kind: 'refused',
  message: 'The page changed after you pressed Publish. Look it over, then publish it again.',
};
const LINKED: QueueFailure = {
  kind: 'refused',
  message:
    'It has a public link now, so it’s published online only, where you can check its public copy.',
};

/**
 * Whether `publish` goes before `change`, its page's draft waiting here:
 * when the draft it publishes is on the server already, or when what was
 * typed after Publish waits in the change, not on its way yet. Then the
 * publish sends its own draft first, and the change goes on top of it.
 */
const publishesFirst = (publish: QueuedPublish | undefined, change: QueuedPage): boolean =>
  publish !== undefined &&
  publish.failure === null &&
  (publish.draft === null || (publish.draft.version < change.version && change.sending === null));

/** Where a page or folder made offline goes. */
const parentOf = (entry: QueuedFolder | QueuedPage): FolderId | null =>
  entry.kind === 'folder' ? entry.parentId : (entry.newPage?.parentId ?? null);

/** `later` on top of `earlier`, as saving one rename after the other would leave the folder. */
function mergeChanges(earlier: FolderChanges, later: FolderChanges): FolderChanges {
  const extensions = { ...earlier.extensions, ...later.extensions };
  return { ...earlier, ...later, ...(Object.keys(extensions).length > 0 && { extensions }) };
}

/** Whether `metadata` reads as `changes` ask already. */
function reads(metadata: NodeMetadata, changes: FolderChanges): boolean {
  const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  return (
    (changes.name === undefined || metadata.name === changes.name) &&
    (changes.emoji === undefined || same(metadata.emoji, changes.emoji)) &&
    (changes.tint === undefined || metadata.tint === changes.tint) &&
    Object.entries(changes.extensions ?? {}).every(([key, value]) =>
      same(metadata.extensions[key], value),
    )
  );
}

/** What a folder renamed offline is called and looks like now, on this device. */
export const renamedMetadata = (entry: QueuedRename): NodeMetadata =>
  reviseMetadata({ kind: 'current', metadata: entry.base.metadata }, entry.changes);

type Tree = Awaited<ReturnType<typeof loadTree>>;

/**
 * `tree`, a space's as loaded, with the changes queued for it (decision 7):
 * folders and pages made offline under their parents, marked by their
 * queue entries, pages with a draft saved on this device labelled from
 * it, as their draft is that entry while it waits, folders renamed with
 * their new name and look, pages and folders moved in their new place, and
 * without what was deleted, nor what is in it.
 */
export function withQueued(tree: Tree, spaceId: SpaceId, entries: readonly QueueEntry[]): Tree {
  const here = entries.filter((entry) => entry.spaceId === spaceId);
  if (here.length === 0) return tree;
  const listed = new Set<string>([...tree.folders, ...tree.pages].map((node) => node.id));
  const parents = new Map<string, string | null>(
    [...tree.folders, ...tree.pages].map((node) => [node.id, node.parentId]),
  );
  for (const entry of here) {
    if (madeOffline(entry)) parents.set(entry.id, parentOf(entry));
  }
  // Only one on its way, into a place the tree has: a stopped one shows
  // where the server has it.
  const moved = new Map<string, QueuedMove>();
  for (const entry of here) {
    const { id } = entry;
    if (entry.kind !== 'move' || entry.failure !== null || !listed.has(id)) continue;
    if (entry.parentId !== null && !parents.has(entry.parentId)) continue;
    moved.set(id, entry);
    parents.set(id, entry.parentId);
  }
  // In its new place, and where it goes there: where the person put it, or
  // where the server will, at the end of a folder with an order of its own.
  const placed = <N extends { id: string; parentId: FolderId | null; position: Position | null }>(
    node: N,
  ): N => {
    const move = moved.get(node.id);
    if (!move) return node;
    const position =
      move.position !== undefined
        ? move.position
        : move.parentId === node.parentId
          ? node.position
          : endOf(move.parentId);
    return { ...node, parentId: move.parentId, position };
  };
  const endOf = (parentId: FolderId | null): Position | null => {
    let last: Position | null = null;
    for (const other of [...tree.folders, ...tree.pages]) {
      if (other.parentId === parentId && other.position !== null && !moved.has(other.id)) {
        if (last === null || other.position > last) last = other.position;
      }
    }
    return last && positionBetween(last, null);
  };
  const regionUnder = (parentId: string | null): Region | null => {
    try {
      return regionInTree({
        subject: parentId === null ? { kind: 'space' } : { kind: 'node', nodeId: parentId },
        parentOf: (id) => parents.get(id),
        shares: tree.shares,
      });
    } catch {
      return null;
    }
  };
  const folders: Tree['folders'] = [];
  const pages: Tree['pages'] = [];
  for (const entry of here) {
    if (listed.has(entry.id) || !madeOffline(entry)) continue;
    if (entry.kind === 'folder') {
      const region = regionUnder(entry.parentId);
      if (!region) continue;
      // Made here: by name until the server places it (`placeAtEnd`).
      folders.push({
        id: entry.id,
        parentId: entry.parentId,
        permissionVersion: 0,
        position: null,
        metadata: {
          head: entry.head,
          opened: { kind: 'current', metadata: entry.metadata },
          region,
        },
      });
    } else if (entry.newPage) {
      pages.push({
        id: entry.id,
        parentId: entry.newPage.parentId,
        permissionVersion: 0,
        draftHead: entry.newPage.revisionId,
        publishedHead: null,
        draftChanges: true,
        position: null,
        title: entry.payload.title,
        ...labelCover(entry.payload, 'draft'),
        region: regionUnder(entry.newPage.parentId) ?? OWNER_REGION,
      });
    }
  }
  const drafts = new Map(
    here.flatMap((entry) => (entry.kind === 'page' && !entry.newPage ? [[entry.id, entry]] : [])),
  );
  // Only one on its way: a stopped one waits for the person, and the tree
  // shows what the server has, as theirs in a conflict.
  const renames = new Map(
    here.flatMap((entry) =>
      entry.kind === 'rename' && entry.failure === null ? [[entry.id, entry.changes]] : [],
    ),
  );
  const deleted = new Set<string>(
    here.flatMap((entry) => (entry.kind === 'delete' ? [entry.id] : [])),
  );
  const kept = (id: string | null | undefined): boolean =>
    id == null || (!deleted.has(id) && kept(parents.get(id)));
  return {
    ...tree,
    folders: [
      ...tree.folders.map(placed).map((folder) => {
        const changes = renames.get(folder.id);
        const opened = folder.metadata?.opened;
        if (!changes || !folder.metadata || opened?.kind !== 'current') return folder;
        const metadata = reviseMetadata(opened, changes);
        return {
          ...folder,
          metadata: { ...folder.metadata, opened: { kind: 'current' as const, metadata } },
        };
      }),
      ...folders,
    ].filter((folder) => kept(folder.id)),
    pages: [
      ...tree.pages.map(placed).map((page) => {
        const entry = drafts.get(page.id);
        if (!entry || page.draftHead === null || page.region === null) return page;
        return {
          ...page,
          title: entry.payload.title,
          ...labelCover(entry.payload, 'draft'),
          draftChanges: true,
        };
      }),
      ...pages,
    ].filter((page) => kept(page.id)),
  };
}

/**
 * What opening a page made offline says of it, until it is made: its
 * maker edits it, and its first draft is the one it will be made with.
 * Null for a page made already.
 */
export function queuedPageInfo(entry: QueuedPage): z.output<typeof pageRoutes.PageInfo> | null {
  if (!entry.newPage) return null;
  return {
    pageId: entry.id,
    spaceId: entry.spaceId,
    parentId: entry.newPage.parentId,
    permissionVersion: 0,
    role: 'editor',
    canPublish: false,
    heads: {
      draftHead: entry.newPage.revisionId,
      publishedHead: null,
      publishedCount: 0,
      draftChanges: true,
    },
    agentEdit: null,
    readerHistoryFrom: null,
  };
}

/** The Markdown to copy for a change, as Copy text gives it: its title as a heading, then its text. */
export const changeText = (payload: PagePayload): string =>
  `# ${payload.title}\n\n${payload.markdown}`;
