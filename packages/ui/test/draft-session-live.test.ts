// A draft session in a page's live session (ADR 0015 step 6): the shared
// document holds what's typed, the session's saver saves, and when the
// session ends the draft goes on as before and joins the next one.
import {
  linksInUse,
  newPayload,
  OWNER_REGION,
  RevisionId,
  type AttachmentRef,
  type pageOperations,
  type PagePayload,
} from '@wikistow/client';
import {
  changeText,
  documentFromPayload,
  type LiveDocument,
  type LiveParticipant,
  type ParticipantState,
  type ParticipantStatus,
} from '@wikistow/client/live';
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
) {
  const surface = new FakeSurface(payload.markdown);
  const saves: Parameters<DraftPorts['saveDraft']>[0][] = [];
  const joins: FakeParticipant[] = [];
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
    live: {
      allowed: () => joinable,
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

  it('leaves at once, its key wiped, when the vault locks', async () => {
    const { draft, joins, type } = session();
    await draft.joinLive();
    draft.lock();
    expect(joins[0]?.closed).toBe(true);
    type('Start. After the lock.');
    expect(joins[0]?.document.text('body').toJSON()).toBe('Start.');
  });
});
