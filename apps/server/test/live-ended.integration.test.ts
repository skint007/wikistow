// Catching up from an ended live session, and publishing during one (ADR
// 0015 decisions 5 and 12, protocol section 5.10, **Saving** and
// **Ending**), through the client's participant and the real server: the
// next editor saves what a session that ended left unsaved, with the
// server's grant, checked before anything is saved; and a publish saves
// what the editor showed at the press while the saver holds its saves.
import { newId, pageOperations as pages } from '@wikistow/client';
import { ApiError } from '@wikistow/client/api';
import {
  catchUpEnded,
  changeText,
  joinLive,
  LivePublishStopped,
  participantPorts,
  type CaughtUp,
  type LiveParticipant,
} from '@wikistow/client/live';
import {
  JoinId,
  liveRoutes,
  type PageId,
  type RevisionId,
  type SpaceId,
} from '@wikistow/contracts';
import { listenForTreeChanges } from '@wikistow/server';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
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
  await shareFolder(owner.ctx, {
    spaceId: lib.spaceId,
    rootId: lib.shared,
    people: [await invite(owner, editor, 'editor')],
  });
  return { owner, editor, page: lib.page };
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

/** `person`'s app, joining the page's session; its saves wait while `saving.held`. */
async function joined(
  person: Person,
  page: Page,
  { saving = { held: false }, caught }: { saving?: { held: boolean }; caught?: CaughtUp[] } = {},
) {
  const draft = await draftOf(person, page);
  const ports = participantPorts(person.ctx, page, () => draft.region, {
    live: { fetch: person.browser.fetch },
    caughtUp: (result) => caught?.push(result),
  });
  const save = ports.saveDraft.bind(ports);
  ports.saveDraft = async (input) => {
    // Never lands while held, as from a tab about to close.
    while (saving.held) await new Promise((resolve) => setTimeout(resolve, 50));
    return save(input);
  };
  return joinLive(ports, draft);
}

async function join(person: Person, page: Page, saving?: { held: boolean }) {
  const result = await joined(person, page, saving ? { saving } : {});
  if (!('start' in result)) throw new Error(`not joined: ${JSON.stringify(result)}`);
  result.start();
  open.push(result);
  return result;
}

const body = (participant: LiveParticipant) => participant.document.text('body').toJSON();
const type = (participant: LiveParticipant, text: string) =>
  participant.edit((document) => {
    const now = document.text('body').toJSON();
    changeText(document.text('body'), now + text);
  });

const liveOf = (person: Person, pageId: PageId) =>
  person.ctx.api.call(liveRoutes.getLive, { params: { pageId } });

/**
 * End `participant`'s session with its last typing unsaved, as when its tab
 * closed within a second of typing and then access to the page changed:
 * the session is kept, read-only, and served once its joins have left.
 */
async function endUnsaved(person: Person, participant: LiveParticipant, page: Page) {
  await participant.flush();
  await person.ctx.api.call(liveRoutes.end, { params: { sessionId: participant.sessionId } });
  participant.close();
  await t.db.execute(sql`
    update live_joins set left_at = now() - interval '2 minutes',
      last_message_at = now() - interval '2 minutes'
    where session_id = ${participant.sessionId}`);
  await expect
    .poll(async () => (await liveOf(person, page.pageId)).ended?.sessionId)
    .toBe(participant.sessionId);
}

/** Publish `draftHead` as `person`, only while it is the draft head. */
const publishAs = (person: Person, page: Page) => async (draftHead: RevisionId) => {
  const { heads } = await pages.loadPage(person.ctx, page.pageId);
  return pages.publishPage(person.ctx, page, {
    expected: { draftHead, publishedHead: heads.publishedHead },
  });
};

async function publishedOf(person: Person, page: Page) {
  const { heads } = await pages.loadPage(person.ctx, page.pageId);
  if (!heads.publishedHead) return null;
  const opened = await pages.openRevisionOf(person.ctx, page, 'published', heads.publishedHead);
  return opened.opened.kind === 'current' ? opened.opened.payload.markdown : null;
}

describe('an ended live session with unsaved typing', () => {
  it('is caught up by the next editor, on top of its last draft, and then deleted', async () => {
    const { owner, editor, page } = await sharedPage();
    const saving = { held: true };
    const theirs = await join(editor, page, saving);
    type(theirs, '\n\nNever saved.\n');
    await endUnsaved(editor, theirs, page);

    const caught: CaughtUp[] = [];
    const result = await joined(owner, page, { caught });
    expect(result).toMatchObject({ kind: 'caught-up' });
    expect(caught).toMatchObject([{ kind: 'saved', overlapped: 0 }]);
    const head = await draftOf(owner, page);
    expect(head.payload.markdown).toContain('Never saved.');
    // Marked with the ended session, so no later catch-up puts it in again,
    // naming the draft it was checked against, so it counts as no session's draft.
    const mark = head.payload.extensions['wikistow.live'] as { session: string; revision: string };
    expect(mark.session).toBe(theirs.sessionId);
    expect(mark.revision).not.toBe(head.revisionId);
    // Its Saved notice lets the server delete it.
    await expect.poll(async () => (await liveOf(owner, page.pageId)).ended).toBeNull();

    // The next join starts afresh, from the draft caught up.
    const mine = await join(owner, page);
    expect(body(mine)).toContain('Never saved.');
  });

  it('is merged onto a draft saved from outside since, from its latest Saved draft', async () => {
    const { owner, editor, page } = await sharedPage();
    const saving = { held: false };
    const theirs = await join(editor, page, saving);
    type(theirs, '\n\nSaved first.\n');
    await expect.poll(() => theirs.status().saved, { timeout: 30_000 }).toBe(true);
    saving.held = true;
    type(theirs, '\nThen typed.\n');
    await endUnsaved(editor, theirs, page);

    // Someone saves from outside before anyone catches up.
    const head = await draftOf(owner, page);
    await pages.saveDraft(owner.ctx, {
      page,
      basedOn: head.revisionId,
      payload: { ...head.payload, title: 'Renamed from outside' },
    });

    const caught: CaughtUp[] = [];
    expect(await joined(owner, page, { caught })).toMatchObject({ kind: 'caught-up' });
    expect(caught).toMatchObject([{ kind: 'saved', overlapped: 0 }]);
    const now = await draftOf(owner, page);
    expect(now.payload.title).toBe('Renamed from outside');
    expect(now.payload.markdown).toContain('Saved first.\n\nThen typed.');
    await expect.poll(async () => (await liveOf(owner, page.pageId)).ended).toBeNull();
  });

  it('is found in already by a second catch-up when the first one’s Saved notice was lost', async () => {
    const { owner, editor, page } = await sharedPage();
    const saving = { held: false };
    const theirs = await join(editor, page, saving);
    type(theirs, '\n\nSaved first.\n');
    await expect.poll(() => theirs.status().saved, { timeout: 30_000 }).toBe(true);
    saving.held = true;
    type(theirs, '\nThen typed.\n');
    await endUnsaved(editor, theirs, page);
    const head = await draftOf(owner, page);
    await pages.saveDraft(owner.ctx, {
      page,
      basedOn: head.revisionId,
      payload: { ...head.payload, title: 'Renamed from outside' },
    });

    // The first catch-up saves, but its Saved notice never lands: the session stays.
    const call = editor.ctx.api.call.bind(editor.ctx.api);
    const losing = {
      ...editor.ctx,
      api: {
        ...editor.ctx.api,
        call: ((route: unknown, args: { body?: { messages?: unknown[] } }) =>
          route === liveRoutes.sendMessages && (args.body?.messages?.length ?? 0) > 0
            ? Promise.reject(new ApiError(429, 'rate-limited', 'Too many'))
            : call(route as never, args as never)) as typeof editor.ctx.api.call,
      },
    };
    const served = async () => {
      const { ended, draftHead } = await liveOf(editor, page.pageId);
      if (!ended) throw new Error('not kept');
      return { ended, draftHead };
    };
    const ports = (ctx: typeof editor.ctx, person: Person) =>
      participantPorts(ctx, page, () => head.region, { live: { fetch: person.browser.fetch } });
    const first = await served();
    expect(await catchUpEnded(ports(losing, editor), first.ended, first.draftHead)).toMatchObject({
      kind: 'saved',
    });
    const caught = await draftOf(owner, page);
    expect(caught.payload.title).toBe('Renamed from outside');
    expect(caught.payload.markdown).toContain('Then typed.');
    // Someone changes the page from outside again.
    await pages.saveDraft(owner.ctx, {
      page,
      basedOn: caught.revisionId,
      payload: { ...caught.payload, title: 'Renamed again' },
    });

    // The next catch-up, another person's as the grant lapsed from the editor, finds it in:
    // nothing is saved, and the session goes.
    await expect.poll(async () => (await liveOf(owner, page.pageId)).ended).not.toBeNull();
    const second = await served();
    expect(await catchUpEnded(ports(owner.ctx, owner), second.ended, second.draftHead)).toEqual({
      kind: 'held',
    });
    const now = await draftOf(owner, page);
    expect(now.payload.title).toBe('Renamed again');
    await expect.poll(async () => (await liveOf(owner, page.pageId)).ended).toBeNull();
  });

  it('is caught up by one editor only: the other finds the grant held, and waits', async () => {
    const { owner, editor, page } = await sharedPage();
    const theirs = await join(editor, page, { held: true });
    type(theirs, '\n\nOnce only.\n');
    await endUnsaved(editor, theirs, page);
    const { ended } = await liveOf(owner, page.pageId);
    if (!ended) throw new Error('not kept');
    // Another app holds the catch-up grant.
    const asked = await editor.ctx.api.call(liveRoutes.sendMessages, {
      params: { sessionId: ended.sessionId },
      body: { joinId: newId(JoinId), messages: [], fold: ended.sessionId },
    });
    expect(asked.grant?.lapsed).toBe(false);
    const caught: CaughtUp[] = [];
    const result = await joined(owner, page, { caught });
    // No new session starts meanwhile: its first save would leave the ended one never caught up.
    expect(result).toEqual({ kind: 'waiting' });
    expect(caught).toMatchObject([{ kind: 'elsewhere' }]);
    expect((await draftOf(owner, page)).payload.markdown).not.toContain('Once only.');
  });
});

describe('an ended session a later one saved over', () => {
  it('is not caught up, takes no grant, and joining goes on', async () => {
    const { owner, editor, page } = await sharedPage();
    const theirs = await join(editor, page, { held: true });
    type(theirs, '\n\nLeft behind.\n');
    await theirs.flush();
    // Ended, but its join is still there: not served to catch up from yet.
    await editor.ctx.api.call(liveRoutes.end, { params: { sessionId: theirs.sessionId } });
    const ended = theirs.sessionId;
    // A new session starts, and saves.
    const mine = await join(owner, page);
    expect(mine.sessionId).not.toBe(ended);
    type(mine, '\n\nLater session.\n');
    await expect.poll(() => mine.status().saved, { timeout: 30_000 }).toBe(true);
    theirs.close();
    await t.db.execute(sql`
      update live_joins set left_at = now() - interval '2 minutes',
        last_message_at = now() - interval '2 minutes'
      where session_id = ${ended}`);
    await expect.poll(async () => (await liveOf(owner, page.pageId)).ended?.sessionId).toBe(ended);

    const caught: CaughtUp[] = [];
    const again = await joined(editor, page, { caught });
    expect('start' in again && again.sessionId).toBe(mine.sessionId);
    if ('start' in again) again.close();
    expect(caught).toMatchObject([{ kind: 'cant', lasting: true }]);
    // No grant was taken: another app may still ask for it.
    const asked = await owner.ctx.api.call(liveRoutes.sendMessages, {
      params: { sessionId: ended },
      body: { joinId: newId(JoinId), messages: [], fold: ended },
    });
    expect(asked.grant?.lapsed).toBe(false);
  });
});

describe('publishing in a live session', () => {
  it('publishes what the document held at the press, while the saver holds its saves', async () => {
    const { owner, editor, page } = await sharedPage();
    // The editor starts the session, so its app saves.
    const theirs = await join(editor, page);
    const mine = await join(owner, page);
    await expect.poll(() => theirs.status().people.length).toBe(1);
    type(mine, '\n\nPublished words.\n');
    await mine.flush();
    await expect.poll(() => body(theirs)).toContain('Published words.');

    const published = await mine.publish(async (draft) => {
      // Typed after the press: the saver holds, so the head stays put meanwhile.
      await expect.poll(() => theirs.status().people[0]?.id).toBe(owner.ctx.identity.public.id);
      type(theirs, '\nAfter the press.\n');
      await theirs.flush();
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      expect((await pages.loadPage(owner.ctx, page.pageId)).heads.draftHead).toBe(draft);
      return publishAs(owner, page)(draft);
    });
    expect(published).toBeDefined();
    const markdown = await publishedOf(owner, page);
    expect(markdown).toContain('Published words.');
    expect(markdown).not.toContain('After the press.');
    // Once the publish is done, the saver saves again.
    await expect.poll(() => theirs.status().saved, { timeout: 30_000 }).toBe(true);
    expect((await draftOf(owner, page)).payload.markdown).toContain('After the press.');
  });

  it('stops, publishing nothing, when the page changed after the press', async () => {
    const { owner, editor, page } = await sharedPage();
    const theirs = await join(editor, page);
    const mine = await join(owner, page);
    await expect.poll(() => theirs.status().people.length).toBe(1);
    type(mine, '\n\nAt the press.\n');
    await mine.flush();
    await expect.poll(() => body(theirs)).toContain('At the press.');
    const before = (await pages.loadPage(owner.ctx, page.pageId)).heads.publishedHead;

    const stopped = await mine
      .publish(async (draft) => {
        // Someone saves what they typed after the press first: the head moves on.
        type(theirs, '\nTyped after.\n');
        await expect.poll(() => body(mine)).toContain('Typed after.');
        await theirs.saveNow();
        expect((await pages.loadPage(owner.ctx, page.pageId)).heads.draftHead).not.toBe(draft);
        return publishAs(owner, page)(draft);
      })
      .catch((error: unknown) => error);
    expect(stopped).toBeInstanceOf(LivePublishStopped);
    expect((stopped as LivePublishStopped).reason).toBe('changed');
    expect((await pages.loadPage(owner.ctx, page.pageId)).heads.publishedHead).toBe(before);
  });
});
