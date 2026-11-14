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
  /** Someone else's change. */
  theirs(text: string) {
    this.document.edit(() => changeText(this.document.text('body'), text), 'remote');
    for (const listener of this.#changes) listener(false);
  }
  async saveNow() {
    this.set({ saved: true });
    return true;
  }
  async settle() {
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
  }: {
    waiting?: boolean;
    /** The page's change waiting here, which a join puts in. */
    entry?: QueuedPage;
    /** The version of that change this view last saw. */
    seen?: number;
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
      async join() {
        const participant = new FakeParticipant(shared);
        joins.push(participant);
        return participant as unknown as LiveParticipant;
      },
    },
  };
  const draft = new DraftSession(
    { base: R0, payload, region: OWNER_REGION },
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

  it('leaves a waiting change based on the head to the queue, for the saver to fold in', async () => {
    const opened = page('A\n\nB, mine');
    const entry = waitingEntry(opened, page('A\n\nB'));
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

  it('withdraws a change put in when leaving saves it, before the page showed it saved', async () => {
    const opened = page('A\n\nB, mine');
    const entry = waitingEntry(opened, page('A\n\nB'));
    const { draft, joins, withdrawn } = session(opened, page('A\n\nB\n\nC'), { entry });
    await draft.joinLive();
    const live = joins[0];
    if (!live) throw new Error('not joined');
    expect(live.status().saved).toBe(false);
    // Leaving's own save lands it.
    live.leave = async () => true;
    draft.close();
    await settle();
    expect(withdrawn).toEqual([5]);
  });
});
