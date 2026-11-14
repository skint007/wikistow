// Editing live (ADR 0015 step 6): two people's apps in one page's session,
// through the client's participant and the real server. Both see both
// people's typing, one app saves the shared document as the session's
// drafts, nobody meets a conflict, the saver hands over when it leaves,
// and a removal ends the session.
import { pageOperations as pages, sharingOperations as sharing } from '@wikistow/client';
import {
  changeText,
  joinLive,
  participantPorts,
  sessionState,
  type LiveParticipant,
} from '@wikistow/client/live';
import type { PageId, RevisionId, SpaceId } from '@wikistow/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { listenForTreeChanges, schema } from '@wikistow/server';
import { eq } from 'drizzle-orm';
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
  return { owner, editor, lib, shareId, page: lib.page };
}

/** The page's draft head, opened by `person`, and where it is. */
async function draftOf(person: Person, page: Page) {
  const { heads } = await pages.loadPage(person.ctx, page.pageId);
  if (!heads.draftHead) throw new Error('no draft');
  const opened = await pages.openRevisionOf(person.ctx, page, 'draft', heads.draftHead, {
    fresh: true,
  });
  if (opened.opened.kind !== 'current') throw new Error('newer format');
  return {
    revisionId: heads.draftHead,
    payload: opened.opened.payload,
    region: opened.region,
    opened,
  };
}

/** `person`'s app joining the page's session, as its draft view does. */
async function join(person: Person, page: Page, { visible = true } = {}) {
  const draft = await draftOf(person, page);
  const ports = participantPorts(person.ctx, page, () => draft.region, {
    live: { fetch: person.browser.fetch },
    visible: () => visible,
  });
  const joined = await joinLive(ports, draft);
  if (!('start' in joined)) throw new Error(`not joined: ${JSON.stringify(joined)}`);
  joined.start();
  open.push(joined);
  return joined;
}

const body = (participant: LiveParticipant) => participant.document.text('body').toJSON();

/** Type `text` at the end of the body, as the person's own change. */
const type = (participant: LiveParticipant, text: string) =>
  participant.edit((document) => {
    const now = document.text('body').toJSON();
    changeText(document.text('body'), now + text);
  });

/** Every draft revision of the page, newest first, by who signed it. */
async function draftsSince(person: Person, page: Page, since: RevisionId) {
  const signers: string[] = [];
  let at: RevisionId | null = (await pages.loadPage(person.ctx, page.pageId)).heads.draftHead;
  while (at && at !== since) {
    const opened = await pages.openRevisionOf(person.ctx, page, 'draft', at);
    signers.push(opened.record.authorId);
    at = opened.record.basedOn as RevisionId | null;
  }
  return signers;
}

describe('editing a page live', () => {
  it('shows both people’s typing to both, with one draft history and no conflict', async () => {
    const { owner, editor, page } = await sharedPage();
    const before = (await draftOf(owner, page)).revisionId;
    const mine = await join(owner, page);
    const theirs = await join(editor, page);
    expect(body(theirs)).toBe('draft words');

    type(mine, ' from the owner');
    type(theirs, ' and the editor');
    await expect.poll(() => body(mine)).toContain('from the owner');
    await expect.poll(() => body(mine)).toContain('and the editor');
    await expect.poll(() => body(theirs)).toBe(body(mine));

    // The saver, the first listed, saves; both apps take the draft as saving their typing.
    await expect.poll(() => mine.status().saver).toBe('me');
    await expect.poll(() => theirs.status().saver).toBe(owner.vault.identity.public.id);
    await expect.poll(() => mine.status().saved, { timeout: 30_000 }).toBe(true);
    await expect.poll(() => theirs.status().saved, { timeout: 30_000 }).toBe(true);

    const head = await draftOf(editor, page);
    expect(head.payload.markdown).toBe(body(mine));
    const state = sessionState(head.payload, head.revisionId, mine.sessionId);
    expect(state).not.toBeNull();
    expect(head.opened.record.authorId).toBe(owner.vault.identity.public.id);
    // Only the saver signs the session's drafts, one after the other.
    const signers = await draftsSince(owner, page, before);
    expect(signers.length).toBeGreaterThan(0);
    expect(new Set(signers)).toEqual(new Set([owner.vault.identity.public.id]));
    expect(mine.status().state).toEqual({ kind: 'live' });
    expect(theirs.status().state).toEqual({ kind: 'live' });
  });

  it('hands saving over when the saver leaves', async () => {
    const { owner, editor, page } = await sharedPage();
    const mine = await join(owner, page);
    const theirs = await join(editor, page);
    type(mine, ' one');
    await expect.poll(() => theirs.status().saved, { timeout: 30_000 }).toBe(true);
    expect(await mine.leave()).toBe(true);

    await expect.poll(() => theirs.status().saver, { timeout: 40_000 }).toBe('me');
    type(theirs, ' two');
    await expect.poll(() => theirs.status().saved, { timeout: 30_000 }).toBe(true);
    const head = await draftOf(editor, page);
    expect(head.payload.markdown).toBe('draft words one two');
    expect(head.opened.record.authorId).toBe(editor.vault.identity.public.id);
  });

  it('a hidden tab leaves saving to a visible one', async () => {
    const { owner, editor, page } = await sharedPage();
    const hidden = await join(owner, page, { visible: false });
    const shown = await join(editor, page);
    type(hidden, ' typed while hidden');
    await expect.poll(() => shown.status().saver, { timeout: 30_000 }).toBe('me');
    await expect.poll(() => hidden.status().saved, { timeout: 30_000 }).toBe(true);
    const head = await draftOf(owner, page);
    expect(head.opened.record.authorId).toBe(editor.vault.identity.public.id);
  });

  it('a newcomer catches up on what was typed before it came', async () => {
    const { owner, editor, page } = await sharedPage();
    const mine = await join(owner, page);
    type(mine, ' early');
    await expect.poll(() => mine.status().saved, { timeout: 30_000 }).toBe(true);
    type(mine, ' unsaved');
    await mine.flush();
    const late = await join(editor, page);
    expect(body(late)).toBe('draft words early unsaved');
    await expect
      .poll(() => late.status().people.map((p) => p.id))
      .toEqual([owner.vault.identity.public.id]);
  });

  it('puts a change saved by its writer around what others typed meanwhile', async () => {
    const { owner, editor, page } = await sharedPage();
    const mine = await join(owner, page);
    const theirs = await join(editor, page);
    await expect.poll(() => mine.status().people.length).toBe(1);
    // Worked out from the text as it is now, as a plugin's change is.
    const target = `${body(mine)} ![photo](attachment:photo)`;
    const committing = mine.commitOwn({ texts: { body: target } });
    theirs.edit((document) => document.text('body').insert(0, 'Early. '));
    expect(await committing).toBe(true);
    const both = 'Early. draft words ![photo](attachment:photo)';
    await expect.poll(() => body(mine)).toBe(both);
    await expect.poll(() => body(theirs)).toBe(both);
    await expect.poll(() => theirs.status().saved, { timeout: 30_000 }).toBe(true);
  });

  it('tells the server everything is saved once it is, a file’s own join included', async () => {
    const { owner, page } = await sharedPage();
    const mine = await join(owner, page);
    type(mine, ' saved');
    await expect.poll(() => mine.status().saved, { timeout: 30_000 }).toBe(true);
    expect(
      await mine.commitOwn({ texts: { body: `${body(mine)} ![photo](attachment:photo)` } }),
    ).toBe(true);
    const row = async () =>
      (
        await t.db
          .select()
          .from(schema.liveSessions)
          .where(eq(schema.liveSessions.id, mine.sessionId))
      )[0];
    // Unsaved, for the server, only while an update comes after what the latest Saved covers.
    await expect
      .poll(
        async () => {
          const session = await row();
          return session && (session.savedCovers ?? 0) >= session.lastUpdatePosition;
        },
        { timeout: 15_000 },
      )
      .toBe(true);
    // And then says nothing more while nothing changes: no Saved notice answers its own.
    const settled = (await row())?.lastPosition;
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    expect((await row())?.lastPosition).toBe(settled);
  });

  it('ends the session for everyone when a member is removed', async () => {
    const { owner, editor, lib, shareId, page } = await sharedPage();
    const mine = await join(owner, page);
    const theirs = await join(editor, page);
    type(theirs, ' last words');
    await expect.poll(() => body(mine)).toContain('last words');
    await sharing.removeMember(owner.ctx, {
      spaceId: lib.spaceId,
      shareId,
      identityId: editor.vault.identity.public.id,
    });
    await expect.poll(() => theirs.status().state.kind).toBe('ended');
    await expect.poll(() => mine.status().state).toEqual({ kind: 'ended', reason: 'access' });
    // The removed person's app sends nothing more: the session took nothing after the end.
    type(theirs, ' after');
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(body(mine)).not.toContain('after');
  });
});
