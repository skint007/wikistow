import {
  checkPayloadSize,
  linksInUse,
  linkTableOf,
  PageTooLarge,
  revisePayload,
  type AttachmentRef,
  type LinkTree,
  type PageId,
  type pageOperations,
  type PagePayload,
  type PayloadChanges,
  type ReadWikilinks,
  type Region,
  type RevisionId,
  withoutLinkTable,
} from '@wikistow/client';
import { ApiError } from '@wikistow/client/api';
import { ATTACHMENT_SCHEME } from './attachments';
import { Autosave, type SaveStatus } from './autosave';
import { lineBreakOf, type EditorSurfaceHandle } from './editor/surface';
import { uploadMessage } from './messages';

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
   * A save landed, with the vault still unlocked since `epoch`: show the
   * version saved (its title, emoji and region) as the page's, and load the
   * page's heads again. `payload` is what was typed, `written` what the
   * server holds (links renamed), and `basedOn` the version saved over.
   */
  saved(saved: {
    revisionId: RevisionId;
    basedOn: RevisionId;
    payload: PagePayload;
    written: PagePayload;
    region: Region;
    epoch: number;
  }): Promise<void>;
  /** Someone else saved first: load their draft, so the conflict prompt knows it. */
  overtaken(): void;
  /** How the draft's wikilinks are read as it opens, off the page's thread (`linksInUse`). */
  readLinks: ReadWikilinks;
};

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
    /** The draft as opened, and the region it was opened in. */
    opened: { base: RevisionId; payload: PagePayload; region: Region },
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
        const trimming = this.#trim();
        if (trimming) await trimming;
        return this.#save(build());
      },
      (status, saveError) => this.#set({ status: this.#shown(status), saveError }),
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
    };
  }

  /**
   * Cut the table to what the draft's links use, no old key a rename kept,
   * once: as it opens (`open`), or before its first save. A session React
   * makes and drops reads nothing.
   */
  #trim(): Promise<void> | null {
    if (this.#trimming === 'done') return null;
    this.#trimming ??= linksInUse(this.#payload, this.#ports.readLinks).then((inUse) => {
      this.#trimming = 'done';
      this.#payload = inUse;
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

  /** The payload the next save writes. */
  #current(): PagePayload {
    return revisePayload(
      { kind: 'current', payload: this.#payload },
      { ...this.#content, extensions: this.#extensions },
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
    const markdown = this.#surface.current?.read();
    if (markdown !== undefined) this.edit(markdown);
  }

  setTitle(title: string) {
    this.#change({ title });
  }

  /**
   * The draft this session opened or last saved, when everything shown is
   * in it: null while an edit waits to be saved, is saving, or conflicts.
   */
  savedRevision(): RevisionId | null {
    this.#pull();
    return this.#snapshot.status === 'saved' && !this.#saving ? this.#base : null;
  }

  /** The surface's text after the person edited it. */
  edit(markdown: string) {
    this.#unreported = false;
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
    const { extensions, ...content } = changes(this.#current());
    if (extensions) this.#extensions = { ...this.#extensions, ...extensions };
    if (content.markdown !== undefined && content.markdown !== this.#content.markdown)
      this.#surface.current?.replace(content.markdown);
    this.#change(content);
  }

  removeAttachment(id: string) {
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
    this.#set({ links: this.#table() });
    this.#schedule();
    return true;
  }

  // The table the last save wrote, and the picks it will keep. Every pick
  // is sent with every save; one the audience rule refuses there leaves the
  // link's entry as it was.
  #table(): ReadonlyMap<string, string> {
    const allowed = this.linkTargets();
    const holding = [...this.#picks].filter(([, pageId]) => allowed?.has(pageId));
    const table = new Map<string, string>([...linkTableOf(this.#payload), ...holding]);
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
      this.#base = revisionId;
      this.#region = { region, generation };
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
    if (this.#ports.epoch() === epoch) await this.#ports.saved({ ...saved, payload: next, epoch });
  }

  /** Save what's typed now, without waiting for files still uploading. */
  async flushSaves() {
    this.#pull();
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
    // A save in flight may already be the head before its answer arrives.
    if (!head || this.#known.has(head) || this.#saving) return;
    this.#theirs = head;
    this.#autosave.conflict();
  }

  hasUnsaved() {
    return this.#unreported || this.#autosave.unsaved() !== null;
  }

  /** A save is waiting for its answer, or a file is still uploading. */
  isBusy() {
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
    }
    // Their draft may be in another region by now: open it fresh.
    this.#region = null;
    this.#theirs = null;
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
    this.#surface.current?.replace(markdown);
    this.#change({ markdown });
  }

  /** The draft is on screen; saves and uploads finishing now show in it. */
  open() {
    this.#live = true;
    void this.#trim();
  }

  /** The draft leaves the screen: save what's outstanding. */
  close() {
    this.#live = false;
    void this.#autosave.flush();
  }
}

/** A link to an attachment, as an image when it is one. */
export function attachmentLink(ref: AttachmentRef) {
  const text = ref.name.replace(/[[\]\\]/g, '\\$&');
  return `${ref.mediaType.startsWith('image/') ? '!' : ''}[${text}](${ATTACHMENT_SCHEME}${ref.id})`;
}
