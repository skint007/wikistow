// Writers outside a live session (ADR 0015 decision 8, step 7): a draft
// saved from outside while people edit is folded into the session by its
// saver, through the server's fold grant, with the session's text kept
// where both changed one part and a note for Review.
import { agentTools, pageOperations as pages } from '@wikistow/client';
import {
  changeText,
  joinLive,
  participantPorts,
  sessionState,
  type LiveParticipant,
} from '@wikistow/client/live';
import type { PageId, SpaceId } from '@wikistow/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { listenForTreeChanges } from '@wikistow/server';
import { personWithVault } from './support/content.ts';
import { createTestApp, type TestApp } from './support/harness.ts';
import { invite, library, shareFolder, type Person } from './support/sharing.ts';

let t: TestApp;
let listening: Awaited<ReturnType<typeof listenForTreeChanges>>;
const open: LiveParticipant[] = [];
beforeAll(async () => {
  t = await createTestApp();
  listening = await listenForTreeChanges(t.config.databaseUrl, () => {}, {
    onLive: (payload) => t.live.notified(payload),
  });
});
afterAll(async () => {
  for (const participant of open) participant.close();
  await listening.close();
  await t.drop();
});

type Page = { spaceId: SpaceId; pageId: PageId };

async function sharedPage() {
  const [owner, editor] = await Promise.all([personWithVault(t), personWithVault(t)]);
  const lib = await library(owner);
  const shareId = await shareFolder(owner.ctx, {
    spaceId: lib.spaceId,
    rootId: lib.shared,
    people: [await invite(owner, editor, 'editor')],
  });
  return { owner, editor, lib, page: lib.page, shareId };
}

async function draftOf(person: Person, page: Page) {
  const { heads } = await pages.loadPage(person.ctx, page.pageId);
  if (!heads.draftHead) throw new Error('no draft');
  const opened = await pages.openRevisionOf(person.ctx, page, 'draft', heads.draftHead, {
    fresh: true,
  });
  if (opened.opened.kind !== 'current') throw new Error('newer format');
  return { revisionId: heads.draftHead, payload: opened.opened.payload, region: opened.region };
}

/** Saves held back until `release`, so a save from outside lands first. */
function gate() {
  let release = () => {};
  const open = new Promise<void>((resolve) => (release = resolve));
  return { open, release };
}

async function join(
  person: Person,
  page: Page,
  { held, landed }: { held?: Promise<void>; landed?: () => void } = {},
) {
  const draft = await draftOf(person, page);
  const ports = participantPorts(person.ctx, page, () => draft.region, {
    live: { fetch: person.browser.fetch },
  });
  if (held || landed) {
    const save = ports.saveDraft.bind(ports);
    ports.saveDraft = async (input) => {
      await held;
      const result = await save(input);
      landed?.();
      return result;
    };
  }
  const joined = await joinLive(ports, draft);
  if (!('start' in joined)) throw new Error(`not joined: ${JSON.stringify(joined)}`);
  joined.start();
  open.push(joined);
  return joined;
}

const body = (participant: LiveParticipant) => participant.document.text('body').toJSON();

const setBody = (participant: LiveParticipant, text: string) =>
  participant.edit((document) => changeText(document.text('body'), text));

/** A save from outside the session, as the CLI or an agent makes one: on the head, as it is. */
async function saveOutside(person: Person, page: Page, markdown: (now: string) => string) {
  const head = await draftOf(person, page);
  const written = await pages.saveDraft(person.ctx, {
    page,
    basedOn: head.revisionId,
    payload: { ...head.payload, markdown: markdown(head.payload.markdown) },
  });
  return written.revisionId;
}

describe('a draft saved from outside a live session', () => {
  it('is folded in, and nobody leaves the session', async () => {
    const { owner, editor, page } = await sharedPage();
    const mine = await join(owner, page);
    const theirs = await join(editor, page);
    setBody(mine, 'Inside.\n\ndraft words\n');
    await expect.poll(() => theirs.status().saved, { timeout: 30_000 }).toBe(true);

    const outside = await saveOutside(owner, page, (now) => `${now}\nFrom outside.\n`);
    await expect.poll(() => body(mine), { timeout: 30_000 }).toContain('From outside.');
    await expect.poll(() => body(theirs), { timeout: 30_000 }).toBe(body(mine));
    expect(body(mine)).toMatch(/^Inside\.\n\ndraft words\n+From outside\.\n$/);
    await expect.poll(() => mine.status().saved, { timeout: 30_000 }).toBe(true);
    await expect.poll(() => theirs.status().saved, { timeout: 30_000 }).toBe(true);
    expect(mine.status().state).toEqual({ kind: 'live' });
    expect(theirs.status().state).toEqual({ kind: 'live' });
    // Nothing overlapped: no note.
    expect(mine.status().notes).toEqual([]);
    // The head is the outsider's draft itself, or a session draft on top of it.
    const head = await draftOf(editor, page);
    expect(head.payload.markdown).toBe(body(mine));
    if (head.revisionId !== outside) {
      expect(sessionState(head.payload, head.revisionId, mine.sessionId)).not.toBeNull();
    }

    // Typing goes on in the session as before.
    setBody(theirs, `${body(theirs)}After.\n`);
    await expect.poll(() => body(mine)).toContain('After.');
    await expect.poll(() => mine.status().saved, { timeout: 30_000 }).toBe(true);
  });

  it('a newcomer counts a fold placed without a save, and saves on top of it', async () => {
    const { owner, editor, page } = await sharedPage();
    const mine = await join(owner, page);
    const theirs = await join(editor, page);
    await expect.poll(() => mine.status().people.length).toBe(1);
    const outside = await saveOutside(editor, page, (now) => `${now}\n\nAdded outside.\n`);
    await expect.poll(() => theirs.status().saved, { timeout: 30_000 }).toBe(true);
    await expect.poll(() => body(theirs), { timeout: 30_000 }).toContain('Added outside.');
    expect((await draftOf(owner, page)).revisionId).toBe(outside);
    const late = await join(owner, page);
    expect(body(late)).toBe(body(theirs));
    await mine.leave();
    await theirs.leave();
    setBody(late, `${body(late)}Late.\n`);
    await expect.poll(() => late.status().saved, { timeout: 40_000 }).toBe(true);
    expect((await draftOf(owner, page)).payload.markdown).toContain('Late.');
  });

  it('folds in a session draft whose writer went without sending what it holds', async () => {
    const { owner, editor, page } = await sharedPage();
    let crash = () => {};
    const mine = await join(owner, page, { landed: () => crash() });
    const theirs = await join(editor, page);
    await expect.poll(() => mine.status().people.length).toBe(1);
    // Its save lands, and the app is gone before it sends the change.
    crash = () => mine.close();
    expect(await mine.commitOwn({ texts: { body: `${body(mine)}\n\nSaved, never sent.\n` } })).toBe(
      false,
    );
    await expect.poll(() => body(theirs), { timeout: 60_000 }).toContain('Saved, never sent.');
    expect(theirs.status().state).toEqual({ kind: 'live' });
    await expect.poll(() => theirs.status().saved, { timeout: 30_000 }).toBe(true);
    const settled = await draftOf(editor, page);
    expect(settled.payload.markdown).toContain('Saved, never sent.');
    // Folded once, and then quiet: no more saves while nobody types.
    await new Promise((resolve) => setTimeout(resolve, 4_000));
    expect((await draftOf(editor, page)).revisionId).toBe(settled.revisionId);
  });

  it('the app that folded a gone writer’s draft can leave and join again', async () => {
    const { owner, editor, page } = await sharedPage();
    let crash = () => {};
    const mine = await join(owner, page, { landed: () => crash() });
    let theirs = await join(editor, page);
    await expect.poll(() => mine.status().people.length).toBe(1);
    // A save of the session first, so the draft the crash builds on is one of its own.
    setBody(mine, `${body(mine)}\n\nSaved first.\n`);
    await expect.poll(() => theirs.status().saved, { timeout: 30_000 }).toBe(true);
    crash = () => mine.close();
    await mine.commitOwn({ texts: { body: `${body(mine)}\n\nNever sent.\n` } });
    await expect.poll(() => body(theirs), { timeout: 60_000 }).toContain('Never sent.');
    await expect.poll(() => theirs.status().saved, { timeout: 30_000 }).toBe(true);
    await theirs.leave();
    theirs = await join(editor, page);
    expect(body(theirs)).toContain('Never sent.');
    await new Promise((resolve) => setTimeout(resolve, 6_000));
    expect(theirs.status().state).toEqual({ kind: 'live' });
    setBody(theirs, `${body(theirs)}Back.\n`);
    await expect.poll(() => theirs.status().saved, { timeout: 30_000 }).toBe(true);
  }, 180_000);

  it('a newcomer after a gone writer’s draft was folded stays in the session', async () => {
    const { owner, editor, page } = await sharedPage();
    let crash = () => {};
    const mine = await join(owner, page, { landed: () => crash() });
    const theirs = await join(editor, page);
    await expect.poll(() => mine.status().people.length).toBe(1);
    crash = () => mine.close();
    await mine.commitOwn({ texts: { body: `${body(mine)}\n\nNever sent.\n` } });
    await expect.poll(() => body(theirs), { timeout: 60_000 }).toContain('Never sent.');
    await expect.poll(() => theirs.status().saved, { timeout: 30_000 }).toBe(true);
    const late = await join(owner, page);
    expect(body(late)).toBe(body(theirs));
    await new Promise((resolve) => setTimeout(resolve, 35_000));
    expect(JSON.stringify(late.status().state)).toBe(JSON.stringify({ kind: 'live' }));
    setBody(late, `${body(late)}Later.\n`);
    await expect.poll(() => late.status().saved, { timeout: 30_000 }).toBe(true);
  }, 180_000);

  it('folds without a save when the session changed nothing since', async () => {
    const { owner, editor, page } = await sharedPage();
    const mine = await join(owner, page);
    const theirs = await join(editor, page);
    await expect.poll(() => mine.status().people.length).toBe(1);
    const outside = await saveOutside(editor, page, (now) => `${now}\n\nAdded outside.\n`);
    await expect.poll(() => body(theirs), { timeout: 30_000 }).toContain('Added outside.');
    await expect.poll(() => body(mine), { timeout: 30_000 }).toBe(body(theirs));
    // The outsider's draft stays the head, and counts as the session's for both.
    await expect.poll(() => mine.status().saved, { timeout: 30_000 }).toBe(true);
    await expect.poll(() => theirs.status().saved, { timeout: 30_000 }).toBe(true);
    expect((await draftOf(owner, page)).revisionId).toBe(outside);
    setBody(theirs, `${body(theirs)}More.\n`);
    await expect.poll(() => theirs.status().saved).toBe(false);
    await expect.poll(() => theirs.status().saved, { timeout: 30_000 }).toBe(true);
    expect((await draftOf(owner, page)).payload.markdown).toContain('More.');
  });

  it('keeps the session’s text where both changed a part, and offers it for Review', async () => {
    const { owner, editor, page } = await sharedPage();
    await saveOutside(owner, page, () => 'First line.\n\nSecond line.\n');
    const saves = gate();
    const mine = await join(owner, page, { held: saves.open });
    const theirs = await join(editor, page, { held: saves.open });

    // The session changes the first paragraph, and an outsider changes it too, before a save.
    setBody(mine, 'First line, from the session.\n\nSecond line.\n');
    await expect.poll(() => body(theirs)).toBe(body(mine));
    const outside = await saveOutside(owner, page, (now) =>
      now.replace('First line.', 'First line, from outside.'),
    );
    saves.release();
    await expect.poll(() => mine.status().notes.length, { timeout: 30_000 }).toBe(1);
    await expect.poll(() => theirs.status().notes.length, { timeout: 30_000 }).toBe(1);
    const [note] = theirs.status().notes;
    expect(note?.revision).toBe(outside);
    expect(note?.parts).toEqual(['body:0-1']);
    expect(body(mine)).toBe('First line, from the session.\n\nSecond line.\n');
    await expect.poll(() => mine.status().saved, { timeout: 30_000 }).toBe(true);
    // The draft carries the note, so whoever opens it later sees it too.
    const head = await draftOf(editor, page);
    expect(head.payload.extensions['wikistow.overlaps']).toEqual({
      format: 1,
      revisions: [{ revision: outside, parts: ['body:0-1'] }],
    });

    // Review offers that part, and taking theirs is the person's own change.
    const opened = await theirs.openNote(outside);
    if (!opened) throw new Error('the note didn’t open');
    const merge = theirs.reviewMerge(opened);
    expect(merge.overlaps).toHaveLength(1);
    const [overlap] = merge.overlaps;
    if (overlap?.part !== 'body') throw new Error('not a body overlap');
    expect(overlap.theirs).toContain('from outside');
    expect(theirs.applyReview(opened, merge, { [overlap.id]: 'theirs' })).toBe(true);
    await expect.poll(() => body(mine)).toBe('First line, from outside.\n\nSecond line.\n');
    await expect.poll(() => mine.status().notes).toEqual([]);
    await expect.poll(() => theirs.status().saved, { timeout: 30_000 }).toBe(true);
    const after = await draftOf(owner, page);
    expect(after.payload.extensions['wikistow.overlaps']).toBeUndefined();
  });

  it('dismissing a note drops theirs there for good', async () => {
    const { owner, editor, page } = await sharedPage();
    await saveOutside(owner, page, () => 'Only line.\n');
    const saves = gate();
    const mine = await join(owner, page, { held: saves.open });
    const theirs = await join(editor, page, { held: saves.open });
    setBody(mine, 'Only line, ours.\n');
    await expect.poll(() => body(theirs)).toBe(body(mine));
    const outside = await saveOutside(owner, page, () => 'Only line, theirs.\n');
    saves.release();
    await expect.poll(() => theirs.status().notes.length, { timeout: 30_000 }).toBe(1);
    theirs.dismissNote(outside);
    await expect.poll(() => mine.status().notes).toEqual([]);
    expect(body(mine)).toBe('Only line, ours.\n');
    // A note deleted never comes back, whoever writes it again.
    mine.change({
      entries: [
        {
          root: 'overlaps',
          key: outside,
          value: JSON.stringify({ revision: outside, parts: ['body:0-1'] }),
        },
      ],
    });
    await expect.poll(() => body(theirs)).toBe(body(mine));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(theirs.status().notes).toEqual([]);
  });
});

describe('a live session’s saves', () => {
  it('rename a link to its page’s new title, in a save’s own join', async () => {
    const { owner, editor, lib, page } = await sharedPage();
    const target = {
      spaceId: lib.spaceId,
      pageId: await pages.createPage(owner.ctx, {
        spaceId: lib.spaceId,
        parentId: lib.shared,
        title: 'Recipes',
      }),
    };
    await pages.publishPage(owner.ctx, target);
    await saveOutside(owner, page, () => 'See [[Recipes]].\n');
    // The editor's app saves, and reads the tree once the page is renamed.
    const theirs = await join(editor, page);
    const mine = await join(owner, page);
    await pages.editDraft(owner.ctx, target, { title: 'Dinners' });
    await pages.publishPage(owner.ctx, target);

    setBody(mine, 'See [[Recipes]].\n\nMore.\n');
    await expect.poll(() => body(mine), { timeout: 30_000 }).toBe('See [[Dinners]].\n\nMore.\n');
    await expect.poll(() => body(theirs)).toBe(body(mine));
    await expect.poll(() => theirs.status().saved, { timeout: 30_000 }).toBe(true);
    const head = await draftOf(editor, page);
    expect(head.payload.markdown).toBe('See [[Dinners]].\n\nMore.\n');
    expect(sessionState(head.payload, head.revisionId, mine.sessionId)).not.toBeNull();
    expect(mine.status().state).toEqual({ kind: 'live' });
  });

  it('restore a version through the session, as the restorer’s own change', async () => {
    const { owner, editor, page } = await sharedPage();
    const mine = await join(owner, page);
    const theirs = await join(editor, page);
    setBody(mine, 'Version one.\n');
    await expect.poll(() => mine.status().saved, { timeout: 30_000 }).toBe(true);
    await pages.publishPage(owner.ctx, page);
    const published = (await pages.loadPage(owner.ctx, page.pageId)).heads.publishedHead;
    if (!published) throw new Error('not published');
    setBody(mine, 'Version two.\n');
    await expect.poll(() => mine.status().saved, { timeout: 30_000 }).toBe(true);

    const restored = await theirs.restoreThrough((input) =>
      pages.restorePublished(editor.ctx, page, published, input),
    );
    expect(restored).toBe(true);
    await expect.poll(() => body(mine)).toBe('Version one.\n');
    expect(body(theirs)).toBe('Version one.\n');
    await expect.poll(() => theirs.status().saved, { timeout: 30_000 }).toBe(true);
    const head = await draftOf(owner, page);
    expect(head.payload.markdown).toBe('Version one.\n');
    expect(sessionState(head.payload, head.revisionId, mine.sessionId)).not.toBeNull();
    expect(mine.status().state).toEqual({ kind: 'live' });
    // Typing goes on after it, saved as the session's.
    setBody(mine, 'Version one, and more.\n');
    await expect.poll(() => mine.status().saved, { timeout: 30_000 }).toBe(true);
    expect(theirs.status().state).toEqual({ kind: 'live' });
  });
});

describe('an approved chat edit', () => {
  const proposal = async (person: Person, page: Page, markdown: (now: string) => string) => {
    const head = await draftOf(person, page);
    return {
      kind: 'edit-page' as const,
      spaceId: page.spaceId,
      pageId: page.pageId,
      base: head.revisionId,
      shareId: head.region.kind === 'share' ? head.region.shareId : null,
      before: { title: head.payload.title, markdown: head.payload.markdown },
      title: head.payload.title,
      markdown: markdown(head.payload.markdown),
    };
  };

  it('is merged onto a head that moved on since it was proposed', async () => {
    const { owner, page } = await sharedPage();
    await saveOutside(owner, page, () => 'One.\n\nTwo.\n');
    const edit = await proposal(owner, page, () => 'One, edited.\n\nTwo.\n');
    await saveOutside(owner, page, () => 'One.\n\nTwo, typed meanwhile.\n');
    const applied = await agentTools.applyProposal(owner.ctx, edit);
    expect(applied.status).toBe('done');
    expect((await draftOf(owner, page)).payload.markdown).toBe(
      'One, edited.\n\nTwo, typed meanwhile.\n',
    );
  });

  it('is refused as stale where it overlaps what changed meanwhile', async () => {
    const { owner, page } = await sharedPage();
    await saveOutside(owner, page, () => 'One.\n');
    const edit = await proposal(owner, page, () => 'One, edited.\n');
    await saveOutside(owner, page, () => 'One, typed meanwhile.\n');
    const applied = await agentTools.applyProposal(owner.ctx, edit);
    expect(applied.status).toBe('stale');
    expect((await draftOf(owner, page)).payload.markdown).toBe('One, typed meanwhile.\n');
  });
});
