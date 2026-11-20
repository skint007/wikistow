// A draft session in a page's live session (ADR 0015 step 6): the shared
// document holds what's typed, the session's saver saves, and when the
// session ends the draft goes on as before and joins the next one.
import {
  linksInUse,
  newPayload,
  OWNER_REGION,
  RevisionId,
  type KeptLive,
  type QueuedPage,
  type AttachmentRef,
  type pageOperations,
  type PagePayload,
} from '@wikistow/client';
import {
  changeText,
  documentFromPayload,
  type LiveDocument,
  type LiveParticipant,
  type PutBack,
  type ParticipantState,
  type ParticipantStatus,
} from '@wikistow/client/live';
import { JoinId, LiveSessionId, PageId, SpaceId } from '@wikistow/contracts';
import { describe, expect, it } from 'vite-plus/test';
import { DraftSession, type DraftPorts } from '../src/page/draft-session.ts';
import type { EditorSurfaceHandle } from '../src/page/editor/surface.ts';

class FakeSurface implements EditorSurfaceHandle {
  text: string;
  replaced: string[] = [];
  /** As the page editor holds them: frontmatter in Properties, the body in the editor. */
  frontmatter: string | null = null;
  parts() {
    return { frontmatter: this.frontmatter, body: this.text };
  }
  replaceParts(parts: { frontmatter: string | null; body: string }) {
    this.frontmatter = parts.frontmatter;
    this.text = parts.body;
  }
  constructor(text: string) {
    this.text = text;
  }
  read() {
    return this.text;
  }
  replace(markdown: string) {
    this.replaced.push(markdown);
    this.text = markdown;
  }
  focus() {}
}

const R0 = RevisionId.parse('r0');

/** A participant over a real shared document, whose server and others the test plays. */
class FakeParticipant {
  readonly document: LiveDocument;
  readonly base: PagePayload;
  #listeners = new Set<() => void>();
  #changes = new Set<(local: boolean) => void>();
  #status: ParticipantStatus;
  left = false;
  closed = false;
  typed = false;
  settled: Awaited<ReturnType<LiveParticipant['settle']>> | null = null;
  /** Settling waits for this, as it waits on the server. */
  settling: Promise<void> | null = null;
  readonly sessionId = LiveSessionId.parse('session-1');
  /** The base a put-back merges from: what others typed that this app took in, and its own the session saved. */
  outside: PagePayload | null = null;
  /** The draft head, for putting typing back onto it. */
  head: { revisionId: RevisionId; payload: PagePayload } | null = null;

  constructor(payload: PagePayload) {
    this.base = payload;
    this.document = documentFromPayload(payload, 7);
    this.#status = {
      state: { kind: 'live' },
      saved: true,
      head: R0,
      checked: R0,
      saver: 'me',
      failing: null,
      tooLarge: null,
      people: [],
      provisional: false,
      notes: [],
      connected: true,
    };
  }
  start() {}
  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => void this.#listeners.delete(listener);
  };
  status = () => this.#status;
  onChange(listener: (local: boolean) => void) {
    this.#changes.add(listener);
    return () => void this.#changes.delete(listener);
  }
  currentPayload() {
    return this.document.payload(this.base);
  }
  get headPayload() {
    return this.base;
  }
  change({ texts = {}, entries = [] }: Parameters<LiveParticipant['change']>[0]) {
    this.document.edit(() => {
      for (const [name, text] of Object.entries(texts)) {
        changeText(this.document.text(name as 'body'), text as string);
      }
      for (const { root, key, value } of entries) {
        if (value === null) this.document.map(root).delete(key);
        else this.document.map(root).set(key, value);
      }
    });
    this.typed = true;
    this.set({ saved: false });
    for (const listener of this.#changes) listener(true);
  }
  /**
   * The person's deletion, as the participant tells of it: its listeners
   * hear of the change before the status counts it as unsaved.
   */
  deleteLate(text: string) {
    this.document.edit(() => changeText(this.document.text('body'), text));
    for (const listener of this.#changes) listener(true);
    this.set({ saved: false });
  }
  /** Someone else's change. */
  theirs(text: string) {
    this.document.edit(() => changeText(this.document.text('body'), text), 'remote');
    for (const listener of this.#changes) listener(false);
  }
  async saveNow() {
    this.set({ saved: true });
    return true;
  }
  /** What the editor said at a publish's press: whether it was behind. */
  published: { behind: boolean; text: string }[] = [];
  press(behind: () => boolean) {
    const at = { behind: behind(), text: this.document.text('body').toJSON() };
    this.published.push(at);
    return at;
  }
  async publish<T>(publish: (draft: RevisionId, check: () => void) => Promise<T>) {
    return publish(R0, () => {});
  }
  async settle() {
    await this.settling;
    return (
      this.settled ?? {
        base: { revisionId: R0, payload: this.base },
        payload: this.currentPayload(),
        saved: this.#status.saved,
        mine: this.typed,
        provisional: false,
        atHead: true,
      }
    );
  }
  async leave() {
    this.left = true;
    return this.#status.saved;
  }
  close() {
    this.closed = true;
  }
  async commitOwn(change: Parameters<LiveParticipant['commitOwn']>[0]) {
    this.document.edit(() => {
      if (typeof change === 'function') return change(this.document);
      for (const [name, text] of Object.entries(change.texts ?? {})) {
        changeText(this.document.text(name as 'body'), text as string);
      }
      for (const { root, key, value } of change.entries ?? []) {
        if (value === null) this.document.map(root).delete(key);
        else this.document.map(root).set(key, value);
      }
    }, 'copy');
    for (const listener of this.#changes) listener(false);
    return true;
  }
  onBeforeRemote() {
    return () => {};
  }
  readonly ownJoin = JoinId.parse('join-1');
  putBack(): PutBack {
    return {
      sessionId: this.sessionId,
      joinId: this.ownJoin,
      ours: this.currentPayload(),
      outside: this.outside ?? this.base,
      outsideSeq: 0,
      seq: 1,
      unsealed: false,
      inSession: () => this.outside ?? this.base,
    };
  }
  placedThrough() {
    return 0;
  }
  readonly startedFrom = R0;
  /** Whether a compared head holds a document's state: here, once the session shows saved. */
  holds: boolean | null = null;
  headHolds() {
    return this.holds ?? this.#status.saved;
  }
  async sentThrough() {
    return { joinId: this.ownJoin, seq: 9 };
  }
  async headDraft() {
    return this.head ?? { revisionId: R0, payload: this.base };
  }

  sessionDrafts() {
    return [R0];
  }
  async recheck() {}
  presenceChanged() {}
  regionIs() {}
  end(state: ParticipantState) {
    this.set({ state });
  }
  set(changes: Partial<ParticipantStatus>) {
    this.#status = { ...this.#status, ...changes };
    for (const listener of this.#listeners) listener();
  }
}

function session(
  payload = newPayload({ title: 'Notes', markdown: 'Start.', extensions: {} }),
  shared = payload,
  {
    waiting = false,
    entry,
    seen = entry?.version,
    claimed = false,
    catchUp,
    duringJoin,
  }: {
    waiting?: boolean;
    /** The page's change waiting here, which a join puts in. */
    entry?: QueuedPage;
    /** The version of that change this view last saw. */
    seen?: number | null;
    /** Another tab holds that change: putting it in, or keeping it for its session. */
    claimed?: boolean;
    /** The first join catches up from an ended session, saving this draft on top of the head. */
    catchUp?: { revisionId: RevisionId; payload: PagePayload };
    /** Run as the join is under way, as the person typing meanwhile. */
    duringJoin?: () => void;
  } = {},
) {
  const surface = new FakeSurface(payload.markdown);
  const saves: Parameters<DraftPorts['saveDraft']>[0][] = [];
  const joins: FakeParticipant[] = [];
  const kept: { payload: PagePayload; live: KeptLive; basedOn: RevisionId }[] = [];
  const withdrawn: number[] = [];
  const marked: { version: number; putIn: KeptLive['putIn'] }[] = [];
  let held = 0;
  let joinable = true;
  const ports: DraftPorts = {
    async saveDraft(input) {
      saves.push(input);
      return {
        revisionId: RevisionId.parse(`r${saves.length}`),
        repaired: false,
        region: OWNER_REGION,
        payload: input.payload,
        inUse: await linksInUse(input.payload),
        renamed: [],
        linksKept: false,
      } satisfies pageOperations.Written;
    },
    async uploadAttachment(file): Promise<AttachmentRef> {
      // A whole ref, as the document takes only those.
      return {
        id: `a-${file.name.replace(/[^\w-]/g, '_')}`,
        name: file.name,
        mediaType: file.mediaType,
        size: 1,
        key: 'A'.repeat(43),
        blobHash: 'A'.repeat(43),
      } as AttachmentRef;
    },
    draftHead: async () => R0,
    generation: () => 0,
    epoch: () => 0,
    tree: () => undefined,
    linkTargets: () => null,
    saved: async () => {},
    overtaken: () => undefined,
    readLinks: async () => [],
    waitingChange: async () =>
      waiting || entry ? { version: entry?.version ?? 1, head: R0, payload } : null,
    ...(entry && {
      entryNow: async () => entry,
      async markPutIn(version, live) {
        marked.push({ version, putIn: live.putIn });
      },
      seen: () => seen ?? null,
      mergedWith(version) {
        seen = version;
      },
      openDraft: async () => entry.payload,
    }),
    async keep(input) {
      kept.push(input);
      return 40 + kept.length;
    },
    async withdraw(version) {
      withdrawn.push(version);
      return true;
    },
    live: {
      allowed: () => joinable,
      hold() {
        held++;
        return () => void held--;
      },
      head: async () => ({ revisionId: R0, payload: shared, region: OWNER_REGION }),
      descends: async () => true,
      claim: async () => (claimed ? null : () => {}),
      async join(_opening, caughtUp) {
        duringJoin?.();
        if (catchUp) {
          const { revisionId, payload: caught } = catchUp;
          catchUp = undefined;
          caughtUp?.({ kind: 'saved', revisionId, basedOn: R0, payload: caught, overlapped: 0 });
          return { kind: 'caught-up', revisionId, basedOn: R0, payload: caught };
        }
        const participant = new FakeParticipant(shared);
        joins.push(participant);
        return participant as unknown as LiveParticipant;
      },
    },
  };
  const draft = new DraftSession(
    // Opened on the change waiting here, as the page opens one, when the view saw it.
    { base: R0, payload, region: OWNER_REGION, live: seen === null ? null : (entry?.live ?? null) },
    ports,
    { current: surface },
    { debounceMs: 10, maxWaitMs: 10 },
  );
  return {
    draft,
    surface,
    saves,
    joins,
    kept,
    withdrawn,
    marked,
    held: () => held,
    noJoining: () => (joinable = false),
    /** The person types: the surface holds it, and reports it. */
    type: (markdown: string) => {
      surface.text = markdown;
      draft.edit(markdown);
    },
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

describe('a draft session in a live session', () => {
  it('puts the person’s typing into the shared document, which the session saves', async () => {
    const { draft, saves, joins, type } = session();
    await draft.joinLive();
    const [live] = joins;
    expect(live).toBeDefined();
    type('Start. And more.');
    draft.setTitle('Notes, longer');
    expect(live?.document.text('body').toJSON()).toBe('Start. And more.');
    expect(live?.document.text('title').toJSON()).toBe('Notes, longer');
    expect(draft.snapshot().status).toBe('saving');
    expect(draft.hasUnsaved()).toBe(true);
    await draft.saveOrThrow();
    expect(draft.snapshot().status).toBe('saved');
    await settle();
    // Only the session saves while it's live.
    expect(saves).toHaveLength(0);
  });

  it('counts only the person’s own typing as unsaved, not others’ (#494)', async () => {
    const { draft, joins, type } = session();
    await draft.joinLive();
    const live = joins[0];
    if (!live) throw new Error('not joined');
    const R1 = RevisionId.parse('r1');
    // Others type, and the head is a draft of theirs this app hasn't compared yet.
    live.theirs('Start. Their line.');
    live.set({ saved: false, head: R1 });
    expect(draft.hasUnsaved()).toBe(false);
    expect(draft.isBusy()).toBe(false);
    // The person types: theirs to lose, until a draft this app compared holds it.
    type('Start. Their line. Mine.');
    expect(draft.hasUnsaved()).toBe(true);
    expect(draft.isBusy()).toBe(true);
    live.theirs('Start. Their line. Mine. More of theirs.');
    expect(draft.hasUnsaved()).toBe(true);
    live.set({ saved: true, head: R1, checked: R1 });
    expect(draft.hasUnsaved()).toBe(false);
    // Saved once, it stays so while others go on typing.
    live.theirs('Start. Their line. Mine. More of theirs, and more.');
    live.set({ saved: false, head: RevisionId.parse('r2') });
    expect(draft.hasUnsaved()).toBe(false);
    expect(draft.isBusy()).toBe(false);
  });

  it('counts a deletion of the person’s as unsaved, read as it goes in (#494)', async () => {
    const { draft, joins, surface } = session();
    await draft.joinLive();
    const live = joins[0];
    if (!live) throw new Error('not joined');
    // Something on the page reads it each time the draft changes.
    const read: boolean[] = [];
    draft.subscribe(() => read.push(draft.hasUnsaved()));
    surface.text = 'Start';
    live.deleteLate('Start');
    expect(read.length).toBeGreaterThan(0);
    expect(draft.hasUnsaved()).toBe(true);
    expect(draft.isBusy()).toBe(true);
    live.set({ saved: true });
    expect(draft.hasUnsaved()).toBe(false);
  });

  it('shows others’ changes in the editor, out of the person’s way', async () => {
    const { draft, surface, joins } = session();
    await draft.joinLive();
    joins[0]?.theirs('Start. Their line.');
    expect(surface.text).toBe('Start. Their line.');
    expect(draft.snapshot().markdown).toBe('Start. Their line.');
  });

  it('shows a newcomer the session’s text, typing nobody saved yet included', async () => {
    const opened = newPayload({ title: 'Notes', markdown: 'Start.', extensions: {} });
    const { draft, surface } = session(opened, { ...opened, markdown: 'Start. Unsaved.' });
    await draft.joinLive();
    expect(surface.text).toBe('Start. Unsaved.');
  });

  it('takes an edit typed while joining only onto the text it was typed on', async () => {
    const opened = newPayload({ title: 'Notes', markdown: 'Start.', extensions: {} });
    const same = session(opened);
    same.type('Start. Typed early.');
    await same.draft.joinLive();
    expect(same.joins[0]?.document.text('body').toJSON()).toBe('Start. Typed early.');
    expect(same.joins[0]?.left).toBe(false);

    const other = session(opened, { ...opened, markdown: 'Start. Someone else’s.' });
    other.type('Start. Typed early.');
    await other.draft.joinLive();
    // Never started, it is closed, saving nothing.
    expect(other.joins[0]?.closed).toBe(true);
    expect(other.draft.snapshot().live).toEqual({
      kind: 'not-joined',
      why: { kind: 'typed-meanwhile' },
    });
    // Saved as before, outside the session.
    await other.draft.saveOrThrow();
    expect(other.saves.at(-1)?.payload.markdown).toBe('Start. Typed early.');
    // Saved, it joins the session after all, so its saves aren't someone else's there.
    await expect.poll(() => other.joins.length, { timeout: 5_000 }).toBe(2);
    expect(other.draft.participant).not.toBeNull();
  });

  it('goes on outside the session when it ends, saves what it held, and joins the next', async () => {
    const { draft, saves, joins, type } = session();
    draft.open();
    await settle();
    const live = joins[0];
    if (!live) throw new Error('not joined');
    type('Start. Last words.');
    live.end({ kind: 'ended', reason: 'access' });
    await settle();
    expect(draft.snapshot().live).toMatchObject({ kind: 'left' });
    await draft.saveOrThrow();
    expect(saves.at(-1)).toMatchObject({ basedOn: R0 });
    expect(saves.at(-1)?.payload.markdown).toBe('Start. Last words.');
    await expect.poll(() => joins.length, { timeout: 5_000 }).toBe(2);
    draft.close();
    expect(joins[1]?.left).toBe(true);
  });

  it('saves typing done while a session is left once, in the save that waited for it (#661)', async () => {
    const { draft, saves, joins, type } = session();
    await draft.joinLive();
    const live = joins[0];
    if (!live) throw new Error('not joined');
    type('Start. Last words.');
    let release = () => {};
    live.settling = new Promise((resolve) => (release = resolve));
    live.end({ kind: 'ended', reason: 'access' });
    await settle();
    // Typed while it settles, long enough for the autosave's save to wait on it.
    type('Start. Last words. More.');
    await settle();
    expect(saves).toHaveLength(0);
    release();
    await settle();
    await draft.saveOrThrow();
    expect(saves.map((save) => save.payload.markdown)).toEqual(['Start. Last words. More.']);
    expect(draft.snapshot().status).toBe('saved');
    // Typing after it is saved on its own.
    type('Start. Last words. More. Again.');
    await draft.saveOrThrow();
    expect(saves.map((save) => save.payload.markdown)).toEqual([
      'Start. Last words. More.',
      'Start. Last words. More. Again.',
    ]);
  });

  it('keeps typing done while a lost join settles in one save, for the next join (#661)', async () => {
    const { draft, saves, joins, kept, type, noJoining } = session(page('A'));
    await draft.joinLive();
    const live = joins[0];
    if (!live) throw new Error('not joined');
    live.outside = page('A');
    type('A, typed');
    noJoining();
    let release = () => {};
    live.settling = new Promise((resolve) => (release = resolve));
    live.end({ kind: 'stopped', why: 'the connection was lost', saveOver: null, rejoin: true });
    await settle();
    type('A, typed more');
    await settle();
    release();
    await settle();
    await draft.saveOrThrow();
    expect(kept.at(-1)?.payload.markdown).toBe('A, typed');
    expect(saves.map((save) => save.payload.markdown)).toEqual(['A, typed more']);
  });

  it('saves its document over a session draft that differed from what it showed', async () => {
    const { draft, saves, joins, type } = session();
    await draft.joinLive();
    const live = joins[0];
    if (!live) throw new Error('not joined');
    type('Start. Mine.');
    const dropped = RevisionId.parse('r-dropped');
    live.end({ kind: 'stopped', why: 'it differed', saveOver: dropped, rejoin: false });
    await settle();
    await draft.saveOrThrow();
    expect(saves.at(-1)).toMatchObject({ basedOn: dropped });
    expect(saves.at(-1)?.payload.markdown).toBe('Start. Mine.');
  });

  it('adds a file only through its uploader’s own save', async () => {
    const { draft, joins } = session();
    await draft.joinLive();
    draft.attach([new File(['x'], 'photo.png', { type: 'image/png' })]);
    await draft.flush();
    expect([...(joins[0]?.document.map('attachments').keys() ?? [])]).toEqual(['a-photo_png']);
    expect(joins[0]?.document.text('body').toJSON()).toContain('(attachment:a-photo_png)');
  });

  it('keeps body text that reads like frontmatter in the body', async () => {
    const { draft, surface, joins } = session();
    await draft.joinLive();
    const typed = '---\ntags: x\n---\nStart.';
    surface.text = typed;
    draft.edit(typed);
    expect(joins[0]?.document.text('frontmatter').toJSON()).toBe('');
    expect(joins[0]?.document.text('body').toJSON()).toBe(typed);
    // Someone else's change shows the parts as the document holds them.
    joins[0]?.theirs(`${typed} More.`);
    expect(surface.frontmatter).toBeNull();
    expect(surface.text).toBe(`${typed} More.`);
  });

  it('edits Properties as the frontmatter part', async () => {
    const { draft, surface, joins } = session();
    await draft.joinLive();
    surface.frontmatter = '---\ntags: x\n---\n';
    draft.edit(`${surface.frontmatter}Start.`);
    expect(joins[0]?.document.text('frontmatter').toJSON()).toBe('---\ntags: x\n---\n');
    expect(joins[0]?.document.text('body').toJSON()).toBe('Start.');
  });

  it('doesn’t join while a change for the page waits on this device', async () => {
    const { draft, joins } = session(undefined, undefined, { waiting: true });
    await draft.joinLive();
    expect(joins).toHaveLength(0);
    expect(draft.participant).toBeNull();
  });

  it('leaves at once, its key wiped, when the vault locks', async () => {
    const { draft, joins, type } = session();
    await draft.joinLive();
    draft.lock();
    expect(joins[0]?.closed).toBe(true);
    type('Start. After the lock.');
    expect(joins[0]?.document.text('body').toJSON()).toBe('Start.');
  });
});

const page = (markdown: string) => newPayload({ title: 'Notes', markdown, extensions: {} });

describe('putting typing back from a live session', () => {
  it('puts only the person’s typing back by block onto the head when it can’t catch up', async () => {
    const opened = page('A\n\nB');
    const { draft, saves, joins, surface } = session(opened);
    await draft.joinLive();
    const live = joins[0];
    if (!live) throw new Error('not joined');
    live.theirs('A\n\nB\n\nTheirs');
    surface.text = 'A\n\nB\n\nTheirs\n\nMine';
    draft.edit(surface.text);
    // What others typed that this app took in is in the base, as on both sides.
    live.outside = page('A\n\nB\n\nTheirs');
    live.head = { revisionId: RevisionId.parse('r-head'), payload: page('A, saved\n\nB') };
    live.settled = {
      base: { revisionId: R0, payload: opened },
      payload: live.currentPayload(),
      saved: false,
      mine: true,
      provisional: false,
      atHead: false,
    };
    live.end({ kind: 'stopped', why: 'it can’t catch up', saveOver: null, rejoin: false });
    await settle();
    await draft.saveOrThrow();
    expect(saves.at(-1)).toMatchObject({ basedOn: 'r-head' });
    // Theirs, unsaved, is theirs to put back: never saved as the person's.
    expect(saves.at(-1)?.payload.markdown).toBe('A, saved\n\nB\n\nMine');
    // Its text grows from the head now: no session base goes with it.
    expect(saves.at(-1)?.live ?? null).toBeNull();
  });

  it('puts typing done while leaving back with the rest, in one save (#661)', async () => {
    const opened = page('A\n\nB');
    const { draft, saves, joins, type } = session(opened);
    await draft.joinLive();
    const live = joins[0];
    if (!live) throw new Error('not joined');
    type('A\n\nB\n\nMine');
    live.head = { revisionId: RevisionId.parse('r-head'), payload: page('A, saved\n\nB') };
    live.settled = {
      base: { revisionId: R0, payload: opened },
      payload: live.currentPayload(),
      saved: false,
      mine: true,
      provisional: false,
      atHead: false,
    };
    let release = () => {};
    live.settling = new Promise((resolve) => (release = resolve));
    live.end({ kind: 'stopped', why: 'it can’t catch up', saveOver: null, rejoin: false });
    await settle();
    type('A\n\nB\n\nMine\n\nMore');
    await settle();
    release();
    await settle();
    await draft.saveOrThrow();
    expect(saves).toHaveLength(1);
    expect(saves[0]).toMatchObject({ basedOn: 'r-head' });
    expect(saves[0]?.payload.markdown).toBe('A, saved\n\nB\n\nMine\n\nMore');
  });

  it('offers Merge… from the kept base where the person’s typing overlaps the head', async () => {
    const opened = page('A\n\nB');
    const { draft, saves, joins, surface } = session(opened);
    await draft.joinLive();
    const live = joins[0];
    if (!live) throw new Error('not joined');
    surface.text = 'A\n\nB, mine';
    draft.edit(surface.text);
    live.head = { revisionId: RevisionId.parse('r-head'), payload: page('A\n\nB, theirs') };
    live.settled = {
      base: { revisionId: R0, payload: opened },
      payload: live.currentPayload(),
      saved: false,
      mine: true,
      provisional: true,
      atHead: false,
    };
    live.end({ kind: 'stopped', why: 'it can’t take part', saveOver: null, rejoin: false });
    await settle();
    expect(draft.snapshot().status).toBe('conflict');
    expect(saves).toHaveLength(0);
    const versions = await draft.mergeVersions();
    expect(versions?.theirs).toBe('r-head');
    expect(versions?.basePayload?.markdown).toBe('A\n\nB');
    expect(versions?.yours.markdown).toBe('A\n\nB, mine');
  });

  it('joins with a change waiting here, puts it in by block, and withdraws it once saved', async () => {
    const opened = page('A\n\nB, mine');
    const entry = waitingEntry(opened, page('A\n\nB'));
    const { draft, joins, marked, withdrawn, held } = session(opened, page('A\n\nB\n\nC'), {
      entry,
    });
    await draft.joinLive();
    const live = joins[0];
    if (!live) throw new Error('not joined');
    expect(live.document.text('body').toJSON()).toBe('A\n\nB, mine\n\nC');
    await expect
      .poll(() => marked)
      .toEqual([{ version: 5, putIn: { sessionId: 'session-1', joinId: 'join-1', seq: 9 } }]);
    // Held back from the queue while in the session.
    expect(held()).toBe(1);
    expect(withdrawn).toEqual([]);
    live.set({ saved: true });
    expect(withdrawn).toEqual([5]);
    draft.close();
    // Let go once leaving has settled, never before.
    expect(held()).toBe(1);
    await settle();
    expect(held()).toBe(0);
  });

  it('doesn’t put a waiting change in where it overlaps the session: Merge… instead', async () => {
    const opened = page('A\n\nB, mine');
    const entry = { ...waitingEntry(opened, page('A\n\nB')), basedOn: RevisionId.parse('r-old') };
    const { draft, joins, held } = session(opened, page('A\n\nB, theirs'), { entry });
    await draft.joinLive();
    expect(joins[0]?.closed).toBe(true);
    expect(joins[0]?.typed).toBe(false);
    expect(draft.participant).toBeNull();
    expect(draft.snapshot().status).toBe('conflict');
    expect((await draft.mergeVersions())?.basePayload?.markdown).toBe('A\n\nB');
    // Held while the person settles it, so the queue doesn't send it meanwhile.
    expect(held()).toBe(1);
    draft.close();
    expect(held()).toBe(0);
  });

  it('leaves a change made with no session, on the head, to the queue, for the saver to fold in', async () => {
    const opened = page('A\n\nB, mine');
    const entry = { ...waitingEntry(opened, page('x')), live: null, payload: page('A\n\nB') };
    const { draft, joins, held } = session(opened, page('A\n\nB, theirs'), { entry });
    await draft.joinLive();
    expect(joins[0]?.closed).toBe(true);
    expect(draft.participant).toBeNull();
    expect(draft.snapshot().status).not.toBe('conflict');
    expect(held()).toBe(0);
  });

  it('puts in a waiting change made with no session from the version it was based on', async () => {
    const opened = page('A\n\nB, mine');
    const entry = { ...waitingEntry(opened, page('x')), live: null, payload: page('A\n\nB') };
    const { draft, joins } = session(opened, page('A\n\nB\n\nC'), { entry });
    await draft.joinLive();
    expect(joins[0]?.document.text('body').toJSON()).toBe('A\n\nB, mine\n\nC');
  });

  it('keeps what leaving can’t save on this device, beside its base', async () => {
    const { draft, joins, kept, type } = session(page('A'));
    await draft.joinLive();
    const live = joins[0];
    if (!live) throw new Error('not joined');
    live.outside = page('A');
    type('A, typed');
    expect(draft.hasUnsaved()).toBe(true);
    expect(await draft.keepOnDevice()).toBe(true);
    expect(kept.at(-1)?.payload.markdown).toBe('A, typed');
    expect(kept.at(-1)?.live.base.markdown).toBe('A');
    // Kept as it is now: nothing is lost if the tab closes.
    expect(draft.hasUnsaved()).toBe(false);
    type('A, typed more');
    expect(draft.hasUnsaved()).toBe(true);
    draft.close();
    await settle();
    expect(kept.at(-1)?.payload.markdown).toBe('A, typed more');
  });
});

function waitingEntry(payload: PagePayload, base: PagePayload): QueuedPage {
  return {
    kind: 'page',
    id: PageId.parse('p1'),
    spaceId: SpaceId.parse('s1'),
    newPage: null,
    basedOn: R0,
    region: null,
    payload,
    version: 5,
    sending: null,
    picks: {},
    failure: null,
    at: 1,
    live: {
      base,
      typed: payload,
      sessionId: LiveSessionId.parse('earlier'),
      joinId: JoinId.parse('earlier-join'),
      baseSeq: 0,
      seq: 2,
      putIn: null,
    },
  };
}

describe('putting a waiting change in, carefully', () => {
  it('puts the text in as the person’s change though someone else added a file meanwhile', async () => {
    const opened = page('A\n\nB, mine');
    const entry = waitingEntry(opened, page('A\n\nB'));
    const photo = {
      id: 'a-photo',
      name: 'photo.png',
      mediaType: 'image/png',
      size: 1,
      key: 'A'.repeat(43),
      blobHash: 'A'.repeat(43),
    } as AttachmentRef;
    const shared = { ...page('A\n\nB\n\n![photo](attachment:a-photo)'), attachments: [photo] };
    const { draft, joins } = session(opened, shared, { entry });
    await draft.joinLive();
    const live = joins[0];
    if (!live) throw new Error('not joined');
    // As the person's own change, never through a file's save.
    expect(live.typed).toBe(true);
    expect(live.document.text('body').toJSON()).toBe(
      'A\n\nB, mine\n\n![photo](attachment:a-photo)',
    );
    expect([...live.document.map('attachments').keys()]).toEqual(['a-photo']);
  });

  it('doesn’t put in a change saved into from elsewhere since this view saw it', async () => {
    const opened = page('A\n\nB, mine');
    const entry = waitingEntry(opened, page('A\n\nB'));
    const { draft, joins, held } = session(opened, page('A\n\nB\n\nC'), { entry, seen: 4 });
    await draft.joinLive();
    expect(joins[0]?.closed).toBe(true);
    expect(joins[0]?.typed).toBe(false);
    expect(held()).toBe(0);
  });

  it('keeps a change put in until a compared draft holds all it put in, not only this join’s', async () => {
    const opened = page('A\n\nB, mine');
    const entry = waitingEntry(opened, page('A\n\nB'));
    const { draft, joins, withdrawn } = session(opened, page('A\n\nB\n\nC'), { entry });
    await draft.joinLive();
    const live = joins[0];
    if (!live) throw new Error('not joined');
    // Saved, as this join counts it, but the old join's typing isn't in a draft yet.
    live.holds = false;
    live.set({ saved: true });
    expect(withdrawn).toEqual([]);
    expect(draft.hasUnsaved()).toBe(false);
    live.holds = true;
    live.set({ saved: true });
    expect(withdrawn).toEqual([5]);
  });

  it('keeps showing a change still kept when a join with nothing new lapses', async () => {
    const opened = page('A\n\nB, mine');
    const entry = waitingEntry(opened, page('A\n\nB'));
    // The session holds the change already: putting it in adds nothing.
    const { draft, joins, surface, withdrawn } = session(opened, opened, { entry });
    await draft.joinLive();
    const live = joins[0];
    if (!live) throw new Error('not joined');
    live.holds = false;
    live.settled = {
      base: { revisionId: R0, payload: page('A\n\nB') },
      payload: live.currentPayload(),
      saved: false,
      mine: false,
      provisional: false,
      atHead: true,
    };
    live.end({ kind: 'stopped', why: 'the connection was lost', saveOver: null, rejoin: true });
    await settle();
    // Not the head without it: the change as it waits, for the next join to put in.
    expect(surface.text).toBe('A\n\nB, mine');
    expect(withdrawn).toEqual([]);
  });

  it('withdraws a change put in when leaving saves it, before the page showed it saved', async () => {
    const opened = page('A\n\nB, mine');
    const entry = waitingEntry(opened, page('A\n\nB'));
    const { draft, joins, withdrawn } = session(opened, page('A\n\nB\n\nC'), { entry });
    await draft.joinLive();
    const live = joins[0];
    if (!live) throw new Error('not joined');
    expect(live.status().saved).toBe(false);
    // Leaving's own save lands it, in a draft that holds what was put in.
    live.leave = async () => true;
    live.holds = true;
    draft.close();
    await settle();
    expect(withdrawn).toEqual([5]);
  });
});

describe('a change another tab keeps for its live session', () => {
  it('waits while this view shows that change', async () => {
    const opened = page('A\n\nB, mine');
    const entry = waitingEntry(opened, page('A\n\nB'));
    const { draft, joins } = session(opened, page('A\n\nB\n\nC'), { entry, claimed: true });
    await draft.joinLive();
    expect(joins).toHaveLength(0);
  });

  it('joins without it when this view opened the draft', async () => {
    const opened = page('A\n\nB');
    const entry = waitingEntry(page('A\n\nB, mine'), page('A\n\nB'));
    const { draft, joins } = session(opened, opened, { entry, claimed: true, seen: null });
    await draft.joinLive();
    expect(joins[0]?.document.text('body').toJSON()).toBe('A\n\nB');
    expect(draft.participant).not.toBeNull();
  });

  it('puts it in, as it waits, once no tab holds it and this view changed nothing', async () => {
    const opened = page('A\n\nB');
    const entry = waitingEntry(page('A\n\nB, mine'), page('A\n\nB'));
    const { draft, joins } = session(opened, page('A\n\nB\n\nC'), { entry, seen: null });
    await draft.joinLive();
    expect(joins[0]?.document.text('body').toJSON()).toBe('A\n\nB, mine\n\nC');
    // The change is this view's now: what it keeps next goes into it.
    expect(draft.participant).not.toBeNull();
  });

  it('shows the change it can’t put in, for Merge…, when this view opened the draft', async () => {
    const opened = page('A\n\nB');
    const entry = {
      ...waitingEntry(page('A\n\nB, mine'), page('A\n\nB')),
      basedOn: RevisionId.parse('r-old'),
    };
    const { draft, surface } = session(opened, page('A\n\nB, theirs'), { entry, seen: null });
    await draft.joinLive();
    expect(draft.snapshot().status).toBe('conflict');
    expect(surface.text).toBe('A\n\nB, mine');
    expect((await draft.mergeVersions())?.yours.markdown).toBe('A\n\nB, mine');
  });

  it('takes no head as a conflict while it shows a change kept for a session, untouched', async () => {
    const opened = page('A\n\nB, mine');
    const entry = waitingEntry(opened, page('A\n\nB'));
    const { draft } = session(opened, page('A\n\nB'), { entry, claimed: true });
    draft.noticeHead(RevisionId.parse('r-someone'));
    await settle();
    expect(draft.snapshot().status).not.toBe('conflict');
    // Once no tab holds it, a head someone else saved is a conflict again.
    const free = session(opened, page('A\n\nB'), { entry });
    free.draft.noticeHead(RevisionId.parse('r-someone'));
    await settle();
    expect(free.draft.snapshot().status).toBe('conflict');
  });
});

describe('catching up from an ended live session', () => {
  const caught = newPayload({ title: 'Notes', markdown: 'Start. Left unsaved.', extensions: {} });
  const R9 = RevisionId.parse('r9');

  it('goes on from the draft caught up, says so, and joins again', async () => {
    const { draft, surface, joins } = session(undefined, caught, {
      catchUp: { revisionId: R9, payload: caught },
    });
    await draft.joinLive();
    expect(draft.snapshot().markdown).toBe('Start. Left unsaved.');
    expect(surface.text).toBe('Start. Left unsaved.');
    expect(draft.snapshot().liveNotice).toBe(
      'Saved what a live session that ended had left unsaved.',
    );
    // Its own: the head caught up is no one else's save.
    draft.noticeHead(R9);
    expect(draft.snapshot().status).toBe('saved');
    await expect.poll(() => joins.length, { timeout: 3_000 }).toBe(1);
    expect(draft.snapshot().live?.kind).toBe('live');
  });

  it('takes the draft caught up as its own when the page heard of it first', async () => {
    let heard = () => {};
    const s = session(undefined, caught, {
      catchUp: { revisionId: R9, payload: caught },
      duringJoin: () => heard(),
    });
    heard = () => s.draft.noticeHead(R9);
    await s.draft.joinLive();
    expect(s.draft.snapshot().markdown).toBe('Start. Left unsaved.');
    expect(s.draft.snapshot().status).toBe('saved');
    await expect.poll(() => s.joins.length, { timeout: 3_000 }).toBe(1);
  });

  it('leaves typing done meanwhile as it is, to meet the draft caught up as someone else’s', async () => {
    let typing = () => {};
    const s = session(undefined, caught, {
      catchUp: { revisionId: R9, payload: caught },
      duringJoin: () => typing(),
    });
    typing = () => s.type('Start. Typed meanwhile.');
    await s.draft.joinLive();
    expect(s.draft.snapshot().markdown).toBe('Start. Typed meanwhile.');
    s.draft.noticeHead(R9);
    expect(s.draft.snapshot().status).toBe('conflict');
  });
});

describe('publishing in a live session', () => {
  it('takes the press as the editor holds it, and whether the editor is behind', async () => {
    const { draft, surface, joins } = session();
    await draft.joinLive();
    const [participant] = joins;
    if (!participant) throw new Error('not joined');
    let behind = true;
    (surface as FakeSurface & { behind: () => boolean }).behind = () => behind;
    // Typed, not yet reported.
    surface.text = 'Start. Pressed.';
    const pressed = draft.pressLive();
    // What others type after the press isn't the press.
    participant.theirs('Start. Pressed. Theirs after.');
    expect(await pressed?.(async (head) => head)).toBe(R0);
    behind = false;
    await draft.pressLive()?.(async (head) => head);
    expect(participant.published).toEqual([
      { behind: true, text: 'Start. Pressed.' },
      { behind: false, text: 'Start. Pressed. Theirs after.' },
    ]);
  });

  it('is null outside a session', async () => {
    const { draft, noJoining } = session();
    noJoining();
    expect(draft.pressLive()).toBeNull();
  });
});
