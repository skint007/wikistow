// Offline and resuming in a live session (ADR 0015 decisions 6 and 10),
// through the client's participant and the real server: a short break
// resumes from the same join, its typing sent as it was made; a longer one
// leaves, and the typing is put back by block from a base that holds what
// the session served of it, so nothing it sent goes in twice.
import { createApiClient, pageMerge, pageOperations as pages } from '@wikistow/client';
import {
  changeText,
  joinLive,
  participantPorts,
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
  await shareFolder(owner.ctx, {
    spaceId: lib.spaceId,
    rootId: lib.shared,
    people: [await invite(owner, editor, 'editor')],
  });
  return { owner, editor, page: lib.page };
}

/**
 * `person`'s connection, which the test can cut: then every request gets
 * no answer, and open streams break, as when a laptop goes offline.
 */
function network(person: Person) {
  let down = false;
  const cuts = new Set<() => void>();
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    if (down) throw new TypeError('offline');
    const answer = await person.browser.fetch(url, init);
    if (!answer.body || !answer.headers.get('content-type')?.includes('ndjson')) return answer;
    // A stream: broken when the connection is cut, the server's end cancelled too.
    const reader = answer.body.getReader();
    let cut = () => {};
    const broken = new Promise<never>((_, reject) => {
      cut = () => reject(new TypeError('offline'));
    });
    cuts.add(cut);
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const chunk = await Promise.race([reader.read(), broken]);
          if (chunk.done) controller.close();
          else controller.enqueue(chunk.value);
        } catch (error) {
          void reader.cancel().catch(() => {});
          cuts.delete(cut);
          controller.error(error);
        }
      },
      cancel: () => reader.cancel(),
    });
    return new Response(body, { status: answer.status, headers: answer.headers });
  };
  return {
    fetch,
    ctx: { ...person.ctx, api: createApiClient({ fetch }) },
    cut() {
      down = true;
      for (const cut of cuts) cut();
      cuts.clear();
    },
    restore() {
      down = false;
    },
  };
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

async function join(person: Person, page: Page, net = network(person)) {
  const draft = await draftOf(person, page);
  const ports = participantPorts(net.ctx, page, () => draft.region, {
    live: { fetch: net.fetch },
  });
  const joined = await joinLive(ports, draft);
  if (!('start' in joined)) throw new Error(`not joined: ${JSON.stringify(joined)}`);
  joined.start();
  open.push(joined);
  return joined;
}

const body = (participant: LiveParticipant) => participant.document.text('body').toJSON();
const type = (participant: LiveParticipant, at: 'start' | 'end', text: string) =>
  participant.edit((document) => {
    const now = document.text('body').toJSON();
    changeText(document.text('body'), at === 'start' ? text + now : now + text);
  });

describe('offline in a live session', () => {
  it('resumes a short break from the same join, sending what was typed meanwhile', async () => {
    const { owner, editor, page } = await sharedPage();
    const mine = await join(owner, page);
    const net = network(editor);
    const theirs = await join(editor, page, net);
    await expect.poll(() => mine.status().people.length).toBe(1);
    await expect.poll(() => theirs.status().connected).toBe(true);

    net.cut();
    await expect.poll(() => theirs.status().connected).toBe(false);
    type(theirs, 'end', ' typed offline');
    await new Promise((resolve) => setTimeout(resolve, 4_000));
    expect(body(mine)).not.toContain('typed offline');
    net.restore();

    // Back within the join's 30 s: the same join, with no conflict and nothing put back.
    await expect.poll(() => body(mine), { timeout: 15_000 }).toContain('typed offline');
    expect(theirs.status().state).toEqual({ kind: 'live' });
    expect(theirs.status().connected).toBe(true);
    await expect.poll(() => theirs.status().saved, { timeout: 30_000 }).toBe(true);
  });

  it(
    'after a longer break, puts its typing back by block, never what the session took twice',
    { timeout: 150_000 },
    async () => {
      const { owner, editor, page } = await sharedPage();
      const mine = await join(owner, page);
      const net = network(editor);
      const theirs = await join(editor, page, net);
      await expect.poll(() => mine.status().people.length).toBe(1);

      // Sent and placed, but not yet saved in a draft the editor compared.
      type(theirs, 'end', ' sent');
      await theirs.flush();
      await expect.poll(() => body(mine)).toBe('draft words sent');

      net.cut();
      type(theirs, 'end', ' unsent');
      // Meanwhile the owner writes a paragraph of their own.
      type(mine, 'start', 'Owner.\n\n');
      // Past the join's 30 s, it leaves.
      await expect
        .poll(() => theirs.status().state.kind, { timeout: 80_000, interval: 1_000 })
        .toBe('stopped');
      const putBack = theirs.putBack();
      expect(putBack.ours?.markdown).toBe('draft words sent unsent');
      // As a writer outside the session: only what a compared draft holds of its own.
      expect(putBack.outside?.markdown).not.toContain('unsent');

      net.restore();
      const again = await join(editor, page, net);
      await expect.poll(() => body(again)).toBe('Owner.\n\ndraft words sent');
      // Into the session: of its own, exactly what the session served.
      const base = putBack.inSession(again.placedThrough(theirs.ownJoin));
      expect(base?.markdown).toBe('draft words sent');
      if (!base || !putBack.ours) throw new Error('no base');
      const merge = pageMerge.mergePayloads(base, putBack.ours, again.currentPayload());
      expect(merge.overlaps).toEqual([]);
      const resolved = pageMerge.resolve(merge, {}, { review: false });
      if (!resolved.ok) throw new Error('overlaps');
      again.change({ texts: { body: resolved.payload.markdown } }, { byLines: true });
      await expect.poll(() => body(mine)).toBe('Owner.\n\ndraft words sent unsent');
    },
  );
});
