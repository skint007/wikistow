import {
  checkPayloadSize,
  linksInUse,
  linkTableOf,
  PageTooLarge,
  revisePayload,
  splitFrontmatter,
  withoutLiveState,
  type AttachmentRef,
  type LinkTree,
  type PageId,
  type pageOperations,
  type PagePayload,
  type PayloadChanges,
  type ReadWikilinks,
  type Region,
  type RevisionId,
  type WaitingChange,
  withoutLinkTable,
} from '@wikistow/client';
import { ApiError } from '@wikistow/client/api';
import type {
  LiveParticipant,
  NotJoined,
  OpenedNote,
  ParticipantState,
  ParticipantStatus,
} from '@wikistow/client/live';
import { pageMerge } from '@wikistow/client';
import { ATTACHMENT_SCHEME } from './attachments';
import { Autosave, type SaveStatus } from './autosave';
import { lineBreakOf, type EditorSurfaceHandle, type MarkdownParts } from './editor/surface';
import { joinPage } from './properties';
import { uploadMessage } from './messages';

// Extensions a save works out or drops, which a live session's document never holds.
const UNHELD = new Set(['wikistow.live', 'wikistow.links', 'wikistow.change', 'wikistow.overlaps']);

/** `extensions` without those the document never holds, as edits made outside a session keep them. */
const held = (extensions: PagePayload['extensions']): PagePayload['extensions'] =>
  Object.fromEntries(Object.entries(extensions).filter(([namespace]) => !UNHELD.has(namespace)));

/**
 * `extensions`, the document's, as changes to `base`'s: each namespace
 * `base` has that they don't, but those the document never holds, is
 * deleted (`undefined`), as a change made outside a session deletes one.
 */
function over(
  base: PagePayload['extensions'],
  extensions: PagePayload['extensions'],
): PagePayload['extensions'] {
  const changes: Record<string, unknown> = { ...extensions };
  for (const namespace of Object.keys(base)) {
    if (!UNHELD.has(namespace) && !Object.hasOwn(extensions, namespace)) {
      changes[namespace] = undefined;
    }
  }
  return changes as PagePayload['extensions'];
}

/** Saving stopped at a conflict: someone else saved this draft meanwhile. */
export class DraftConflict extends Error {
  constructor() {
    super('Someone else changed this draft. Choose which to keep first.');
    this.name = 'DraftConflict';
  }
}

/** What a draft session reaches outside itself: the app's own, or fakes in tests. */
export type DraftPorts = {
  saveDraft(
    input: Omit<Parameters<typeof pageOperations.saveDraft>[1], 'page'>,
  ): Promise<pageOperations.Written>;
  uploadAttachment(file: {
    name: string;
    mediaType: string;
    bytes: Uint8Array;
  }): Promise<AttachmentRef>;
  /** The page's draft head as the server has it now. */
  draftHead(): Promise<RevisionId | null>;
  /** The person chose to save theirs on top of `revisionId` (Save mine on top). */
  onTopOf?(revisionId: RevisionId): void;
  /** The page's draft change waiting on this device, as another window may have saved it. */
  waitingChange?(): Promise<WaitingChange | null>;
  /** A merge with the waiting change at `version` is saved next (`DraftWriter.mergedWith`). */
  mergedWith?(version: number): void;
  /** The revision cache's generation; a region opened in an earlier one may be stale. */
  generation(): number;
  /** The vault's epoch, which a lock moves on. */
  epoch(): number;
  /** The space's tree on screen, which the link table is worked out from, if it's loaded. */
  tree(): LinkTree | undefined;
  /**
   * The pages a link in this draft, titled `title`, may name in its table
   * (`draftLinkTargets`), or null until the tree loads.
   */
  linkTargets(title: string): ReadonlySet<PageId> | null;
  /**
   * A save landed, with the vault still unlocked since it started: show the
   * version saved (its title, emoji and region) as the page's, and load the
   * page's heads again. `written` is what the server holds (links renamed),
   * and `basedOn` the version saved over.
   */
  saved(saved: {
    revisionId: RevisionId;
    basedOn: RevisionId;
    written: PagePayload;
    region: Region;
  }): Promise<void>;
  /** Someone else saved first: load their draft, so the conflict prompt knows it. */
  overtaken(): void;
  /** How the draft's wikilinks are read as it opens, off the page's thread (`linksInUse`). */
  readLinks: ReadWikilinks;
  /** Editing live with the others who have the draft open (ADR 0015), where this app may. */
  live?: LivePorts;
};

/** How a draft session joins the page's live session. */
export type LivePorts = {
  /**
   * Whether this app may join now: online, not an agent, and in the browser
   * only over HTTP/2 or later (ADR 0015 decision 10).
   */
  allowed(): boolean;
  /** Join the session from the draft opened (`joinLive`); its stream isn't open yet. */
  join(opening: {
    revisionId: RevisionId;
    payload: PagePayload;
    region: Region;
  }): Promise<LiveParticipant | NotJoined>;
  /** Hear of changes that may change access to the page: marks, keys, owners, the tree. */
  watch?(participant: LiveParticipant): () => void;
  /** Run `run` now if the page is visible, else once it is shown; the result stops waiting. */
  whenVisible?(run: () => void): () => void;
};

/** The live session as the draft view shows it. */
export type LiveShown =
  | { kind: 'live'; status: ParticipantStatus }
  /** Not in one, and why: shown only when it is worth saying. */
  | { kind: 'not-joined'; why: NotJoined }
  /** It left one, and why. */
  | { kind: 'left'; why: string };

/**
 * What a merge was saved on top of: a draft, opened in `region`, or another
 * window's change waiting on this device, as `windowMergeVersions` read it.
 */
export type MergedOver =
  | { kind: 'draft'; revisionId: RevisionId; region: Region }
  | ({ kind: 'window' } & WaitingChange);

/** What the draft view shows. A new object whenever any of it changes. */
export type DraftSnapshot = {
  status: SaveStatus;
  title: string;
  markdown: string;
  attachments: readonly AttachmentRef[];
  /**
   * The link table the next save starts from, key → page: the one the last
   * save wrote, and this session's picks that it will keep.
   */
  links: ReadonlyMap<string, string>;
  uploading: boolean;
  uploadError: string | null;
  /** Why the last save was refused as too large (`PageTooLarge`); null once one ends otherwise. */
  tooLarge: string | null;
  /** What refused the save that stopped saving, while `status` is `'error'`. */
  saveError: unknown;
  /** The page's live session, while this session is in one or once it left one. */
  live: LiveShown | null;
};

type Content = Pick<PagePayload, 'title' | 'markdown' | 'attachments'>;

/**
 * One person editing one draft, whichever editor surface is on screen.
 * Edits are saved as encrypted drafts shortly after typing stops. Every
 * save names the draft it was based on, so a change made elsewhere in the
 * meantime is a conflict, never an overwrite.
 *
 * It tracks the draft its next save builds on itself, so its own saves
 * never reload the text being typed; a newer draft from anywhere else
 * (`noticeHead`) stops saving until the person chooses what to keep.
 */
export class DraftSession {
  readonly #ports: DraftPorts;
  readonly #surface: { readonly current: EditorSurfaceHandle | null };
  readonly #autosave: Autosave<() => PagePayload>;
  // The draft the next save builds on, every draft this session has seen as
  // its own (the one it opened and those it saved), and the newer draft
  // someone else saved, once a conflict shows it.
  #base: RevisionId;
  readonly #known: Set<RevisionId>;
  #theirs: RevisionId | null = null;
  #saving = false;
  #region: { region: Region; generation: number } | null = null;
  // The version the next save revises, the region its link table was worked
  // out for, and what this session changes in it.
  #payload: PagePayload;
  // Its table cut to what its links use, as it opens or saves first, which
  // saving waits for; done once it has.
  #trimming: Promise<void> | 'done' | null = null;
  #tableRegion: Region;
  #content: Content;
  #extensions: PagePayload['extensions'] = {};
  // Another window's change a merge was saved over, until a save lands: what
  // a merge with that window's next change compares against, as the merged
  // text grew from it (ADR 0013, decision 7). Until then, `#payload` is.
  #windowBase: PagePayload | null = null;
  readonly #picks = new Map<string, PageId>();
  // Work still uploading, which saving waits for: files attached here, which
  // the draft shows as uploading, and any other (`track`). And whether the
  // draft is still on screen to take them.
  readonly #uploads = new Set<Promise<void>>();
  #attaching = 0;
  #live = true;
  // The surface has an edit it hasn't reported yet, as a visual one's comes
  // late: the draft shows as unsaved until it does.
  #unreported = false;
  #snapshot: DraftSnapshot;
  readonly #listeners = new Set<() => void>();

  constructor(
    /**
     * The draft as opened, and the region it was opened in. With `theirs`,
     * the draft someone else saved over `base` meanwhile, `payload` is an
     * edit not saved over it, as a change made offline that came back as a
     * conflict (ADR 0009, decision 7): the session opens stopped at it.
     */
    opened: { base: RevisionId; payload: PagePayload; region: Region; theirs?: RevisionId | null },
    ports: DraftPorts,
    surface: { readonly current: EditorSurfaceHandle | null },
    timing?: { debounceMs: number; maxWaitMs: number },
  ) {
    this.#ports = ports;
    this.#surface = surface;
    this.#base = opened.base;
    this.#known = new Set([opened.base]);
    this.#payload = opened.payload;
    this.#tableRegion = opened.region;
    const { title, markdown, attachments } = opened.payload;
    this.#content = { title, markdown, attachments };
    this.#autosave = new Autosave(
      async (build) => {
        if (this.#settling) await this.#settling;
        const trimming = this.#trim();
        if (trimming) await trimming;
        return this.#save(build());
      },
      (status, saveError) => {
        // In a live session, the session's saver saves (ADR 0015 decision 5).
        if (this.#participant) return;
        this.#set({ status: this.#shown(status), saveError });
        // Saved outside a session: join one, so saves from here aren't someone else's to it.
        if (status === 'saved') this.#joinSoon();
      },
      timing,
    );
    this.#snapshot = {
      status: 'saved',
      ...this.#content,
      links: linkTableOf(this.#payload),
      uploading: false,
      uploadError: null,
      tooLarge: null,
      saveError: undefined,
      live: null,
    };
    if (opened.theirs) {
      this.#theirs = opened.theirs;
      this.#autosave.hold(() => this.#current());
    }
  }

  /**
   * Cut the table to what the draft's links use, no old key a rename kept,
   * once: as it opens (`open`), or before its first save. A session React
   * makes and drops reads nothing.
   */
  #trim(): Promise<void> | null {
    if (this.#trimming === 'done') return null;
    const trimmed = this.#payload;
    this.#trimming ??= linksInUse(trimmed, this.#ports.readLinks).then((inUse) => {
      this.#trimming = 'done';
      // A merge saved meanwhile replaced the payload whole.
      if (this.#payload === trimmed) this.#payload = inUse;
      this.#set({ links: this.#table() });
    });
    return this.#trimming;
  }

  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => void this.#listeners.delete(listener);
  };

  snapshot = (): DraftSnapshot => this.#snapshot;

  #shown(status: SaveStatus): SaveStatus {
    return status === 'saved' && this.#unreported ? 'pending' : status;
  }

  #set(changes: Partial<DraftSnapshot>) {
    this.#snapshot = { ...this.#snapshot, ...changes };
    for (const listener of this.#listeners) listener();
  }

  /** The payload the next save writes: in a live session, the shared document's. */
  #current(): PagePayload {
    if (this.#participant) {
      try {
        return this.#participant.currentPayload();
      } catch {
        // A value the document refused as it was placed: the session leaves.
      }
    }
    // Outside a session, a save never carries what a session draft said it held.
    return withoutLiveState(
      revisePayload(
        { kind: 'current', payload: this.#payload },
        { ...this.#content, extensions: this.#extensions },
      ),
    );
  }

  // A save builds its payload when it runs, not when it's asked for: a save
  // landing before it may change the table and the region it was worked out
  // for, and the two must go together.
  #schedule() {
    this.#autosave.schedule(() => this.#current());
  }

  #change(changes: Partial<Content>) {
    this.#content = { ...this.#content, ...changes };
    this.#set(changes);
    this.#schedule();
  }

  /** The surface's text, if it holds an edit it hasn't reported yet. */
  #pull() {
    const surface = this.#surface.current;
    // In a live session, the parts as the editor holds them, never split again.
    const parts = this.#participant ? surface?.parts?.() : undefined;
    if (parts) return this.editParts(parts);
    const markdown = surface?.read();
    if (markdown !== undefined) this.edit(markdown);
  }

  /**
   * The page editor's frontmatter and body after the person edited them:
   * in a live session, each into its own part of the shared document as
   * the smallest change, as the editor holds them, so body text that reads
   * like frontmatter stays in the body.
   */
  editParts({ frontmatter, body }: MarkdownParts) {
    const participant = this.#participant;
    if (!participant) return this.edit(joinPage(frontmatter, body));
    this.#unreported = false;
    participant.change({ texts: { frontmatter: frontmatter ?? '', body } });
  }

  setTitle(title: string) {
    if (this.#participant) return this.#participant.change({ texts: { title } });
    this.#change({ title });
  }

  /**
   * The draft this session opened or last saved, when everything shown is
   * in it: null while an edit waits to be saved, is saving, or conflicts.
   */
  savedRevision(): RevisionId | null {
    this.#pull();
    if (this.#participant) {
      const status = this.#participant.status();
      return status.saved ? status.head : null;
    }
    return this.#snapshot.status === 'saved' && !this.#saving ? this.#base : null;
  }

  /** The surface's text after the person edited it. */
  edit(markdown: string) {
    this.#unreported = false;
    if (this.#participant) {
      // Into the shared document, as the smallest change to each part: the
      // parts as the page editor holds them, never split again, so body text
      // that reads like frontmatter stays in the body.
      const held = this.#surface.current?.parts?.();
      const parts = held && joinPage(held.frontmatter, held.body) === markdown ? held : null;
      const { frontmatter, body } = parts ?? splitFrontmatter(markdown);
      return this.#participant.change({ texts: { frontmatter: frontmatter ?? '', body } });
    }
    if (markdown !== this.#content.markdown) this.#change({ markdown });
    // Text the draft already has, as an edit undone or already read, changes nothing.
    else if (this.#snapshot.status !== this.#autosave.status)
      this.#set({ status: this.#autosave.status });
  }

  /** The person edited in the surface, which will report the text later. */
  editing() {
    this.#unreported = true;
    if (this.#snapshot.status === 'saved') this.#set({ status: 'pending' });
  }

  /**
   * Change the draft from outside the surface, as the cover pickers do,
   * given the draft as it is now. It saves with the rest. `extensions`
   * replaces only the namespaces it names.
   */
  revise(changes: (current: PagePayload) => PayloadChanges) {
    this.#pull();
    if (this.#participant) return this.#reviseLive(changes(this.#current()));
    const { extensions, ...content } = changes(this.#current());
    if (extensions) this.#extensions = { ...this.#extensions, ...extensions };
    if (content.markdown !== undefined && content.markdown !== this.#content.markdown)
      this.#surface.current?.replace(content.markdown);
    this.#change(content);
  }

  /**
   * In a live session, a change made on an older draft, whose payload was
   * `base`, merged by block from it into the page as it is now, as the
   * person's change (ADR 0015 decision 8). False, changing nothing, where
   * it overlaps what changed since.
   */
  reviseFrom(base: PagePayload, changes: PayloadChanges): boolean {
    if (!this.#participant) return false;
    this.#pull();
    const current = this.#current();
    const strip = (payload: PagePayload) => ({ ...payload, extensions: held(payload.extensions) });
    const yours = revisePayload({ kind: 'current', payload: base }, changes);
    const merge = pageMerge.mergePayloads(strip(base), strip(yours), strip(current));
    if (merge.overlaps.length > 0) return false;
    const resolved = pageMerge.resolve(merge, {});
    if (!resolved.ok) return false;
    const { title, markdown, attachments } = resolved.payload;
    this.#reviseLive({
      title,
      markdown,
      attachments,
      extensions: over(current.extensions, held(resolved.payload.extensions)),
    });
    return true;
  }

  removeAttachment(id: string) {
    if (this.#participant) {
      return this.#participant.change({ entries: [{ root: 'attachments', key: id, value: null }] });
    }
    this.#change({ attachments: this.#content.attachments.filter((a) => a.id !== id) });
  }

  /** The pages a link in this draft may name, as it's titled now; null until the tree loads. */
  linkTargets(): ReadonlySet<PageId> | null {
    return this.#ports.linkTargets(this.#content.title);
  }

  /**
   * Links written `key` mean this page, from the next save on, if a link in
   * this draft may name it. Returns whether the pick is recorded: one that
   * saving would refuse isn't, and the link's earlier entry stays.
   */
  chooseLink(key: string, pageId: PageId): boolean {
    if (!this.linkTargets()?.has(pageId)) return false;
    this.#picks.set(key, pageId);
    this.#participant?.change({
      entries: [{ root: 'links', key, value: JSON.stringify(pageId) }],
    });
    this.#set({ links: this.#table() });
    // In a live session, the session's saver saves it.
    if (!this.#participant) this.#schedule();
    return true;
  }

  // The table the last save wrote, and the picks it will keep. Every pick
  // is sent with every save; one the audience rule refuses there leaves the
  // link's entry as it was.
  #table(): ReadonlyMap<string, string> {
    const allowed = this.linkTargets();
    const holding = [...this.#picks].filter(([, pageId]) => allowed?.has(pageId));
    const saved = this.#participant?.headPayload ?? this.#payload;
    const table = new Map<string, string>([...linkTableOf(saved), ...holding]);
    const shown = this.#snapshot.links;
    const same = shown.size === table.size && [...table].every(([k, v]) => shown.get(k) === v);
    return same ? shown : table;
  }

  async #save(next: PagePayload) {
    this.#saving = true;
    const epoch = this.#ports.epoch();
    const generation = this.#ports.generation();
    const previous = this.#region;
    const tree = this.#ports.tree();
    const basedOn = this.#base;
    let saved: {
      revisionId: RevisionId;
      basedOn: RevisionId;
      written: PagePayload;
      region: Region;
    };
    try {
      const {
        revisionId,
        region,
        payload: written,
        inUse,
      } = await this.#ports.saveDraft({
        basedOn,
        ...(previous?.generation === generation ? { basedOnRegion: previous.region } : {}),
        tableRegion: this.#tableRegion,
        payload: next,
        ...(tree ? { tree } : {}),
        ...(this.#picks.size > 0 ? { linkChoices: new Map(this.#picks) } : {}),
      });
      saved = { revisionId, basedOn, written, region };
      this.#known.add(revisionId);
      this.#windowBase = null;
      // A save into this device's queue keeps its base, and one sent from
      // there may have landed meanwhile (`landed`): that one stays the base.
      if (this.#base === basedOn) {
        this.#base = revisionId;
        this.#region = { region, generation };
      }
      // A link may now name its page's current title. Show it, unless the
      // person typed on meanwhile: then the next save builds on the table
      // that went with the text on screen, and renames it again.
      this.#pull();
      const renamed = written.markdown !== next.markdown;
      const shown = !renamed || this.#content.markdown === next.markdown;
      this.#payload = shown ? inUse : next;
      if (shown) this.#tableRegion = region;
      if (renamed && shown && this.#live) {
        this.#surface.current?.replace(written.markdown);
        this.#content = { ...this.#content, markdown: written.markdown };
      }

      this.#set({ markdown: this.#content.markdown, links: this.#table(), tooLarge: null });
    } catch (error) {
      if (error instanceof ApiError && error.code === 'stale-head') this.#ports.overtaken();
      this.#set({ tooLarge: error instanceof PageTooLarge ? error.message : null });
      throw error;
    } finally {
      this.#saving = false;
    }
    if (this.#ports.epoch() === epoch) await this.#ports.saved(saved);
  }

  /** Save what's typed now, without waiting for files still uploading. */
  async flushSaves() {
    this.#pull();
    if (this.#participant) {
      await this.#participant.saveNow();
      return;
    }
    await this.#autosave.flush();
  }

  /** Save everything outstanding, including files still uploading once they're added. */
  async flush() {
    await Promise.all(this.#uploads);
    await this.flushSaves();
  }

  /**
   * `flush`, and throw if anything is still unsaved, so callers don't move on.
   * A conflict is named first: any edit it holds back can't save until the
   * person chooses which draft to keep. A save that failed otherwise keeps
   * its edit, so it is caught as unsaved.
   */
  async saveOrThrow() {
    await this.flush();
    if (this.#participant) {
      if (this.#participant.status().saved) return;
      const { tooLarge } = this.#participant.status();
      throw new Error(
        tooLarge ? `${tooLarge} Make it shorter first.` : 'The draft could not be saved',
      );
    }
    if (this.#autosave.status === 'conflict') throw new DraftConflict();
    const { status, tooLarge } = this.#snapshot;
    if (this.#autosave.unsaved() !== null)
      throw new Error(
        status === 'too-large' && tooLarge
          ? `${tooLarge} Make it shorter first.`
          : 'The draft could not be saved',
      );
  }

  /** The page's draft head as last loaded: one this session didn't make means someone else saved. */
  noticeHead(head: RevisionId | null) {
    // In a live session, the session's stream says what the head is.
    if (this.#participant) return;
    // A save in flight may already be the head before its answer arrives.
    if (!head || this.#known.has(head) || this.#saving) return;
    this.#theirs = head;
    this.#autosave.conflict();
  }

  hasUnsaved() {
    if (this.#settling) return true;
    if (this.#participant) return this.#unreported || !this.#participant.status().saved;
    return this.#unreported || this.#autosave.unsaved() !== null;
  }

  /**
   * `revisionId`, a version of this draft sent from this device's queue, is
   * this session's own: the page's head naming it isn't a conflict.
   */
  own(revisionId: RevisionId) {
    this.#known.add(revisionId);
  }

  /**
   * `revisionId`, sent from this device's queue, landed: the next save goes
   * on top of it, as after one of this session's own, its region opened afresh.
   */
  landed(revisionId: RevisionId) {
    this.#known.add(revisionId);
    this.#base = revisionId;
    this.#region = null;
    // The change waiting on this device is sent: the session can be joined now.
    this.#joinTries = 0;
    this.#joinSoon();
  }

  /** A save is waiting for its answer, or a file is still uploading. */
  isBusy() {
    if (this.#settling) return true;
    if (this.#participant) return !this.#participant.status().saved || this.#uploads.size > 0;
    return this.#autosave.isSaving() || this.#uploads.size > 0;
  }

  isUploading() {
    return this.#uploads.size > 0;
  }

  /** After a failed save: try again on the same draft, so a newer one is still a conflict. */
  async retry() {
    this.#autosave.resume();
    this.#schedule();
    await this.#autosave.flush();
  }

  /** Keep what's on screen, saved on top of the newer draft the prompt was about. */
  async saveMineOnTop() {
    const target = this.#theirs ?? (await this.#ports.draftHead());
    if (target) {
      this.#base = target;
      this.#known.add(target);
      this.#ports.onTopOf?.(target);
    }
    // Their draft may be in another region by now: open it fresh.
    this.#region = null;
    this.#theirs = null;
    this.#autosave.resume();
    this.#schedule();
    await this.#autosave.flush();
  }

  /**
   * What a merge of the conflict on screen reads (ADR 0013, decision 2):
   * the draft this session's text is based on, the newer draft the prompt
   * is about, and the person's own, unsaved text included. Null when there
   * is no newer draft to merge with.
   */
  async mergeVersions(): Promise<{
    base: RevisionId;
    theirs: RevisionId;
    yours: PagePayload;
  } | null> {
    // A file still uploading goes in first, so the merge has it.
    await Promise.all(this.#uploads);
    this.#pull();
    const base = this.#base;
    const theirs = this.#theirs ?? (await this.#ports.draftHead());
    return theirs && theirs !== base ? { base, theirs, yours: this.#current() } : null;
  }

  /**
   * What a merge with another window's change reads, when the conflict on
   * screen is with that change (ADR 0013, decision 2): the payload both
   * windows' text grew from, as this session last saved or opened it, the
   * person's own, and theirs: the change as it waits now, or, once it was
   * sent, the draft it landed as, which this session builds on since.
   */
  async windowMergeVersions(): Promise<{
    base: PagePayload;
    theirs: ({ kind: 'window' } & WaitingChange) | { kind: 'draft'; revisionId: RevisionId };
    yours: PagePayload;
  }> {
    await Promise.all(this.#uploads);
    this.#pull();
    const change = await this.#ports.waitingChange?.();
    return {
      base: this.#windowBase ?? this.#payload,
      theirs: change ? { kind: 'window', ...change } : { kind: 'draft', revisionId: this.#base },
      yours: this.#current(),
    };
  }

  /**
   * Save `merged`, a merge the person reviewed, on top of what the merge
   * read as theirs (ADR 0013, decision 7): a draft, which was opened in its
   * region, or another window's change waiting on this device. The whole
   * payload is taken, not only its text, so theirs' banner or data isn't
   * put back to the base's. If someone saved again meanwhile, it stops at
   * the conflict as usual, with theirs as read the base.
   */
  async saveMerged(over: MergedOver, merged: PagePayload) {
    this.#payload = merged;
    this.#extensions = {};
    const { title, markdown, attachments } = merged;
    this.#content = { title, markdown, attachments };
    this.#unreported = false;
    if (this.#live) this.#surface.current?.replace(markdown);
    if (over.kind === 'draft') {
      this.#tableRegion = over.region;
      this.#base = over.revisionId;
      this.#known.add(over.revisionId);
      this.#ports.onTopOf?.(over.revisionId);
    } else {
      // Into that change, at the version read. Its base stays its own, and
      // the draft it stands for is this session's too.
      if (over.head) this.#known.add(over.head);
      this.#windowBase = over.payload;
      this.#ports.mergedWith?.(over.version);
    }
    this.#region = null;
    this.#theirs = null;
    this.#set({ title, markdown, attachments, links: this.#table() });
    this.#autosave.resume();
    this.#schedule();
    await this.#autosave.flush();
  }

  /**
   * Upload `files` as attachments of the page, then `place` their links in
   * the text: by default, or if `place` can't, after everything else, each
   * its own paragraph.
   */
  attach(files: readonly File[], place?: (links: string[]) => boolean) {
    if (files.length === 0) return;
    this.#attaching += 1;
    this.#set({ uploading: true, uploadError: null });
    this.track(
      this.#addFiles(files, (links) => {
        if (!place?.(links)) this.#append(links);
      }).finally(() => {
        this.#attaching -= 1;
        this.#set({ uploading: this.#attaching > 0 });
      }),
    );
  }

  /**
   * Refuse (`PageTooLarge`) a draft too large to save as it is typed now:
   * before a file is uploaded for it, as one saved larger than the limit,
   * before it, can't take one.
   */
  checkSize(changes: PayloadChanges = {}) {
    this.#pull();
    const current = this.#current();
    const next = revisePayload({ kind: 'current', payload: current }, changes);
    checkPayloadSize(withoutLinkTable(next));
  }

  /** Count `work` as an upload in progress, which saves and leaving wait for: a banner image, say. */
  track(work: Promise<unknown>) {
    const upload: Promise<void> = Promise.allSettled([work]).then(() => {
      this.#uploads.delete(upload);
    });
    this.#uploads.add(upload);
  }

  async #addFiles(files: readonly File[], place: (links: string[]) => void) {
    // An upload that outlives the editor, or the keys, adds nothing: there is
    // no draft on screen to add it to, and no keys to save one with.
    const epoch = this.#ports.epoch();
    const live = () => this.#live && this.#ports.epoch() === epoch;
    try {
      this.checkSize();
      const added: AttachmentRef[] = [];
      for (const file of files) {
        added.push(
          await this.#ports.uploadAttachment({
            name: file.name,
            mediaType: file.type || 'application/octet-stream',
            bytes: new Uint8Array(await file.arrayBuffer()),
          }),
        );
      }
      if (!live()) return;
      if (this.#participant) {
        // Its uploader's own save commits the file; only then does it go to the others.
        const committed = await this.#participant.commitOwn({
          entries: added.map((ref) => ({
            root: 'attachments' as const,
            key: ref.id,
            value: JSON.stringify(ref),
          })),
        });
        if (!committed) {
          this.#set({ uploadError: 'The file couldn’t be added just now. Try again.' });
          return;
        }
        place(added.map(attachmentLink));
        return;
      }
      this.#change({ attachments: [...this.#content.attachments, ...added] });
      place(added.map(attachmentLink));
    } catch (caught) {
      this.#set({ uploadError: uploadMessage(caught) });
    }
  }

  // Typing went on during the upload: add to the text as it is now.
  #append(links: string[]) {
    this.#pull();
    const text = this.#content.markdown;
    const markdown = [text.trimEnd(), ...links].filter(Boolean).join(lineBreakOf(text).repeat(2));
    const participant = this.#participant;
    const parts = participant ? this.#surface.current?.parts?.() : undefined;
    if (participant && parts) {
      // The body alone, as the editor holds it: never split again.
      const body = [parts.body.trimEnd(), ...links]
        .filter(Boolean)
        .join(lineBreakOf(parts.frontmatter ?? parts.body).repeat(2));
      participant.change({ texts: { body } });
      // A change of the session's own: the editor shows it as the document took it.
      return this.#fromDocument(true);
    }
    this.#surface.current?.replace(markdown);
    if (participant) return this.edit(markdown);
    this.#change({ markdown });
  }

  /** The draft is on screen; saves and uploads finishing now show in it. */
  open() {
    this.#live = true;
    void this.#trim();
    void this.joinLive();
  }

  /** The draft leaves the screen: save what's outstanding, leaving its live session. */
  close() {
    this.#live = false;
    if (this.#rejoin) clearTimeout(this.#rejoin);
    if (this.#joinTimer) clearTimeout(this.#joinTimer);
    this.#unwait?.();
    const participant = this.#participant;
    if (participant) {
      this.#detach();
      void participant.leave();
      return;
    }
    void this.#autosave.flush();
  }

  /**
   * Restore a version through the page's live session, when this draft is
   * in one (protocol section 5.10, **Restoring**): `write` restores it with
   * the shape and base the session gives. Whether it did; when it didn't,
   * nothing changed, and the restore goes as from outside the session.
   */
  async restoreLive(write: Parameters<LiveParticipant['restoreThrough']>[0]): Promise<boolean> {
    const participant = this.#participant;
    if (!participant) return false;
    this.#pull();
    const restored = await participant.restoreThrough(write);
    if (restored) this.#fromDocument(true);
    return restored;
  }

  // ---- Notes waiting for review (ADR 0015 decision 8) ----

  /** Open a note of the live session for Review; null when it can't be, or this draft isn't in one. */
  async openNote(revision: RevisionId): Promise<OpenedNote | null> {
    return (await this.#participant?.openNote(revision)) ?? null;
  }

  /** The merge Review shows for an opened note. */
  reviewMerge(opened: OpenedNote): pageMerge.Merge | null {
    return this.#participant?.reviewMerge(opened) ?? null;
  }

  /**
   * Put Review's choices in as the person's change to those parts of the
   * page, and show it in the editor. False when they no longer fit.
   */
  applyReview(
    opened: OpenedNote,
    merge: pageMerge.Merge,
    choices: Readonly<Record<string, pageMerge.Choice>>,
  ): boolean {
    const participant = this.#participant;
    if (!participant) return false;
    this.#pull();
    const applied = participant.applyReview(opened, merge, choices);
    if (applied) this.#fromDocument(true);
    return applied;
  }

  /** Dismiss a note: theirs in its parts is dropped for good. */
  dismissNote(revision: RevisionId) {
    this.#participant?.dismissNote(revision);
  }

  /** The vault locked: leave the live session at once, its key wiped, saving nothing more. */
  lock() {
    const participant = this.#participant;
    if (!participant) return;
    this.#detach();
    participant.close();
  }

  // ---- Live editing (ADR 0015) ----

  #participant: LiveParticipant | null = null;
  #unlive: (() => void)[] = [];
  // Joining again, once saved outside a session: when, and whether never.
  #joinTimer: ReturnType<typeof setTimeout> | null = null;
  #joinTries = 0;
  #liveOff = false;

  #unwait: (() => void) | null = null;

  // Run `run` while the page is visible: a hidden tab joins again when shown.
  #whenVisible(run: () => void) {
    this.#unwait?.();
    this.#unwait = this.#ports.live?.whenVisible?.(run) ?? (run(), null);
  }

  // Join the page's session soon, once what this draft holds is saved, at
  // a pace that slows with each try in a row that didn't join.
  #joinSoon() {
    if (this.#liveOff || this.#joinTimer || this.#participant || !this.#live) return;
    if (!this.#ports.live || this.#joinTries >= 30) return;
    const wait = Math.min(1_000 * 2 ** this.#joinTries, 60_000);
    this.#joinTimer = setTimeout(() => {
      this.#joinTimer = null;
      if (this.#participant || !this.#live) return;
      if (this.#autosave.status !== 'saved' || this.#autosave.unsaved() !== null) return;
      this.#joinTries++;
      this.#whenVisible(() => void this.joinLive());
    }, wait);
  }
  // What this draft held as it joined: what it goes back to if it leaves having changed nothing.
  #beforeLive: {
    base: RevisionId;
    payload: PagePayload;
    content: Content;
    extensions: PagePayload['extensions'];
  } | null = null;

  /** The page's live session this draft is in, if any, for the editor's binding. */
  get participant(): LiveParticipant | null {
    return this.#participant;
  }
  #joining = false;
  #rejoin: ReturnType<typeof setTimeout> | null = null;
  #rejoins = 0;

  /**
   * Join the page's live session, where this app may (ADR 0015 decision
   * 1): from the draft this session is on, as the editor opened it. Not
   * while a conflict waits for the person, nor once an edit typed before
   * the session was joined can't go into it.
   */
  async joinLive(): Promise<void> {
    const live = this.#ports.live;
    if (!live || !this.#live || this.#participant || this.#joining) return;
    if (!live.allowed() || this.#theirs || this.#autosave.isStopped()) return;
    if (this.#autosave.isSaving() || this.#uploads.size > 0) return;
    this.#joining = true;
    // Not while a change for the page waits on this device: it would come
    // to the session as someone else's save (ADR 0015 step 7 takes it in).
    const waiting = await this.#ports.waitingChange?.().catch(() => null);
    if (waiting) {
      this.#joining = false;
      return;
    }
    const opening = { revisionId: this.#base, payload: this.#payload, region: this.#tableRegion };
    const epoch = this.#ports.epoch();
    let joined: LiveParticipant | NotJoined;
    try {
      joined = await live.join(opening);
    } catch {
      this.#joining = false;
      this.#joinSoon();
      return;
    } finally {
      this.#joining = false;
    }
    if (!('start' in joined)) {
      this.#set({ live: { kind: 'not-joined', why: joined } });
      // No sessions on this server, or this app is too old for this one: it edits as before.
      if (joined.kind === 'older-server' || joined.kind === 'update-app') this.#liveOff = true;
      else this.#joinSoon();
      return;
    }
    if (!this.#live || this.#ports.epoch() !== epoch || !this.#attach(joined, opening.payload)) {
      // Never started, it saved nothing for anyone, and saves nothing now.
      joined.close();
      if (this.#live) {
        this.#set({ live: { kind: 'not-joined', why: { kind: 'typed-meanwhile' } } });
        this.#joinSoon();
      }
      return;
    }
    joined.start();
    // Unless it stopped as it was taken in, and has gone already.
    if (this.#participant !== joined) return;
    const unwatch = live.watch?.(joined);
    if (unwatch) this.#unlive.push(unwatch);
  }

  // Take part through `participant`: the person's edit made before it
  // joined goes in, if the session holds the text it was made on.
  #attach(participant: LiveParticipant, opening: PagePayload): boolean {
    if (this.#theirs || this.#autosave.isStopped()) return false;
    // A save of this draft's own landed meanwhile: the session holds the draft before it.
    if (this.#payload !== opening || this.#autosave.isSaving()) return false;
    this.#pull();
    let shared: PagePayload;
    try {
      shared = participant.currentPayload();
    } catch {
      return false;
    }
    const mine = this.#current();
    const sameAttachments = (a: readonly AttachmentRef[], b: readonly AttachmentRef[]) =>
      a.length === b.length && a.every((ref) => b.some((other) => other.id === ref.id));
    // Extensions the person changed, but those the document never holds.
    const namespaces = new Set([
      ...Object.keys(mine.extensions),
      ...Object.keys(opening.extensions),
    ]);
    const changed = [...namespaces].filter(
      (namespace) =>
        !UNHELD.has(namespace) &&
        JSON.stringify(mine.extensions[namespace]) !==
          JSON.stringify(opening.extensions[namespace]),
    );
    const typed =
      mine.title !== opening.title ||
      mine.markdown !== opening.markdown ||
      !sameAttachments(mine.attachments, opening.attachments) ||
      changed.length > 0;
    if (typed) {
      // Files uploaded meanwhile aren't committed yet, and text needs the text it was typed on.
      if (!sameAttachments(mine.attachments, opening.attachments)) return false;
      if (shared.title !== opening.title || shared.markdown !== opening.markdown) return false;
    }
    const parts = this.#surface.current?.parts?.() ?? splitFrontmatter(mine.markdown);
    this.#participant = participant;
    this.#beforeLive = {
      base: this.#base,
      payload: this.#payload,
      content: this.#content,
      extensions: this.#extensions,
    };
    this.#autosave.discard();
    this.#unlive.push(
      participant.subscribe(() => this.#liveStatus()),
      participant.onChange((local) => this.#fromDocument(!local)),
    );
    if (typed) {
      participant.change({
        texts: { title: mine.title, frontmatter: parts.frontmatter ?? '', body: parts.body },
        entries: changed.map((namespace) => {
          const value = mine.extensions[namespace];
          return {
            root: 'extensions' as const,
            key: namespace,
            value: value === undefined ? null : JSON.stringify(value),
          };
        }),
      });
    }
    this.#rejoins = 0;
    this.#joinTries = 0;
    this.#unlive.push(
      participant.onBeforeRemote(() => {
        if (this.#unreported) this.#pull();
      }),
    );
    this.#fromDocument(true);
    this.#liveStatus();
    return true;
  }

  #detach() {
    for (const stop of this.#unlive.splice(0)) stop();
    this.#participant = null;
  }

  // Show the shared document as it is now; `show` puts its text in the editor too.
  #fromDocument(show: boolean) {
    const participant = this.#participant;
    if (!participant) return;
    let payload: PagePayload;
    try {
      payload = participant.currentPayload();
    } catch {
      return;
    }
    const { title, markdown, attachments } = payload;
    const moved = markdown !== this.#content.markdown;
    this.#content = { title, markdown, attachments };
    this.#extensions = held(payload.extensions);
    if (show && this.#live) {
      // The editor shows the document's parts as they are, never split again.
      const surface = this.#surface.current;
      const { frontmatter, body } = participant.document.content();
      const parts = { frontmatter: frontmatter === '' ? null : frontmatter, body };
      const shown = surface?.parts?.();
      if (shown && surface?.replaceParts) {
        if (shown.frontmatter !== parts.frontmatter || shown.body !== parts.body) {
          surface.replaceParts(parts);
        }
      } else if (moved) surface?.replace(markdown);
    }
    this.#set({ title, markdown, attachments, links: this.#table() });
  }

  #liveStatus() {
    const participant = this.#participant;
    if (!participant) return;
    const status = participant.status();
    // Drafts of the session it compared are this draft's own, not someone else's save.
    this.#known.add(status.checked);
    if (status.state.kind !== 'live') return void this.#leftLive(participant, status);
    this.#set({
      status: status.saved ? 'saved' : status.tooLarge ? 'too-large' : 'saving',
      tooLarge: status.tooLarge,
      live: { kind: 'live', status },
    });
  }

  /**
   * The session ended or this app left it: go on as a writer outside it
   * (ADR 0015 decision 12). The document is saved on the head unless the
   * head holds it, or, when it doesn't hold the head, on the latest draft
   * it compared, which meets the conflict. Then, if it can, it joins the
   * next session once that save has landed.
   */
  async #leftLive(participant: LiveParticipant, status: ParticipantStatus) {
    if (this.#participant !== participant) return;
    this.#detach();
    const { state } = status;
    const untouched = await this.#goOn(participant, state);
    const why =
      state.kind === 'ended'
        ? state.reason === 'access'
          ? 'Who can edit this page changed, so live editing starts again.'
          : 'The live session ended.'
        : state.kind === 'stopped'
          ? `Live editing stopped: ${state.why}.`
          : 'You left live editing.';
    this.#set({ live: { kind: 'left', why } });
    // An app that changed nothing ended a session it couldn't take part
    // in: the next start makes a fresh one, from the head.
    const again =
      state.kind === 'ended' || (state.kind === 'stopped' && (state.rejoin || untouched));
    if (again) this.#rejoinWhenSaved();
  }

  /**
   * Save what's typed and leave the page's live session, going on outside
   * it, as before a restore, which is written from outside the session.
   */
  async leaveLive(): Promise<void> {
    // The view opens again on what comes next, and joins from there.
    this.#liveOff = true;
    if (this.#rejoin) clearTimeout(this.#rejoin);
    const participant = this.#participant;
    if (!participant) return;
    this.#detach();
    await participant.leave();
    await this.#goOn(participant, { kind: 'left' });
    this.#set({ live: null });
  }

  // While a session left is settled: saves wait for it, and nothing shows as saved.
  #settling: Promise<void> | null = null;

  // Go on from what the session held, as a writer outside it. Whether the
  // draft went back to what it opened, holding nothing of the person's.
  async #goOn(participant: LiveParticipant, state: ParticipantState): Promise<boolean> {
    // At once: the document's text, so typing meanwhile builds on it.
    try {
      const now = participant.currentPayload();
      this.#content = { title: now.title, markdown: now.markdown, attachments: now.attachments };
      this.#extensions = held(now.extensions);
    } catch {
      // A value the document refused: the editor's text stays as it is.
    }
    const captured = this.#content;
    // An edit the editor hasn't reported yet, as the visual editor's, is the person's too.
    this.#pull();
    let release = () => {};
    this.#settling = new Promise((resolve) => (release = resolve));
    try {
      // At an end, its own document is saved on the head unless that holds it.
      const settled = await participant.settle({ save: state.kind !== 'stopped' });
      const typedMeanwhile = this.#content !== captured;
      const before = this.#beforeLive;
      this.#beforeLive = null;
      const saveOver = state.kind === 'stopped' ? state.saveOver : null;
      const head = settled.atHead ? settled.base : null;
      if (!settled.mine && !typedMeanwhile && !saveOver && (head || before)) {
        // Nothing of the person's is in it: the latest session draft its
        // document holds, or else the draft as it opened. Others' typing
        // not saved yet is theirs to save.
        const back = head
          ? {
              base: head.revisionId,
              payload: head.payload,
              content: {
                title: head.payload.title,
                markdown: head.payload.markdown,
                attachments: head.payload.attachments,
              },
              extensions: {},
            }
          : before;
        if (back) {
          this.#base = back.base;
          this.#known.add(back.base);
          this.#payload = back.payload;
          this.#content = back.content;
          this.#extensions = back.extensions;
          this.#region = null;
          if (this.#live) this.#surface.current?.replace(this.#content.markdown);
          this.#set({ ...this.#content, links: this.#table(), status: 'saved' });
          return true;
        }
      }
      // Drafts of the session are this draft's own: none is someone else's save.
      for (const draft of participant.sessionDrafts()) this.#known.add(draft);
      if (settled.provisional && before) {
        // Its document may hold text nobody typed: never saved over a draft
        // unasked. The person chooses, with Merge… from the draft it opened.
        this.#base = before.base;
        this.#payload = before.payload;
        this.#extensions = over(before.payload.extensions, this.#extensions);
        this.#region = null;
        this.#theirs = settled.base?.revisionId ?? null;
        this.#set({ ...this.#content, links: this.#table() });
        if (this.#theirs) this.#autosave.hold(() => this.#current());
        return false;
      }
      const base = saveOver
        ? { revisionId: saveOver, payload: settled.base?.payload ?? this.#payload }
        : settled.base;
      if (base) {
        this.#base = base.revisionId;
        this.#known.add(base.revisionId);
        this.#payload = base.payload;
        this.#region = null;
      }
      if (settled.payload && !typedMeanwhile) {
        const { title, markdown, attachments } = settled.payload;
        this.#content = { title, markdown, attachments };
        this.#extensions = held(settled.payload.extensions);
      }
      // What the document deleted, the next save deletes too.
      this.#extensions = over(this.#payload.extensions, this.#extensions);
      this.#set({ ...this.#content, links: this.#table() });
      if (!settled.saved || saveOver || typedMeanwhile) this.#schedule();
      else this.#set({ status: 'saved' });
      return false;
    } finally {
      this.#settling = null;
      release();
    }
  }

  // Join the next session once what this session holds is saved, trying
  // again for a while, as a change of access may still be settling.
  #rejoinWhenSaved() {
    if (this.#rejoin) clearTimeout(this.#rejoin);
    if (!this.#live || this.#rejoins >= 20) return;
    this.#rejoin = setTimeout(
      () => {
        this.#rejoin = null;
        if (!this.#live || this.#participant) return;
        if (this.#autosave.status !== 'saved' || this.#autosave.unsaved() !== null) {
          if (this.#autosave.isStopped()) return;
          return this.#rejoinWhenSaved();
        }
        this.#rejoins++;
        this.#whenVisible(
          () =>
            void this.joinLive().then(() => {
              if (!this.#participant) this.#rejoinWhenSaved();
            }),
        );
      },
      Math.min(1_000 * 2 ** this.#rejoins, 30_000),
    );
  }

  // A change from outside the editor, in a live session: attachments
  // added go in through this app's own save of them, the rest at once.
  #reviseLive(changes: PayloadChanges) {
    const participant = this.#participant;
    if (!participant) return;
    const { extensions = {}, attachments, markdown, title } = changes;
    const now = this.#content.attachments;
    const added = (attachments ?? now).filter((ref) => !now.some((held) => held.id === ref.id));
    const removed = attachments
      ? now.filter((ref) => !attachments.some((a) => a.id === ref.id))
      : [];
    const entries = [
      ...Object.entries(held(extensions)).map(([namespace, value]) => ({
        root: 'extensions' as const,
        key: namespace,
        value: value === undefined ? null : JSON.stringify(value),
      })),
      ...removed.map((ref) => ({ root: 'attachments' as const, key: ref.id, value: null })),
    ];
    const split = markdown === undefined ? null : splitFrontmatter(markdown);
    const texts = {
      ...(title !== undefined && { title }),
      ...(split && { frontmatter: split.frontmatter ?? '', body: split.body }),
    };
    // The editor shows it as the document takes it in, never before.
    if (added.length === 0) {
      participant.change({ texts, entries });
      return this.#fromDocument(true);
    }
    // With a file: one change, its text too, saved by this app first (section 5.10, **Files**).
    this.track(
      participant
        .commitOwn({
          texts,
          entries: [
            ...added.map((ref) => ({
              root: 'attachments' as const,
              key: ref.id,
              value: JSON.stringify(ref),
            })),
            ...entries,
          ],
        })
        .then((committed) => {
          if (!committed) {
            this.#set({ uploadError: 'The image couldn’t be added just now. Try again.' });
          }
        }),
    );
  }
}

/** A link to an attachment, as an image when it is one. */
export function attachmentLink(ref: AttachmentRef) {
  const text = ref.name.replace(/[[\]\\]/g, '\\$&');
  return `${ref.mediaType.startsWith('image/') ? '!' : ''}[${text}](${ATTACHMENT_SCHEME}${ref.id})`;
}
