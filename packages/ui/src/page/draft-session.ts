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
  type QueuedPage,
  type KeptLive,
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
  PutBack,
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
    input: Omit<Parameters<typeof pageOperations.saveDraft>[1], 'page'> & {
      /** Kept beside it if it goes into this device's queue: typing put back from a live session. */
      live?: KeptLive | null;
    },
  ): Promise<pageOperations.Written>;
  uploadAttachment(
    file: {
      name: string;
      mediaType: string;
      bytes: Uint8Array;
    },
    /** To the server at once, as from within a live session, never behind a change waiting here. */
    options?: { server?: boolean },
  ): Promise<AttachmentRef>;
  /**
   * Keep the draft on this device as a change waiting for the page, online
   * too, beside what `live` keeps (ADR 0015 decision 10): its version.
   */
  keep?(input: {
    basedOn: RevisionId;
    region: Region | null;
    payload: PagePayload;
    live: KeptLive;
  }): Promise<number>;
  /** The page's draft change waiting here as it is now, read in turn with the queue's sending. */
  entryNow?(): Promise<QueuedPage | null>;
  /** The change at `version` was put into the page's live session: `live`, with what it went in as. */
  markPutIn?(version: number, live: KeptLive): Promise<void>;
  /** The version of the page's change waiting here this view last saved into or opened, if any. */
  seen?(): number | null;
  /** Withdraw the change at `version`, which a compared draft of the session holds. */
  withdraw?(version: number): Promise<boolean>;
  /** Drop a publish waiting here for the page (#331): whether there was one. */
  dropPublish?(): Promise<boolean>;
  /** A draft of the page, opened, as a change made with no session is merged from. */
  openDraft?(revisionId: RevisionId): Promise<PagePayload | null>;
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
  /**
   * Hold the page's live lock while this draft is in, or joining, its
   * session, so this app's queue holds the page's change back meanwhile
   * (ADR 0015 decision 1). The result lets it go; null where nothing can hold it.
   */
  hold?(): (() => void) | null;
  /**
   * Claim the page's waiting change for putting it into the session, so no
   * other tab or window puts it in at once: the release, or null while
   * another holds it.
   */
  claim?(): Promise<(() => void) | null>;
  /** Ask the server now whether it answers, offline, rather than at the app's next check. */
  ask?(): void;
  /** Whether the app is online. */
  online?(): boolean;
  /** Whether `head`'s signed `basedOn` chain reaches `ancestor`, within a bounded walk. */
  descends?(head: RevisionId, ancestor: RevisionId): Promise<boolean>;
  /** The page's draft head as the server has it now, opened, which a session with a change waiting here starts from. */
  head?(): Promise<{ revisionId: RevisionId; payload: PagePayload; region: Region } | null>;
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
  /** Something to tell the person about putting their typing back, once. */
  liveNotice: string | null;
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
    opened: {
      base: RevisionId;
      payload: PagePayload;
      region: Region;
      theirs?: RevisionId | null;
      /** Kept beside it, when it was made from a live session's document. */
      live?: KeptLive | null;
    },
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
      liveNotice: null,
    };
    // Made from a live session's document: its base's text, which Merge… starts from.
    this.#keptLive = opened.live ?? null;
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
    const yours = revisePayload({ kind: 'current', payload: base }, changes);
    // Within a second, as a fold's: one too large to merge here is refused.
    const merged = mergeByBlock(base, yours, current);
    if (!merged) return false;
    const { title, markdown, attachments } = merged;
    this.#reviseLive(
      {
        title,
        markdown,
        attachments,
        extensions: over(current.extensions, held(merged.extensions)),
      },
      { byLines: true },
    );
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
        // Kept beside it if it goes into this device's queue; none once its base
        // moved on. A put-in's mark is the queue's to turn into a base.
        ...(!this.#keptLive?.putIn && { live: this.#keptLive }),
      });
      saved = { revisionId, basedOn, written, region };
      // On the server: what comes next grows from this draft, not from a session's base.
      if (revisionId !== basedOn) {
        this.#keptLive = null;
        this.#putBack = null;
      }
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
    // In a live session, the session's stream says what the head is; on
    // the way back into one, what's kept here goes in by block, whatever saved meanwhile.
    if (this.#participant || this.#rejoinHold) return;
    // A save in flight may already be the head before its answer arrives.
    if (!head || this.#known.has(head) || this.#saving) return;
    this.#theirs = head;
    this.#autosave.conflict();
  }

  hasUnsaved() {
    if (this.#settling) return true;
    if (this.#participant) {
      // Kept on this device as it is now, it is put back on the next join.
      return this.#unreported || (!this.#participant.status().saved && !this.#keptFresh);
    }
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
    this.#keptLive = null;
    this.#releaseConflictHold();
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
    /** The base's text, when it isn't `base`'s: one kept beside typing from a live session. */
    basePayload?: PagePayload;
    theirs: RevisionId;
    yours: PagePayload;
  } | null> {
    // A file still uploading goes in first, so the merge has it.
    await Promise.all(this.#uploads);
    this.#pull();
    const base = this.#base;
    const theirs = this.#theirs ?? (await this.#ports.draftHead());
    if (!theirs || (theirs === base && !this.#keptLive)) return null;
    // Typing put back from a live session: its base holds what others typed
    // that this app took in, so only the person's typing counts as theirs.
    const kept = this.#keptLive?.base;
    return { base, ...(kept && { basePayload: kept }), theirs, yours: this.#current() };
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
    // The merged text grows from theirs, not from a live session's base.
    this.#keptLive = null;
    this.#putBack = null;
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
    this.#releaseConflictHold();
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
          await this.#ports.uploadAttachment(
            {
              name: file.name,
              mediaType: file.type || 'application/octet-stream',
              bytes: new Uint8Array(await file.arrayBuffer()),
            },
            // In a live session, never behind a change waiting here (ADR 0015 decision 1).
            { server: this.#participant !== null },
          ),
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
    this.#releaseRejoinHold();
    this.#releaseConflictHold();
    if (this.#joinTimer) clearTimeout(this.#joinTimer);
    this.#unwait?.();
    const participant = this.#participant;
    if (participant) {
      const release = this.#detach();
      // What leaving can't save is kept on this device, put back on the next join;
      // a change kept or put in that the saved draft holds goes.
      void participant
        .leave()
        .then(async (saved) => {
          // One being kept now goes first, so the one withdrawn is the latest.
          await this.#keeping?.catch(() => false);
          if (!saved) await this.#keepNow(participant);
          else this.#withdrawKept();
        })
        .catch(() => {})
        .finally(release);
      return;
    }
    void this.#autosave.flush();
  }

  /**
   * Keep what is typed in the live session on this device, as a change
   * waiting for the page (ADR 0015 decision 10), as before a lock that
   * can't wait for a save. Whether it is kept, or saved already.
   */
  async keepOnDevice(): Promise<boolean> {
    const participant = this.#participant;
    if (!participant) return false;
    if (participant.status().saved && !this.#unreported) return true;
    this.#pull();
    return this.#keepNow(participant);
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
    try {
      return this.#participant?.reviewMerge(opened) ?? null;
    } catch {
      // Too large to merge here (`MergeTooLarge`): it can't be reviewed.
      return null;
    }
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
    let applied: boolean;
    try {
      applied = participant.applyReview(opened, merge, choices);
    } catch {
      applied = false;
    }
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
    this.#detach()();
    participant.close();
  }

  // ---- Live editing (ADR 0015) ----

  #participant: LiveParticipant | null = null;
  #unlive: (() => void)[] = [];
  // Beside typing made from a live session's document, while it is saved
  // outside one: its base's text and where it was typed (ADR 0015 decision 10).
  #keptLive: KeptLive | null = null;
  // What putting the last session's typing back takes, in memory, for
  // joining that session again: a base by what the session serves.
  #putBack: PutBack | null = null;
  // The change kept on this device for the session, or put into it,
  // withdrawn once a compared draft of the session holds it.
  #kept: {
    version: number;
    /** The participant whose document it was kept or put in from, and that document's state then. */
    participant: LiveParticipant;
    state: ReturnType<LiveParticipant['document']['state']>;
  } | null = null;
  #keepTimer: ReturnType<typeof setTimeout> | null = null;
  // The page's live lock while a waiting change that overlapped the session waits for Merge….
  #conflictHold: (() => void) | null = null;

  #releaseConflictHold() {
    const release = this.#conflictHold;
    this.#conflictHold = null;
    release?.();
  }
  // Recording the change put in from the queue, and the claim held on it until then.
  #markedPutIn: Promise<void> | null = null;
  #claimed: (() => void) | null = null;
  #keeping: Promise<boolean> | null = null;
  // The page's live lock, while in or joining its session.
  #release: (() => void) | null = null;
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
   * 1): from the draft this session is on, as the editor opened it, or,
   * with a change of the page waiting on this device, from the draft head,
   * putting that change in as the person's own. Not while a conflict waits
   * for the person, nor once an edit typed before the session was joined
   * can't go into it.
   */
  async joinLive(): Promise<void> {
    const live = this.#ports.live;
    if (!live || !this.#live || this.#participant || this.#joining) return;
    if (!live.allowed() || this.#theirs || this.#autosave.isStopped()) return;
    if (this.#autosave.isSaving() || this.#uploads.size > 0) return;
    this.#joining = true;
    // Held first: the queue then sends nothing of the page's that this join reads below.
    const hold = live.hold?.() ?? (() => {});
    // And the claim on a change waiting here, once taken: one tab puts it in at a time.
    let claim: (() => void) | null = null;
    const release = () => {
      hold();
      claim?.();
      claim = null;
    };
    const epoch = this.#ports.epoch();
    let entry: QueuedPage | null = null;
    let basedOn: PagePayload | null = null;
    let opening: { revisionId: RevisionId; payload: PagePayload; region: Region };
    let joined: LiveParticipant | NotJoined;
    try {
      const waiting = await this.#ports.waitingChange?.().catch(() => null);
      if (waiting) {
        // Another tab or window of this app is putting it in: not now.
        claim = live.claim ? await live.claim() : () => {};
        if (!claim) throw new Error('claimed');
        // The page's change waiting here goes into the session as the person's own.
        entry = (await this.#ports.entryNow?.().catch(() => null)) ?? null;
        // Being sent, made offline or stopped: it lands, and the saver folds
        // it in, or comes back as a conflict, which the person settles first.
        const head = entry && !entry.sending && !entry.failure && !entry.newPage && live.head;
        if (!head) throw new Error('not now');
        const opened = await live.head!();
        if (!opened) throw new Error('no head');
        // Only onto a head that descends from the change's base: an older one
        // the server serves would take what was saved since for deleted (A2).
        const from = entry!.basedOn;
        const descends =
          from !== null &&
          (opened.revisionId === from || (await live.descends?.(opened.revisionId, from)) === true);
        if (!descends) {
          release();
          this.#joining = false;
          return this.#overlapping(entry!, opened.revisionId);
        }
        // A change made with no session is merged from the version it was based on.
        if (!entry!.live && entry!.basedOn) {
          basedOn = (await this.#ports.openDraft?.(entry!.basedOn).catch(() => null)) ?? null;
          if (!basedOn) throw new Error('no base');
        }
        opening = opened;
      } else {
        opening = { revisionId: this.#base, payload: this.#payload, region: this.#tableRegion };
      }
      joined = await live.join(opening);
    } catch {
      release();
      this.#joining = false;
      this.#joinSoon();
      return;
    } finally {
      this.#joining = false;
    }
    if (!('start' in joined)) {
      release();
      this.#set({ live: { kind: 'not-joined', why: joined } });
      // No sessions on this server, or this app is too old for this one: it edits as before.
      if (joined.kind === 'older-server' || joined.kind === 'update-app') this.#liveOff = true;
      else this.#joinSoon();
      return;
    }
    const attached =
      !this.#live || this.#ports.epoch() !== epoch
        ? 'failed'
        : entry
          ? this.#attachQueued(joined, entry, basedOn)
          : this.#attach(joined, opening.payload)
            ? 'in'
            : 'failed';
    if (attached !== 'in') {
      // Never started, it saved nothing for anyone, and saves nothing now.
      joined.close();
      release();
      // A change made with no session, on the head it was based on, or with
      // files kept here: the queue sends it, and the saver folds it in.
      const onBase = opening.revisionId === entry?.basedOn && !entry?.live;
      if (attached === 'send' || (attached === 'overlap' && onBase)) {
        this.#releaseRejoinHold();
        return;
      }
      if (attached === 'overlap' && entry) return this.#overlapping(entry, opening.revisionId);
      if (this.#live) {
        this.#set({ live: { kind: 'not-joined', why: { kind: 'typed-meanwhile' } } });
        this.#joinSoon();
      }
      return;
    }
    // Kept in the session; the claim goes once the change put in is recorded.
    this.#release = hold;
    const claimed = claim as (() => void) | null;
    if (claimed) {
      this.#claimed = claimed;
      void (this.#markedPutIn ?? Promise.resolve()).finally(() => {
        if (this.#claimed === claimed) this.#claimed = null;
        claimed();
      });
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
    this.#bind(participant);
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
    this.#fromDocument(true);
    this.#liveStatus();
    return true;
  }

  /**
   * Take part through `participant`, putting the page's change waiting on
   * this device in as the person's own change, merged by block (section
   * 5.10, **Putting typing back**): from the base kept beside it, the base
   * this app's last join of the same session left in memory, or, for a
   * change made with no session, the version it was based on (`basedOn`).
   * `overlap` where it overlaps what the session holds, which **Merge…**
   * settles outside the session; nothing went in then.
   */
  #attachQueued(
    participant: LiveParticipant,
    entry: QueuedPage,
    basedOn: PagePayload | null,
  ): 'in' | 'overlap' | 'send' | 'failed' {
    if (this.#theirs || this.#autosave.isStopped() || this.#autosave.isSaving()) return 'failed';
    // The view must hold the change as it waits: one saved into from elsewhere since is theirs.
    if (this.#ports.seen && this.#ports.seen() !== entry.version) return 'failed';
    this.#pull();
    // The person's text: the change as it waits, and whatever they typed since the view opened.
    const ours = this.#current();
    let current: PagePayload;
    try {
      current = participant.currentPayload();
    } catch {
      return 'failed';
    }
    const kept = entry.live ?? null;
    const memory =
      this.#putBack?.sessionId === participant.sessionId &&
      (!kept || kept.joinId === this.#putBack.joinId)
        ? this.#putBack
        : null;
    // Of a join's own messages, those up to the highest `seq` this newcomer's
    // document placed are in the session (section 5.10, **Putting typing back**).
    const placed = (joinId: Parameters<LiveParticipant['placedThrough']>[0]) =>
      participant.placedThrough(joinId);
    let base: PagePayload | null;
    if (kept?.putIn) {
      // Put in already, unchanged since: the session holds it, and only what came after is new.
      const { putIn } = kept;
      base =
        putIn.sessionId === participant.sessionId && placed(putIn.joinId) >= putIn.seq
          ? entry.payload
          : null;
      if (!base) return 'overlap';
    } else if (memory) {
      base = memory.inSession(placed(memory.joinId));
    } else if (kept && kept.sessionId === participant.sessionId) {
      // The whole of its join's typing, or exactly what the base holds of it: else Merge….
      const through = placed(kept.joinId);
      base =
        kept.seq !== null && through >= kept.seq
          ? kept.typed
          : through === kept.baseSeq
            ? kept.base
            : null;
      if (!base) return 'overlap';
    } else {
      base = kept?.base ?? basedOn;
    }
    if (!base) return 'failed';
    // Files added on this device are there only: the queue sends the change,
    // uploading them, and the saver folds it in.
    const known = new Set([...base.attachments, ...current.attachments].map((ref) => ref.id));
    if (ours.attachments.some((ref) => !known.has(ref.id))) return 'send';
    const merged = mergeByBlock(base, ours, current, { addsOverlap: true });
    if (!merged) return 'overlap';
    // From here the view shows the session's document: what `merged` adds to it is the person's.
    this.#content = {
      title: current.title,
      markdown: current.markdown,
      attachments: current.attachments,
    };
    this.#bind(participant);
    const { title, markdown, attachments } = merged;
    this.#reviseLive(
      {
        title,
        markdown,
        attachments,
        extensions: over(current.extensions, held(merged.extensions)),
      },
      { byLines: true },
    );
    this.#kept = { version: entry.version, participant, state: participant.document.state() };
    this.#putBack = null;
    this.#keptLive = null;
    // Recorded beside it once sent, so a later join doesn't put it in again; withdrawn once saved.
    const live = kept ?? {
      base,
      typed: ours,
      sessionId: participant.sessionId,
      joinId: entry.live?.joinId ?? participant.ownJoin,
      baseSeq: 0,
      seq: null,
    };
    // Until it is recorded, or the participant goes, no other tab puts it in.
    this.#markedPutIn = (async () => {
      while (participant.status().state.kind === 'live') {
        const sent = await participant.sentThrough().catch(() => null);
        if (participant.status().state.kind !== 'live') return;
        if (sent && sent.seq >= 1) {
          const putIn = { sessionId: participant.sessionId, joinId: sent.joinId, seq: sent.seq };
          await this.#ports.markPutIn?.(entry.version, { ...live, putIn });
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    })().catch(() => {});
    // A publish waiting with it isn't sent: others are editing, so the person publishes again.
    void this.#ports
      .dropPublish?.()
      .then((dropped) => {
        if (dropped) {
          this.#set({
            liveNotice:
              'Your publish from offline wasn’t sent, as others are editing this page. Publish again when it’s ready.',
          });
        }
      })
      .catch(() => {});
    this.#fromDocument(true);
    this.#liveStatus();
    return 'in';
  }

  // Where the page's change waiting here overlaps the live session: **Merge…**
  // with the draft head, from the base kept beside it, outside the session.
  #overlapping(entry: QueuedPage, head: RevisionId) {
    this.#releaseRejoinHold();
    if (!this.#live) return;
    // Held while the person settles it: the queue sends what they keep, not this.
    this.#conflictHold ??= this.#ports.live?.hold?.() ?? null;
    this.#keptLive = entry.live ?? null;
    this.#theirs = head;
    this.#autosave.hold(() => this.#current());
  }

  // In the session through `participant`: its status and changes shown here.
  #bind(participant: LiveParticipant) {
    this.#participant = participant;
    // In: the join's own hold of the page's live lock takes over.
    this.#releaseRejoinHold();
    this.#beforeLive = {
      base: this.#base,
      payload: this.#payload,
      content: this.#content,
      extensions: this.#extensions,
    };
    this.#autosave.discard();
    this.#unlive.push(
      participant.subscribe(() => this.#liveStatus()),
      participant.onChange((local) => {
        this.#keptFresh = false;
        this.#fromDocument(!local);
      }),
    );
    this.#keptFresh = false;
    this.#rejoins = 0;
    this.#joinTries = 0;
    this.#unlive.push(
      participant.onBeforeRemote(() => {
        if (this.#unreported) this.#pull();
      }),
    );
  }

  // Out of the session: the page's live lock goes with the returned function,
  // once leaving has settled what was kept or put in, so the queue doesn't
  // send it meanwhile.
  #detach(): () => void {
    for (const stop of this.#unlive.splice(0)) stop();
    this.#participant = null;
    const hold = this.#release ?? (() => {});
    const claimed = this.#claimed;
    this.#claimed = null;
    const release = () => {
      hold();
      claimed?.();
    };
    this.#release = null;
    if (this.#keepTimer) clearTimeout(this.#keepTimer);
    this.#keepTimer = null;
    return release;
  }

  // A change kept on this device, or put in, that a saved draft holds: it goes.
  // Only once a compared draft holds the document as it was kept or put in
  // (section 5.10, **Saving**), or the head's text is that change's
  // (`force`): not just this join's typing, as the old join's may be unsaved yet.
  #withdrawKept({ force = false }: { force?: boolean } = {}) {
    const kept = this.#kept;
    if (!kept || (!force && !kept.participant.headHolds(kept.state))) return;
    this.#kept = null;
    void this.#ports.withdraw?.(kept.version).catch(() => false);
  }

  // Whether what is kept on this device is the document as it is now.
  #keptFresh = false;

  /**
   * Keep `participant`'s document on this device, as a change waiting for
   * the page beside its base's text (ADR 0015 decision 10), based on the
   * latest session draft it compared. Whether it is kept.
   */
  #keepNow(participant: LiveParticipant): Promise<boolean> {
    const ports = this.#ports;
    if (!ports.keep) return Promise.resolve(false);
    // One in flight kept the document as it was then: this one keeps it as it is now.
    if (this.#keeping) return this.#keeping.then(() => this.#keepNow(participant));
    const run = (async () => {
      const putBack = participant.putBack();
      if (!putBack.ours || !putBack.outside) return false;
      try {
        const { provisional, checked } = participant.status();
        const state = participant.document.state();
        const version = await ports.keep!({
          // Never whole over a draft it hasn't compared (section 5.10): a
          // provisional document goes on the draft the session started from,
          // so a send meets the conflict, and Merge… counts only the person's typing.
          basedOn: provisional ? participant.startedFrom : checked,
          region: this.#tableRegion,
          payload: putBack.ours,
          live: liveKept(putBack, putBack.ours, putBack.outside),
        });
        this.#kept = { version, participant, state };
        this.#keptFresh = this.#participant === participant;
        return true;
      } catch {
        return false;
      }
    })().finally(() => {
      this.#keeping = null;
    });
    this.#keeping = run;
    return run;
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
    if (status.saved && !this.#unreported) {
      // A compared draft of the session holds what was kept here, or put in: it goes.
      if (this.#keepTimer) clearTimeout(this.#keepTimer);
      this.#keepTimer = null;
      this.#withdrawKept();
    } else if (!this.#keepTimer && this.#ports.keep) {
      // "Saving…" for 10 s: the document is kept on this device too, so a tab closed loses nothing.
      this.#keepTimer = setTimeout(() => {
        this.#keepTimer = null;
        const now = this.#participant;
        if (!now || now.status().saved) return;
        this.#pull();
        void this.#keepNow(now).then(() => this.#liveStatus());
      }, 10_000);
    }
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
    const { state } = status;
    // Its join went: held from now, so the queue sends nothing of the page's before it is kept.
    if (state.kind === 'stopped' && state.rejoin) this.#holdForRejoin();
    const release = this.#detach();
    let untouched: boolean;
    try {
      untouched = await this.#goOn(participant, state);
    } finally {
      release();
    }
    // Nothing kept for the next join: the queue may send the page's changes.
    if (!this.#rejoinKept) this.#releaseRejoinHold();
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
    const release = this.#detach();
    try {
      await participant.leave();
      await this.#goOn(participant, { kind: 'left' });
    } finally {
      release();
    }
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
          // Nothing of the person's: a change kept or put in that the head holds goes.
          this.#withdrawKept();
          if (this.#live) this.#surface.current?.replace(this.#content.markdown);
          this.#set({ ...this.#content, links: this.#table(), status: 'saved' });
          return true;
        }
      }
      // Drafts of the session are this draft's own: none is someone else's save.
      for (const draft of participant.sessionDrafts()) this.#known.add(draft);
      // What putting the person's typing back takes: kept beside it from
      // here on, and in memory for joining the same session again.
      const putBack = participant.putBack();
      this.#putBack = putBack;
      this.#keptLive =
        putBack.outside && putBack.ours && !saveOver
          ? liveKept(putBack, putBack.ours, putBack.outside)
          : null;
      if (state.kind === 'stopped' && state.rejoin && !saveOver && settled.mine) {
        // Its join went, as offline: what the session didn't take waits on
        // this device, held back, and goes in when it joins again (ADR 0015
        // decision 10), never as a save from outside the session meanwhile.
        if (await this.#keepForRejoin(participant, settled, typedMeanwhile)) return false;
      }
      if (!saveOver && !(settled.atHead && !settled.provisional)) {
        // Its document doesn't hold the head, or may hold text nobody typed:
        // never saved over a draft. Only the person's own typing goes back,
        // merged by block onto the head (section 5.10, **Putting typing back**).
        if (await this.#putBackOnto(participant, typedMeanwhile, settled.payload)) return false;
      }
      if (settled.provisional && before) {
        // The head couldn't be read: a document that may hold text nobody
        // typed is never saved over a draft unasked. The person chooses, with
        // Merge…, from the base kept beside it.
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
        // A change waiting here, kept or put in, goes on top of it too.
        this.#ports.onTopOf?.(base.revisionId);
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
      else {
        this.#set({ status: 'saved' });
        // The head holds what was kept or put in: it goes.
        this.#withdrawKept();
      }
      return false;
    } finally {
      this.#settling = null;
      release();
    }
  }

  /**
   * Put the person's typing in a session left back onto the draft head, as
   * a writer outside the session: merged by block from the base kept beside
   * it, which holds what others typed that this app took in, so theirs
   * isn't counted as the person's (section 5.10, **Putting typing back**).
   * Saved on the head where nothing overlaps; where it does, **Merge…**
   * from that base. False, changing nothing, when the head can't be read.
   */
  async #putBackOnto(
    participant: LiveParticipant,
    typedMeanwhile: boolean,
    document: PagePayload | null,
  ): Promise<boolean> {
    const base = this.#keptLive?.base;
    if (!base || !document) return false;
    const head = await participant.headDraft();
    if (!head) return false;
    // The person's: the document, and what they typed in the editor since it left.
    const ours = typedMeanwhile
      ? revisePayload(
          { kind: 'current', payload: document },
          { ...this.#content, extensions: over(document.extensions, this.#extensions) },
        )
      : document;
    this.#known.add(head.revisionId);
    const merged = mergeByBlock(base, ours, head.payload, { addsOverlap: true });
    this.#payload = head.payload;
    this.#region = null;
    if (!merged) {
      // Where it overlaps the head: Merge… from the kept base, the person's text as it is.
      this.#base = participant.status().checked;
      this.#theirs = head.revisionId;
      this.#content = { title: ours.title, markdown: ours.markdown, attachments: ours.attachments };
      this.#extensions = over(this.#payload.extensions, held(ours.extensions));
      if (this.#live) this.#surface.current?.replace(this.#content.markdown);
      this.#set({ ...this.#content, links: this.#table() });
      this.#autosave.hold(() => this.#current());
      return true;
    }
    this.#base = head.revisionId;
    // Its text grows from the head now, as does a change waiting here.
    this.#keptLive = null;
    this.#ports.onTopOf?.(head.revisionId);
    const { title, markdown, attachments } = merged;
    this.#content = { title, markdown, attachments };
    this.#extensions = over(head.payload.extensions, held(merged.extensions));
    if (this.#live) this.#surface.current?.replace(markdown);
    this.#set({ ...this.#content, links: this.#table() });
    // Nothing of the person's that the head lacks: nothing to save.
    const same =
      title === head.payload.title &&
      markdown === head.payload.markdown &&
      JSON.stringify(attachments) === JSON.stringify(head.payload.attachments) &&
      JSON.stringify(held(merged.extensions)) === JSON.stringify(held(head.payload.extensions));
    if (same) {
      this.#keptLive = null;
      this.#set({ status: 'saved' });
      this.#withdrawKept({ force: true });
    } else this.#schedule();
    return true;
  }

  // The page's live lock, held from a join that went until the next join
  // puts back what was kept: the queue sends nothing of the page's meanwhile.
  #rejoinHold: (() => void) | null = null;
  #rejoinKept = false;
  #holdCheck: ReturnType<typeof setTimeout> | null = null;

  #holdForRejoin() {
    if (this.#rejoinHold) return;
    const hold = this.#ports.live?.hold?.();
    if (!hold) return;
    this.#rejoinHold = hold;
    let online: number | null = null;
    // Online for long without getting back in, as a hidden tab or one this
    // server won't let join: the queue sends what is kept as it would.
    const check = () => {
      this.#holdCheck = null;
      if (!this.#rejoinHold) return;
      if (this.#ports.live?.online?.() === false) online = null;
      else online ??= Date.now();
      if (online !== null && Date.now() - online > HOLD_FOR_REJOIN_MS) {
        return this.#releaseRejoinHold();
      }
      this.#holdCheck = setTimeout(check, 15_000);
    };
    this.#holdCheck = setTimeout(check, 15_000);
  }

  #releaseRejoinHold() {
    if (this.#holdCheck) clearTimeout(this.#holdCheck);
    this.#holdCheck = null;
    this.#rejoinKept = false;
    const release = this.#rejoinHold;
    this.#rejoinHold = null;
    release?.();
  }

  /**
   * Keep `participant`'s document on this device for the next join to put
   * back (ADR 0015 decision 10), based on the latest session draft it
   * compared, holding the page's live lock until then; what the person
   * types meanwhile goes into that change too. Whether it is kept.
   */
  async #keepForRejoin(
    participant: LiveParticipant,
    settled: Awaited<ReturnType<LiveParticipant['settle']>>,
    typedMeanwhile: boolean,
  ): Promise<boolean> {
    if (!this.#rejoinHold || !this.#ports.keep || !settled.payload || !this.#keptLive) {
      return false;
    }
    if (!(await this.#keepNow(participant))) return false;
    this.#rejoinKept = true;
    const checked = participant.checkedDraft;
    if (checked) {
      this.#base = checked.revisionId;
      this.#known.add(checked.revisionId);
      this.#payload = checked.payload;
      this.#region = null;
    }
    if (!typedMeanwhile) {
      const { title, markdown, attachments } = settled.payload;
      this.#content = { title, markdown, attachments };
      this.#extensions = over(this.#payload.extensions, held(settled.payload.extensions));
    }
    this.#set({ ...this.#content, links: this.#table(), status: 'saved' });
    // Typed in the editor since it left: into the kept change too.
    if (typedMeanwhile) this.#schedule();
    return true;
  }

  // Join the next session once what this session holds is saved, trying
  // again for a while, as a change of access may still be settling.
  #rejoinWhenSaved() {
    if (this.#rejoin) clearTimeout(this.#rejoin);
    if (!this.#live || this.#rejoins >= 20) {
      // Not back in: what is kept here goes as the queue sends it.
      this.#releaseRejoinHold();
      return;
    }
    this.#rejoin = setTimeout(
      () => {
        this.#rejoin = null;
        if (!this.#live || this.#participant) return;
        if (this.#autosave.status !== 'saved' || this.#autosave.unsaved() !== null) {
          if (this.#autosave.isStopped()) return;
          return this.#rejoinWhenSaved();
        }
        // Tries offline don't count: they ask nothing of the server, but
        // with typing kept here for the session, whether it is back.
        if (this.#ports.live?.allowed()) this.#rejoins++;
        else if (this.#rejoinHold) this.#ports.live?.ask?.();
        this.#whenVisible(
          () =>
            void this.joinLive().then(() => {
              if (!this.#participant) this.#rejoinWhenSaved();
            }),
        );
      },
      // On the way back with typing kept here, it asks every 2 s (ADR 0015 decision 10).
      this.#rejoinHold ? 2_000 : Math.min(1_000 * 2 ** this.#rejoins, 30_000),
    );
  }

  // A change from outside the editor, in a live session: attachments
  // added go in through this app's own save of them, the rest at once.
  #reviseLive(changes: PayloadChanges, { byLines = false }: { byLines?: boolean } = {}) {
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
      participant.change({ texts, entries }, { byLines });
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

// How long a tab online keeps the page's queue held while it tries to join again.
const HOLD_FOR_REJOIN_MS = 120_000;

/** What is kept beside a change made from a session's document, as `putBack` gives it. */
function liveKept(putBack: PutBack, typed: PagePayload, base: PagePayload): KeptLive {
  return {
    base,
    typed,
    sessionId: putBack.sessionId,
    joinId: putBack.joinId,
    baseSeq: putBack.outsideSeq,
    seq: putBack.unsealed ? null : putBack.seq,
    putIn: null,
  };
}

/**
 * `yours`, an edit of `base`, merged by block onto `current` (ADR 0013's
 * merge), the extensions a live document never holds aside; null where
 * they overlap, or the merge takes longer than a second.
 */
function mergeByBlock(
  base: PagePayload,
  yours: PagePayload,
  current: PagePayload,
  {
    addsOverlap = false,
  }: {
    /** Both sides adding at one place overlaps, as when putting typing back: never both kept. */
    addsOverlap?: boolean;
  } = {},
): PagePayload | null {
  const strip = (payload: PagePayload) => ({ ...payload, extensions: held(payload.extensions) });
  try {
    const resolved = pageMerge.withinTime(1_000, () => {
      const run = () => pageMerge.mergePayloads(strip(base), strip(yours), strip(current));
      const merge = addsOverlap ? pageMerge.addsOverlap(run) : run();
      if (merge.overlaps.length > 0) return { ok: false, merge } as const;
      return pageMerge.resolve(merge, {}, { review: false });
    });
    return resolved.ok ? resolved.payload : null;
  } catch {
    return null;
  }
}

/** A link to an attachment, as an image when it is one. */
export function attachmentLink(ref: AttachmentRef) {
  const text = ref.name.replace(/[[\]\\]/g, '\\$&');
  return `${ref.mediaType.startsWith('image/') ? '!' : ''}[${text}](${ATTACHMENT_SCHEME}${ref.id})`;
}
