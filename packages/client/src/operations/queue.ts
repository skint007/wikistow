// Changes made offline (ADR 0009, decision 7): the queue a device keeps of
// them, sealed, and their sending once the server answers.
import {
  FolderId,
  MetadataRevisionId,
  PageId,
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
import { NodeMetadata } from '../metadata.ts';
import { parsePayload, type AttachmentRef, type PagePayload } from '../payload.ts';
import { OWNER_REGION, RegionJson, regionInTree, type Region } from '../regions.ts';
import { resealAttachment, sealAttachment } from '../revision.ts';
import type { ReadWikilinks } from '../link-table.ts';
import {
  attachmentTarget,
  createPage,
  labelCover,
  saveDraft,
  uploadBlob,
  type PageRef,
} from './pages.ts';
import type { ClientContext } from './session.ts';
import { createFolderAs, type loadTree } from './spaces.ts';

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
  failure: Failure.nullable(),
  at: z.number(),
});
export type QueuedFolder = z.output<typeof QueuedFolderJson>;

const QueueEntryJson = z.discriminatedUnion('kind', [QueuedPageJson, QueuedFolderJson]);
export type QueueEntry = QueuedPage | QueuedFolder;

/**
 * What changed in the queue, for whatever shows it: a draft saved into an
 * entry (`saved`), an entry added, gone, or stopped (`changed`), a version
 * about to be sent under its ID (`recorded`), which every session with the
 * page counts as its own, and one that landed (`landed`), which they take
 * as their base.
 */
export type QueueEvent =
  | { kind: 'saved'; entry: QueuedPage }
  | { kind: 'changed'; spaceId: SpaceId; id: PageId | FolderId }
  | { kind: 'recorded'; spaceId: SpaceId; pageId: PageId; revisionId: RevisionId }
  | { kind: 'landed'; spaceId: SpaceId; pageId: PageId; revisionId: RevisionId };

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
 * per page, each sealed like any kept item, with the files added offline,
 * sealed for their page's draft. Entries go to the server in the order
 * made (`send`), each with the IDs it recorded before its request, so an
 * answer lost on the way is told from a change that never landed.
 */
export class OfflineQueue {
  readonly #store: KeptStore;
  readonly #sealer: KeptSealer;
  readonly #listeners = new Set<(event: QueueEvent) => void>();
  #closed = false;
  #last = 0;

  constructor(store: KeptStore, sealer: KeptSealer) {
    this.#store = store;
    this.#sealer = sealer;
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

  #entryName = (id: string) => ENTRY + this.#sealer.name(`queued ${id}`);
  #blobName = (blobHash: string) => BLOB + this.#sealer.name(`queued blob ${blobHash}`);

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
    const name = this.#entryName(entry.id);
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

  /** The entry for a page or folder, or null. */
  entry(id: PageId | FolderId): Promise<QueueEntry | null> {
    return this.#read(this.#entryName(id));
  }

  async #page(pageId: PageId): Promise<QueuedPage | null> {
    const entry = await this.entry(pageId);
    return entry?.kind === 'page' ? entry : null;
  }

  /**
   * Save `payload`, the draft of `page` as typed, on this device. Into the
   * page's entry if it has one, keeping its base, unless the person chose
   * to save theirs on top of someone else's after a conflict: then `basedOn`.
   * Otherwise a new entry on top of `basedOn`. `seen` is the entry's version
   * the caller last saw: an entry another tab or window saved into since is
   * a conflict (`stale-head`), as the server would answer. Returns the
   * entry's version now.
   */
  async saveDraft({
    page,
    basedOn,
    region,
    payload,
    seen,
  }: {
    page: PageRef;
    basedOn: RevisionId;
    region: Region | null;
    payload: PagePayload;
    seen: number | null;
  }): Promise<number> {
    const { entry, made } = await this.#store.queueExclusive(async () => {
      const before = await this.#page(page.pageId);
      if (before && seen !== null && before.version !== seen) {
        throw new ApiError(409, 'stale-head', 'This page was changed in another window');
      }
      const rebased = before?.failure?.kind === 'conflict' && before.basedOn !== basedOn;
      const entry: QueuedPage = before
        ? {
            ...before,
            payload,
            version: before.version + 1,
            ...(rebased && { basedOn, failure: null }),
          }
        : {
            kind: 'page',
            id: page.pageId,
            spaceId: page.spaceId,
            newPage: null,
            basedOn,
            region,
            payload,
            version: 1,
            sending: null,
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
  }: {
    page: PageRef;
    basedOn: RevisionId;
    region: Region | null;
    payload: PagePayload;
    revisionId: RevisionId;
  }): Promise<number> {
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
        version: 1,
        sending: { revisionId, version: 1, payload, partial: false },
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
   * or are `pageId` and `revisionId`, as for one whose request got no answer.
   */
  async newPage({
    spaceId,
    parentId,
    payload,
    pageId = newId(PageId),
    revisionId = newId(RevisionId),
  }: {
    spaceId: SpaceId;
    parentId: FolderId | null;
    payload: PagePayload;
    pageId?: PageId;
    revisionId?: RevisionId;
  }): Promise<QueuedPage> {
    const entry: QueuedPage = {
      kind: 'page',
      id: pageId,
      spaceId,
      newPage: { parentId, revisionId },
      basedOn: null,
      region: null,
      payload,
      version: 1,
      sending: null,
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
  }: {
    spaceId: SpaceId;
    parentId: FolderId | null;
    metadata: NodeMetadata;
    folderId?: FolderId;
  }): Promise<QueuedFolder> {
    const entry: QueuedFolder = {
      kind: 'folder',
      id: folderId,
      spaceId,
      parentId,
      metadata,
      head: newId(MetadataRevisionId),
      failure: null,
      at: this.#at(),
    };
    await this.#store.queueExclusive(() => this.#write(entry));
    this.#emit({ kind: 'changed', spaceId, id: folderId });
    return entry;
  }

  /**
   * A file added to `page`'s draft offline: sealed for the draft now (protocol
   * section 5.3), and kept here until a save naming it lands.
   */
  async attach(
    ctx: ClientContext,
    page: PageRef,
    file: { name: string; mediaType: string; bytes: Uint8Array },
  ): Promise<AttachmentRef> {
    const { ref, blob } = sealAttachment({ target: attachmentTarget(ctx, page, 'draft'), ...file });
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
   * Delete `entry`, and the files it names that no other entry does. Only
   * from within `queueExclusive`.
   */
  async #remove(entry: QueueEntry) {
    const names = [this.#entryName(entry.id)];
    if (entry.kind === 'page') {
      const others = (await this.entries()).filter((other) => other.id !== entry.id);
      const files = (page: QueuedPage) =>
        [...page.payload.attachments, ...(page.sending?.payload.attachments ?? [])].map(
          (ref) => ref.blobHash,
        );
      const named = new Set(others.flatMap((other) => (other.kind === 'page' ? files(other) : [])));
      for (const blobHash of new Set(files(entry))) {
        if (!named.has(blobHash)) names.push(this.#blobName(blobHash));
      }
    }
    await this.#store.queue.remove(names);
  }

  /** Forget a change, as the person chose. */
  async discard(id: PageId | FolderId): Promise<void> {
    const entry = await this.#store.queueExclusive(async () => {
      const entry = await this.entry(id);
      if (entry) await this.#remove(entry);
      return entry;
    });
    if (entry) this.#emit({ kind: 'changed', spaceId: entry.spaceId, id });
  }

  /** Send a stopped change again at the next `send`, as for a page restored from the trash. */
  async retry(id: PageId | FolderId): Promise<void> {
    const entry = await this.#store.queueExclusive(async () => {
      const entry = await this.entry(id);
      if (entry?.failure) await this.#write({ ...entry, failure: null });
      return entry;
    });
    if (entry) this.#emit({ kind: 'changed', spaceId: entry.spaceId, id });
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
    await this.discard(id);
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
      let next: QueueEntry | undefined;
      for (const entry of entries) {
        if (entry.failure) continue;
        const parentId = entry.kind === 'folder' ? entry.parentId : entry.newPage?.parentId;
        const parent = parentId ? folders.get(parentId) : undefined;
        if (parent?.failure?.kind === 'gone') {
          await this.#stop(entry, { kind: 'gone' });
          continue;
        }
        if (parent) continue;
        next = entry;
        break;
      }
      if (!next) return 'sent';
      const sent =
        next.kind === 'folder'
          ? await this.#sendFolder(ctx, next, entries)
          : await this.#sendPage(ctx, next, read);
      if (sent === 'offline') return 'offline';
    }
    return 'sent';
  }

  async #sendFolder(
    ctx: ClientContext,
    entry: QueuedFolder,
    entries: readonly QueueEntry[],
  ): Promise<'offline' | void> {
    const { id: folderId, spaceId, parentId, metadata } = entry;
    try {
      await createFolderAs(ctx, { spaceId, parentId, folderId, metadata });
    } catch (error) {
      if (!(error instanceof ApiError && error.code === 'duplicate')) {
        const failure = failureOf(error);
        if (!failure) return 'offline';
        // An empty folder made offline whose parent is gone just goes.
        const holds = entries.some(
          (other) =>
            other.id !== entry.id &&
            (other.kind === 'folder' ? other.parentId : other.newPage?.parentId) === entry.id,
        );
        if (failure.kind === 'gone' && !holds) return this.discard(folderId);
        return this.#stop(entry, failure);
      }
    }
    await this.discard(folderId);
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
        });
      } else if (entry.basedOn) {
        // Uploads are staged for a day: those of the files added offline go
        // up again before each save that names them.
        for (const ref of attempt.payload.attachments) {
          const blob = await this.blob(ref.blobHash);
          if (blob) await uploadBlob(ctx, page, 'draft', blob);
        }
        await saveDraft(ctx, {
          page,
          basedOn: entry.basedOn,
          payload: attempt.payload,
          revisionId: attempt.revisionId,
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
      const current = await this.#page(entry.id);
      if (!current) return;
      if (current.version === sent.version && !sent.partial) return this.#remove(current);
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
      const current = await this.entry(entry.id);
      if (!current) return;
      await this.#write(
        current.kind === 'page' ? { ...current, failure, sending: null } : { ...current, failure },
      );
    });
    this.#emit({ kind: 'changed', spaceId: entry.spaceId, id: entry.id });
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
 * Why the server refused a send, or null for no answer, which leaves the
 * change to be sent when it answers.
 */
function failureOf(error: unknown): QueueFailure | null {
  if (noAnswer(error)) return null;
  const code = error instanceof ApiError || error instanceof CryptoError ? error.code : null;
  if (code === 'stale-head') return { kind: 'conflict' };
  if (code === 'not-found' || code === 'forbidden') return { kind: 'gone' };
  return { kind: 'refused', message: error instanceof Error ? error.message : String(error) };
}

type Tree = Awaited<ReturnType<typeof loadTree>>;

/**
 * `tree`, a space's as loaded, with the changes queued for it (decision 7):
 * folders and pages made offline under their parents, marked by their
 * queue entries, and pages with a draft saved on this device labelled from
 * it, as their draft is that entry while it waits.
 */
export function withQueued(tree: Tree, spaceId: SpaceId, entries: readonly QueueEntry[]): Tree {
  const here = entries.filter((entry) => entry.spaceId === spaceId);
  if (here.length === 0) return tree;
  const listed = new Set<string>([...tree.folders, ...tree.pages].map((node) => node.id));
  const parents = new Map<string, string | null>(
    [...tree.folders, ...tree.pages].map((node) => [node.id, node.parentId]),
  );
  for (const entry of here) {
    if (entry.kind === 'folder') parents.set(entry.id, entry.parentId);
  }
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
    if (listed.has(entry.id)) continue;
    if (entry.kind === 'folder') {
      const region = regionUnder(entry.parentId);
      if (!region) continue;
      folders.push({
        id: entry.id,
        parentId: entry.parentId,
        permissionVersion: 0,
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
        title: entry.payload.title,
        ...labelCover(entry.payload, 'draft'),
        region: regionUnder(entry.newPage.parentId) ?? OWNER_REGION,
      });
    }
  }
  const drafts = new Map(
    here.flatMap((entry) => (entry.kind === 'page' && !entry.newPage ? [[entry.id, entry]] : [])),
  );
  return {
    ...tree,
    folders: [...tree.folders, ...folders],
    pages: [
      ...tree.pages.map((page) => {
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
    ],
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
