// A live session's participant, through the real server: who a session's
// drafts say edited since the latest publication (#511), a file's change
// saved while another app saves (#492), and a newer format, which asks to
// update without ending the session (#504).
import { pageOperations as pages } from '@wikistow/client';
import {
  changeText,
  joinLive,
  LIVE_NAMESPACE,
  liveBinding,
  liveTransport,
  participantPorts,
  sealLiveMessage,
  startPageSession,
  type LiveParticipant,
  type ParticipantPorts,
} from '@wikistow/client/live';
import { liveRoutes, type PageId, type RevisionId, type SpaceId } from '@wikistow/contracts';
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

function portsOf(person: Person, page: Page, draft: Awaited<ReturnType<typeof draftOf>>) {
  return participantPorts(person.ctx, page, () => draft.region, {
    live: { fetch: person.browser.fetch },
  });
}

async function join(
  person: Person,
  page: Page,
  change: (ports: ParticipantPorts) => void = () => {},
) {
  const draft = await draftOf(person, page);
  const ports = portsOf(person, page, draft);
  change(ports);
  const joined = await joinLive(ports, draft);
  if (!('start' in joined)) throw new Error(`not joined: ${JSON.stringify(joined)}`);
  joined.start();
  open.push(joined);
  return joined;
}

const body = (participant: LiveParticipant) => participant.document.text('body').toJSON();

const type = (participant: LiveParticipant, text: string) =>
  participant.edit((document) => {
    const now = document.text('body').toJSON();
    changeText(document.text('body'), now + text);
  });

/** Who the draft head's `wikistow.live` says edited it. */
async function withOf(person: Person, page: Page) {
  const head = await draftOf(person, page);
  const live = head.payload.extensions[LIVE_NAMESPACE] as { with?: string[] } | undefined;
  return [...(live?.with ?? [])].sort();
}

/** Publish `draftHead` as `person`, only while it is the draft head. */
const publishAs = (person: Person, page: Page) => async (draftHead: RevisionId) => {
  const { heads } = await pages.loadPage(person.ctx, page.pageId);
  return pages.publishPage(person.ctx, page, {
    expected: { draftHead, publishedHead: heads.publishedHead },
  });
};

const liveOf = (person: Person, pageId: PageId) =>
  person.ctx.api.call(liveRoutes.getLive, { params: { pageId } });

describe('who edited since the latest publication (#511)', () => {
  it('names only those who typed since, after another app published', async () => {
    const { owner, editor, page } = await sharedPage();
    // The editor's app saves; the owner publishes.
    const theirs = await join(editor, page);
    const mine = await join(owner, page);
    await expect.poll(() => theirs.status().people.length).toBe(1);
    type(mine, ' before publishing');
    await mine.flush();
    await expect.poll(() => mine.status().saved, { timeout: 30_000 }).toBe(true);
    expect(await withOf(owner, page)).toEqual([owner.ctx.identity.public.id]);
    await mine.publish((draft) => publishAs(owner, page)(draft));

    type(theirs, ' after publishing');
    await theirs.flush();
    await expect.poll(() => body(mine)).toContain('after publishing');
    await expect.poll(() => theirs.status().saved, { timeout: 30_000 }).toBe(true);
    expect((await draftOf(owner, page)).payload.markdown).toContain('after publishing');
    expect(await withOf(owner, page)).toEqual([editor.ctx.identity.public.id]);
  });

  it('names only those who typed since, after its own app published', async () => {
    const { owner, editor, page } = await sharedPage();
    // The owner's app saves and publishes.
    const mine = await join(owner, page);
    const theirs = await join(editor, page);
    await expect.poll(() => mine.status().people.length).toBe(1);
    type(mine, ' before publishing');
    await expect.poll(() => mine.status().saved, { timeout: 30_000 }).toBe(true);
    await mine.publish((draft) => publishAs(owner, page)(draft));

    type(theirs, ' after publishing');
    await theirs.flush();
    await expect.poll(() => theirs.status().saved, { timeout: 30_000 }).toBe(true);
    expect(await withOf(owner, page)).toEqual([editor.ctx.identity.public.id]);
  });

  it('carries nobody from a draft published before the app joined', async () => {
    const { owner, editor, page } = await sharedPage();
    const mine = await join(owner, page);
    type(mine, ' before publishing');
    await expect.poll(() => mine.status().saved, { timeout: 30_000 }).toBe(true);
    expect(await withOf(owner, page)).toEqual([owner.ctx.identity.public.id]);
    // Published from outside the session, with nobody's publish to see.
    await pages.publishPage(owner.ctx, page);
    expect(await mine.leave()).toBe(true);

    const theirs = await join(editor, page);
    type(theirs, ' after publishing');
    await expect.poll(() => theirs.status().saved, { timeout: 30_000 }).toBe(true);
    expect((await draftOf(owner, page)).payload.markdown).toContain('after publishing');
    expect(await withOf(owner, page)).toEqual([editor.ctx.identity.public.id]);
  });
});

describe('a file’s change while another app saves (#492)', () => {
  it('saves again on the new head when another app saved first', async () => {
    const { owner, editor, page } = await sharedPage();
    // The editor's app saves.
    const theirs = await join(editor, page);
    let raced = false;
    const mine = await join(owner, page, (ports) => {
      const save = ports.saveDraft.bind(ports);
      ports.saveDraft = async (input) => {
        if (!raced) {
          // Another app's save lands first: this one meets `stale-head`.
          raced = true;
          type(theirs, ' typed meanwhile');
          expect(await theirs.saveNow()).toBe(true);
        }
        return save(input);
      };
    });
    await expect.poll(() => theirs.status().people.length).toBe(1);
    const target = `${body(mine)} ![photo](attachment:photo)`;
    expect(await mine.commitOwn({ texts: { body: target } })).toBe(true);
    expect(raced).toBe(true);
    const both = 'draft words typed meanwhile ![photo](attachment:photo)';
    await expect.poll(() => body(theirs)).toBe(both);
    expect(body(mine)).toBe(both);
    expect((await draftOf(owner, page)).payload.markdown).toBe(both);
    expect(mine.status().state).toEqual({ kind: 'live' });
    expect(theirs.status().state).toEqual({ kind: 'live' });
  });

  it('never saves again over text another app changed meanwhile', async () => {
    const { owner, editor, page } = await sharedPage();
    const theirs = await join(editor, page);
    let raced = false;
    const mine = await join(owner, page, (ports) => {
      const save = ports.saveDraft.bind(ports);
      ports.saveDraft = async (input) => {
        if (!raced) {
          // Another app saves first, with typing inside the text this change replaces.
          raced = true;
          theirs.edit((document) => document.text('body').insert('draft wo'.length, 'X'));
          expect(await theirs.saveNow()).toBe(true);
        }
        return save(input);
      };
    });
    await expect.poll(() => theirs.status().people.length).toBe(1);
    expect(await mine.commitOwn({ texts: { body: 'draft pages' } })).toBe(false);
    expect(raced).toBe(true);
    await expect.poll(() => body(mine)).toBe('draft woXrds');
    expect(body(theirs)).toBe('draft woXrds');
    expect(mine.status().state).toEqual({ kind: 'live' });
  });
});

describe('a newer format (#504)', () => {
  it('of `wikistow.live` asks to update and leaves the session open', async () => {
    const { owner, editor, page } = await sharedPage();
    const mine = await join(owner, page);
    const theirs = await join(editor, page);
    await expect.poll(() => mine.status().people.length).toBe(1);
    // A newer app saves the session's draft.
    const head = await draftOf(owner, page);
    await pages.saveDraft(owner.ctx, {
      page,
      basedOn: head.revisionId,
      payload: {
        ...head.payload,
        markdown: `${head.payload.markdown} from a newer app`,
        extensions: { ...head.payload.extensions, [LIVE_NAMESPACE]: { format: 2 } },
      },
    });
    for (const participant of [mine, theirs]) {
      await expect.poll(() => participant.status().state.kind, { timeout: 20_000 }).toBe('stopped');
      const { state } = participant.status();
      expect(state.kind === 'stopped' && state.why).toContain('Update the app to edit with others');
    }
    expect((await liveOf(owner, page.pageId)).open?.sessionId).toBe(mine.sessionId);
    // Joining again says to update, rather than joining it.
    const draft = await draftOf(editor, page);
    expect(await joinLive(portsOf(editor, page, draft), draft)).toEqual({ kind: 'update-app' });
  });

  it('of a Saved notice asks to update and leaves the session open', async () => {
    const { owner, editor, page } = await sharedPage();
    // A newer app's session, started as any app starts one.
    const draft = await draftOf(owner, page);
    const started = await startPageSession(owner.ctx, { page, ...draft });
    const theirs = await join(editor, page);
    const sessionId = started.opened.record.subjectId;
    expect(theirs.sessionId).toBe(sessionId);
    const content = new TextEncoder().encode(JSON.stringify({ format: { major: 2, minor: 0 } }));
    const saved = sealLiveMessage({
      sender: owner.ctx.identity,
      binding: liveBinding(started.opened),
      kind: 'saved',
      joinId: started.joinId,
      seq: 2,
      clock: started.document.state().vector.get(started.document.clientId) ?? 0,
      content,
    });
    await liveTransport(owner.ctx, sessionId, { fetch: owner.browser.fetch }).send({
      joinId: started.joinId,
      messages: [{ message: saved, covers: started.position }],
    });
    await expect.poll(() => theirs.status().state.kind, { timeout: 20_000 }).toBe('stopped');
    const { state } = theirs.status();
    expect(state.kind === 'stopped' && state.why).toContain('Update the app to edit with others');
    expect((await liveOf(owner, page.pageId)).open?.sessionId).toBe(sessionId);
  });
});
