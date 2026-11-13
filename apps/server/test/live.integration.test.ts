// The live sessions server (protocol section 5.10, ADR 0015 step 4): who is
// served a session and may take part, how messages are numbered, relayed
// and limited, how a session ends with the page's access, and when it goes.
import {
  newId,
  pageOperations as pages,
  sharingOperations as sharing,
  utf8,
} from '@wikistow/client';
import {
  JoinId,
  LiveSessionId,
  liveRoutes,
  MetadataRevisionId,
  type RevisionId,
} from '@wikistow/contracts';
import { listenForTreeChanges, schema, sweepDrafts, sweepLive } from '@wikistow/server';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { asAgent, enrolledAgent } from './support/agents.ts';
import { sealComment, sendComment } from './support/comments.ts';
import { personWithVault, rejection } from './support/content.ts';
import { createTestApp, scratchApps, type TestApp } from './support/harness.ts';
import {
  headOf,
  liveOf,
  openStream,
  sealMessage,
  sealStart,
  sendStart,
  startSession,
  typist,
  type OpenStream,
  type TestSession,
} from './support/live.ts';
import { find, invite, library, shareFolder, type Person } from './support/sharing.ts';

let t: TestApp;
let listening: Awaited<ReturnType<typeof listenForTreeChanges>>;
const streams: OpenStream[] = [];
beforeAll(async () => {
  t = await createTestApp();
  listening = await listenForTreeChanges(t.config.databaseUrl, () => {}, {
    onLive: (payload) => t.live.notified(payload),
  });
});
afterAll(async () => {
  await Promise.all(streams.map((s) => s.close()));
  await listening.close();
  await t.drop();
});
const scratch = scratchApps();

const RETENTION = { retentionMs: 30 * 24 * 60 * 60 * 1000 };

/** A library whose `Shared` folder has a reader and an editor. */
async function sharedLibrary(app: TestApp = t) {
  const [owner, reader, editor] = await Promise.all([
    personWithVault(app),
    personWithVault(app),
    personWithVault(app),
  ]);
  const lib = await library(owner);
  const shareId = await shareFolder(owner.ctx, {
    spaceId: lib.spaceId,
    rootId: lib.shared,
    people: [await invite(owner, reader, 'reader'), await invite(owner, editor, 'editor')],
  });
  return { owner, reader, editor, lib, shareId };
}

async function stream(person: Person, session: TestSession, joinId: JoinId, after = 0) {
  const opened = await openStream(person, session, { joinId, after });
  streams.push(opened);
  return opened;
}

const streamRefusal = (person: Person, session: TestSession, joinId: JoinId, after = 0) =>
  openStream(person, session, { joinId, after }).then(
    async (opened) => {
      await opened.close();
      return 'no error';
    },
    (error: { code?: string }) => error.code,
  );

const sessionRow = async (sessionId: string) =>
  (await t.db.select().from(schema.liveSessions).where(eq(schema.liveSessions.id, sessionId)))[0];

/** Every join of the session left, long enough ago for the sweep. */
const everyoneLeft = (sessionId: string, ago = '2 minutes') =>
  t.db.execute(sql`
    update live_joins set left_at = now() - ${ago}::interval,
      last_message_at = now() - ${ago}::interval
    where session_id = ${sessionId}`);

describe('who is served a session', () => {
  it('serves it only to those who can edit the page now: never a reader, an agent or anyone else', async () => {
    const { owner, reader, editor, lib } = await sharedLibrary();
    const outsider = await personWithVault(t);
    const agent = await enrolledAgent(t, owner, {
      picks: [{ spaceId: lib.spaceId, folderId: lib.shared, role: 'editor' }],
    });
    const session = await startSession(editor, lib.page);

    for (const person of [editor, owner]) {
      const { open, ended } = await liveOf(person, lib.page.pageId);
      expect(open).toMatchObject({
        sessionId: session.sessionId,
        revisionId: session.revisionId,
        ended: null,
        envelopes: [],
        firstSnapshot: { position: 1, covers: 0, revisionId: session.revisionId },
        snapshot: null,
        messages: [],
        complete: true,
        position: 1,
      });
      expect(open?.wrap?.keyVersion).toBe(1);
      expect(open?.joins).toEqual([
        expect.objectContaining({ joinId: session.joinId, order: 1, parent: null, present: true }),
      ]);
      expect(ended).toBeNull();
    }

    const sessionId = session.sessionId;
    const join = newId(JoinId);
    const typed = sealMessage(reader.ctx, session, { kind: 'update', joinId: join, seq: 1 });
    for (const person of [reader, outsider]) {
      const api = person.ctx.api;
      expect(await rejection(liveOf(person, lib.page.pageId))).toBe('not-found');
      expect(await streamRefusal(person, session, join)).toBe('not-found');
      expect(
        await rejection(
          api.call(liveRoutes.sendMessages, {
            params: { sessionId },
            body: { joinId: join, messages: [{ message: typed }] },
          }),
        ),
      ).toBe('not-found');
      expect(
        await rejection(
          api.call(liveRoutes.postSnapshot, {
            params: { sessionId },
            body: { joinId: join, message: typed, covers: 1, revisionId: session.revisionId },
          }),
        ),
      ).toBe('not-found');
      expect(
        await rejection(
          api.call(liveRoutes.leave, { params: { sessionId }, body: { joinId: join } }),
        ),
      ).toBe('not-found');
      expect(await rejection(api.call(liveRoutes.end, { params: { sessionId } }))).toBe(
        'not-found',
      );
      // Nor does a session that doesn't exist answer otherwise.
      expect(
        await rejection(api.call(liveRoutes.end, { params: { sessionId: newId(LiveSessionId) } })),
      ).toBe('not-found');
    }
    expect(
      await rejection(
        sealStart(editor.ctx, lib.page, { revisionId: session.revisionId }).then(({ body }) =>
          sendStart(reader.ctx, lib.page.pageId, body),
        ),
      ),
    ).toBe('not-found');

    // The agent edits the folder, and is still answered as if nothing were there.
    expect(
      await rejection(agent.api.call(liveRoutes.getLive, { params: { pageId: lib.page.pageId } })),
    ).toBe('not-found');
    const opened = await asAgent(
      t,
      agent.token,
      `/api/live/${sessionId}/stream?after=0&joinId=${join}`,
    );
    expect(opened.status).toBe(404);
    const sent = await asAgent(t, agent.token, `/api/live/${sessionId}/messages`, {
      method: 'POST',
      json: { joinId: join, messages: [] },
    });
    expect(sent.status).toBe(404);
    expect(await rejection(agent.api.call(liveRoutes.end, { params: { sessionId } }))).toBe(
      'not-found',
    );
    expect((await sessionRow(sessionId))?.endedAt).toBeNull();
  });

  it('seals a session outside shares to the owners, and serves each their own envelope', async () => {
    const { owner, lib } = await sharedLibrary();
    const session = await startSession(owner, lib.beside);
    const { open } = await liveOf(owner, lib.beside.pageId);
    expect(open?.sessionId).toBe(session.sessionId);
    expect(open?.wrap).toBeNull();
    expect(open?.envelopes.map((e) => e.recipientId)).toEqual([owner.vault.identity.public.id]);
  });
});

describe('starting a session', () => {
  it('refuses each start the server can see is wrong, by its code, and keeps nothing of it', async () => {
    const { owner, editor, lib, shareId } = await sharedLibrary();
    const older = await headOf(editor, lib.page);
    await pages.editDraft(editor.ctx, lib.page, { markdown: 'newer words' });
    const head = await headOf(editor, lib.page);
    const fresh = () => sealStart(editor.ctx, lib.page, { revisionId: head });
    const refused = async (
      change: (body: Awaited<ReturnType<typeof fresh>>['body']) => unknown,
    ) => {
      const { body } = await fresh();
      return rejection(sendStart(editor.ctx, lib.page.pageId, change(body) as typeof body));
    };

    const { body: stale } = await sealStart(editor.ctx, lib.page, { revisionId: older });
    expect(await rejection(sendStart(editor.ctx, lib.page.pageId, stale))).toBe('stale-head');
    expect(await refused((b) => ({ ...b, permissionVersion: b.permissionVersion + 1 }))).toBe(
      'permission-version',
    );
    expect(await refused((b) => ({ ...b, sessionId: newId(LiveSessionId) }))).toBe(
      'binding-mismatch',
    );
    expect(
      await refused((b) => ({
        ...b,
        metadata: {
          ...b.metadata,
          signature: b.metadata.signature.replace(/^./, (c) => (c === 'A' ? 'B' : 'A')),
        },
      })),
    ).toBe('bad-signature');
    expect(
      await refused((b) => ({
        ...b,
        metadata: {
          ...b.metadata,
          payload: {
            ...b.metadata.payload,
            nonce: b.metadata.payload.nonce.replace(/^./, (c) => (c === 'A' ? 'B' : 'A')),
          },
        },
      })),
    ).toBe('bad-signature');
    expect(await refused((b) => ({ ...b, wrap: null }))).toBe('region-mismatch');
    expect(
      await refused((b) => ({
        ...b,
        wrap: b.wrap && { ...b.wrap, keyVersion: b.wrap.keyVersion + 1 },
      })),
    ).toBe('key-version');
    expect(
      await refused((b) => ({
        ...b,
        snapshot: sealMessage(
          editor.ctx,
          { ...dummy(b) },
          { kind: 'update', joinId: b.joinId, seq: 1 },
        ),
      })),
    ).toBe('invalid-request');
    expect(
      await refused((b) => ({
        ...b,
        snapshot: sealMessage(editor.ctx, dummy(b), {
          kind: 'snapshot',
          joinId: b.joinId,
          seq: 1,
          size: liveRoutes.MAX_SNAPSHOT_BYTES + 128 - 16,
        }),
      })),
    ).toBe('payload-too-large');
    expect(
      await refused((b) => ({ ...b, snapshot: { ...b.snapshot, joinId: newId(JoinId) } })),
    ).toBe('binding-mismatch');
    // Signed by someone else than the one who sends it.
    const { body: others } = await sealStart(owner.ctx, lib.page, { revisionId: head });
    expect(await rejection(sendStart(editor.ctx, lib.page.pageId, others))).toBe('forbidden');
    // A version ID a comment has.
    const comment = await sealComment(editor.ctx, lib.page, { audience: 'draft', text: 'hm' });
    await sendComment(editor.ctx, lib.page.pageId, comment);
    const { body: taken } = await sealStart(editor.ctx, lib.page, {
      revisionId: head,
      versionId: comment.comment.versionId,
    });
    expect(await rejection(sendStart(editor.ctx, lib.page.pageId, taken))).toBe('duplicate');
    expect(await liveOf(editor, lib.page.pageId)).toMatchObject({ open: null, ended: null });

    // A start that lands, sent again byte for byte after a lost answer, is answered again.
    const { session, body } = await fresh();
    expect(await sendStart(editor.ctx, lib.page.pageId, body)).toEqual({
      sessionId: session.sessionId,
      position: 1,
    });
    expect(await sendStart(editor.ctx, lib.page.pageId, body)).toEqual({
      sessionId: session.sessionId,
      position: 1,
    });
    // Any other start with its ID, or while it is open, is refused.
    const { body: again } = await sealStart(editor.ctx, lib.page, {
      revisionId: head,
      sessionId: session.sessionId,
    });
    expect(await rejection(sendStart(editor.ctx, lib.page.pageId, again))).toBe('duplicate');
    expect(await refused((b) => b)).toBe('duplicate');
    // Its record's version ID is taken for comments too.
    const clash = await sealComment(editor.ctx, lib.page, {
      audience: 'draft',
      text: 'clash',
      versionId: session.versionId,
    });
    expect(await rejection(sendComment(editor.ctx, lib.page.pageId, clash))).toBe('duplicate');
    void shareId;
  });
});

// A session with another key, for sealing a message the server will refuse anyway.
function dummy(body: {
  sessionId: LiveSessionId;
  joinId: JoinId;
  revisionId: RevisionId;
}): TestSession {
  return {
    sessionId: body.sessionId,
    versionId: newId(MetadataRevisionId),
    spaceId: 'x' as TestSession['spaceId'],
    pageId: 'x' as TestSession['pageId'],
    revisionId: body.revisionId,
    joinId: body.joinId,
    record: {} as TestSession['record'],
    recordHash: 'x',
    sessionKey: new Uint8Array(32),
    installationId: 'x',
  };
}

describe('messages', () => {
  it('relays stored messages in order, and presence, to every join, with the draft head', async () => {
    const { owner, editor, lib } = await sharedLibrary();
    const session = await startSession(editor, lib.page);
    const head = session.revisionId;
    const starter = typist(editor, session, session.joinId);
    starter.started();
    const mine = await stream(editor, session, session.joinId, 1);
    const other = typist(owner, session);
    const theirs = await stream(owner, session, other.joinId, 1);
    expect(await theirs.next((l) => 'joins' in l)).toMatchObject({
      draftHead: head,
      joins: [
        expect.objectContaining({ joinId: session.joinId, present: true }),
        expect.objectContaining({ joinId: other.joinId, order: 2, present: true }),
      ],
    });

    const update = starter.message('update');
    const presence = starter.message('presence');
    expect(await starter.send([update, presence])).toEqual({ positions: [2, null], grant: null });
    for (const s of [theirs, mine]) {
      expect(await s.next((l) => 'message' in l)).toEqual({
        message: { position: 2, message: update, covers: null, revisionId: null },
        draftHead: head,
      });
      expect(await s.next((l) => 'presence' in l)).toEqual({ presence, draftHead: head });
    }
    const said = other.message('update');
    await other.send([said]);
    expect(await mine.next((l) => 'message' in l)).toMatchObject({ message: { position: 3 } });

    // A newcomer gets every present join's latest presence, then what is stored.
    const later = typist(owner, session);
    const newcomer = await stream(owner, session, later.joinId, 0);
    await newcomer.next((l) => 'joins' in l);
    expect(await newcomer.next((l) => 'presence' in l)).toEqual({ presence, draftHead: head });
    for (const position of [1, 2, 3]) {
      expect(await newcomer.next((l) => 'message' in l)).toMatchObject({ message: { position } });
    }
    // A save moves the head, which every stream carries.
    await pages.editDraft(owner.ctx, lib.page, { markdown: 'saved meanwhile' });
    const moved = await headOf(owner, lib.page);
    expect(await mine.next((l) => l.draftHead === moved)).toEqual({ draftHead: moved });

    const { open } = await liveOf(owner, lib.page.pageId);
    expect(open?.messages.map((m) => m.position)).toEqual([2, 3]);
    expect(open?.position).toBe(3);
  });

  it('numbers stored messages without gaps, takes one sent again unchanged, and refuses the rest by code', async () => {
    const { owner, editor, lib } = await sharedLibrary();
    const session = await startSession(editor, lib.page);
    const me = typist(editor, session, session.joinId);
    me.started();
    const two = me.message('update');
    expect(await me.send([two])).toMatchObject({ positions: [2] });
    // Sent again after a lost answer: the same position.
    expect(await me.send([two])).toMatchObject({ positions: [2] });
    // Another at its seq shows two signed.
    const otherTwo = sealMessage(editor.ctx, session, {
      kind: 'update',
      joinId: me.joinId,
      seq: 2,
      content: utf8('else'),
    });
    expect(await rejection(me.send([otherTwo]))).toBe('duplicate');
    const four = sealMessage(editor.ctx, session, { kind: 'update', joinId: me.joinId, seq: 4 });
    expect(await rejection(me.send([four]))).toBe('invalid-request');
    const stalePresence = sealMessage(editor.ctx, session, {
      kind: 'presence',
      joinId: me.joinId,
      seq: 1,
    });
    expect(await rejection(me.send([stalePresence]))).toBe('invalid-request');
    const bigPresence = sealMessage(editor.ctx, session, {
      kind: 'presence',
      joinId: me.joinId,
      seq: 2,
      size: 640,
    });
    expect(await rejection(me.send([bigPresence]))).toBe('invalid-request');
    const unpadded = sealMessage(editor.ctx, session, {
      kind: 'update',
      joinId: me.joinId,
      seq: 3,
      size: 200,
    });
    expect(await rejection(me.send([unpadded]))).toBe('invalid-request');
    const huge = sealMessage(editor.ctx, session, {
      kind: 'update',
      joinId: me.joinId,
      seq: 3,
      size: liveRoutes.MAX_UPDATE_BYTES,
    });
    expect(await rejection(me.send([huge]))).toBe('payload-too-large');
    const saved = sealMessage(editor.ctx, session, { kind: 'saved', joinId: me.joinId, seq: 3 });
    expect(await rejection(me.send([saved]))).toBe('invalid-request');
    expect(await rejection(me.send([{ message: saved, covers: 99 }]))).toBe('invalid-request');
    const snapshot = sealMessage(editor.ctx, session, {
      kind: 'snapshot',
      joinId: me.joinId,
      seq: 3,
    });
    expect(await rejection(me.send([snapshot]))).toBe('invalid-request');
    // Sent as someone else, or from another join.
    const owners = sealMessage(owner.ctx, session, { kind: 'update', joinId: me.joinId, seq: 3 });
    expect(await rejection(me.send([owners]))).toBe('forbidden');
    const elsewhere = sealMessage(editor.ctx, session, {
      kind: 'update',
      joinId: newId(JoinId),
      seq: 3,
    });
    expect(await rejection(me.send([elsewhere]))).toBe('binding-mismatch');
    // A join nobody made, with no parent: joins come from the stream.
    const stranger = typist(editor, session);
    expect(await rejection(stranger.send([stranger.message('update')]))).toBe('invalid-request');
    // A whole request is refused together: the good one in it isn't stored.
    const three = sealMessage(editor.ctx, session, { kind: 'update', joinId: me.joinId, seq: 3 });
    const five = sealMessage(editor.ctx, session, { kind: 'update', joinId: me.joinId, seq: 5 });
    expect(await rejection(me.send([three, five]))).toBe('invalid-request');
    const saved4 = sealMessage(editor.ctx, session, { kind: 'saved', joinId: me.joinId, seq: 4 });
    expect(await me.send([three, { message: saved4, covers: 3 }])).toMatchObject({
      positions: [3, 4],
    });
    const { open } = await liveOf(editor, lib.page.pageId);
    expect(open?.messages.map((m) => [m.position, m.message.seq, m.covers])).toEqual([
      [2, 2, null],
      [3, 3, null],
      [4, 4, 3],
    ]);
  });

  it('allows a join two further joins, which keep no presence, and a person eight joins', async () => {
    const { owner, editor, lib } = await sharedLibrary();
    const session = await startSession(editor, lib.page);
    const parent = session.joinId;
    const copies = [typist(editor, session), typist(editor, session), typist(editor, session)];
    const [first, second, third] = copies;
    if (!first || !second || !third) throw new Error('three');
    expect(await first.send([first.message('update')], { parent })).toMatchObject({
      positions: [2],
    });
    await second.send([second.message('update')], { parent });
    expect(await rejection(third.send([third.message('update')], { parent }))).toBe('rate-limited');
    expect(await rejection(first.send([first.message('presence')]))).toBe('invalid-request');
    // Another person's join is no parent of the editor's.
    const owners = typist(owner, session);
    await stream(owner, session, owners.joinId, 1);
    expect(await rejection(third.send([third.message('update')], { parent: owners.joinId }))).toBe(
      'not-found',
    );
    // A further join can't open a stream.
    expect(await streamRefusal(editor, session, first.joinId)).toBe('not-found');

    // Eight present joins of one person, further joins included.
    const more = await Promise.all(
      Array.from({ length: 5 }, () => stream(editor, session, newId(JoinId), 1)),
    );
    expect(more).toHaveLength(5);
    expect(await streamRefusal(editor, session, newId(JoinId), 1)).toBe('rate-limited');
    // Once one leaves, there is room again.
    await editor.ctx.api.call(liveRoutes.leave, {
      params: { sessionId: session.sessionId },
      body: { joinId: first.joinId },
    });
    expect(await streamRefusal(editor, session, newId(JoinId), 1)).toBe('no error');
  });

  it('refuses a join that has gone, by leaving or by 30 s without a word', async () => {
    const { owner, editor, lib } = await sharedLibrary();
    const session = await startSession(editor, lib.page);
    const me = typist(editor, session, session.joinId);
    me.started();
    const further = typist(editor, session);
    await further.send([further.message('update')], { parent: me.joinId });
    await editor.ctx.api.call(liveRoutes.leave, {
      params: { sessionId: session.sessionId },
      body: { joinId: me.joinId },
    });
    expect(await rejection(me.send([me.message('update')]))).toBe('not-found');
    // Its further joins went with it.
    expect(await rejection(further.send([further.message('update')]))).toBe('not-found');
    expect(await streamRefusal(editor, session, me.joinId, 1)).toBe('not-found');

    const quiet = typist(owner, session);
    const opened = await stream(owner, session, quiet.joinId, 1);
    await quiet.send([quiet.message('presence')]);
    await t.db.execute(sql`
      update live_joins set last_message_at = now() - interval '31 seconds'
      where session_id = ${session.sessionId} and join_id = ${quiet.joinId}`);
    expect(await rejection(quiet.send([quiet.message('presence')]))).toBe('not-found');
    // Its stream closes once the server reads the session again.
    await t.live.refreshAll();
    await opened.closed();
    expect(opened.done).toBe(true);
  });

  it('opens no stream past the last position, nor from below what a snapshot covered', async () => {
    const { editor, lib } = await sharedLibrary();
    const session = await startSession(editor, lib.page);
    expect(await streamRefusal(editor, session, newId(JoinId), 5)).toBe('invalid-request');
  });
});

describe('ending', () => {
  it('ends the session in the transaction that removes a member, and takes nothing after but saved', async () => {
    const { owner, reader, editor, lib, shareId } = await sharedLibrary();
    const other = await personWithVault(t);
    await sharing.addMember(owner.ctx, {
      spaceId: lib.spaceId,
      shareId,
      person: await find(owner, other),
      role: 'editor',
    });
    const session = await startSession(editor, lib.page);
    const removed = await stream(editor, session, session.joinId, 1);
    const stays = typist(other, session);
    const staying = await stream(other, session, stays.joinId, 1);
    await stays.send([stays.message('update')]);

    await sharing.removeMember(owner.ctx, {
      spaceId: lib.spaceId,
      shareId,
      identityId: editor.vault.identity.public.id,
    });
    // Ended as the removal committed, not later.
    expect(await sessionRow(session.sessionId)).toMatchObject({ endedReason: 'access' });
    expect(await staying.next((l) => 'ended' in l)).toMatchObject({ ended: 'access' });
    await removed.closed();
    expect(removed.lines.some((l) => 'message' in l && l.message.position > 2)).toBe(false);

    const me = typist(editor, session, session.joinId);
    me.started();
    expect(await rejection(me.send([me.message('update')]))).toBe('not-found');
    expect(await rejection(liveOf(editor, lib.page.pageId))).toBe('not-found');
    expect(await rejection(stays.send([stays.message('update')]))).toBe('forbidden');
    expect(await rejection(stays.send([stays.message('presence')]))).toBe('forbidden');
    // A saved still lands, for what the session placed.
    const saved = stays.message('saved');
    expect(await stays.send([{ message: saved, covers: 2 }])).toMatchObject({ positions: [3] });
    // A reader saw none of it at any point.
    expect(await rejection(liveOf(reader, lib.page.pageId))).toBe('not-found');
    // A stream opened now sends the end and makes no join.
    const late = await stream(other, session, newId(JoinId), 0);
    expect(await late.next()).toMatchObject({ ended: 'access' });
  });

  it('ends at any change of access to the page, a member added included', async () => {
    const { owner, editor, lib, shareId } = await sharedLibrary();
    const session = await startSession(editor, lib.page);
    await sharing.addMember(owner.ctx, {
      spaceId: lib.spaceId,
      shareId,
      person: await find(owner, await personWithVault(t)),
      role: 'reader',
    });
    expect(await sessionRow(session.sessionId)).toMatchObject({ endedReason: 'access' });
    const outside = await startSession(owner, lib.beside);
    await pages.publishPage(owner.ctx, lib.beside);
    const { heads, permissionVersion } = await pages.loadPage(owner.ctx, lib.beside.pageId);
    if (!heads.publishedHead) throw new Error('expected a publication');
    await pages.unpublishPage(owner.ctx, lib.beside, {
      publishedHead: heads.publishedHead,
      permissionVersion,
    });
    expect(await sessionRow(outside.sessionId)).toMatchObject({ endedReason: 'access' });
  });

  it('lets a participant end it, after which another starts', async () => {
    const { editor, lib } = await sharedLibrary();
    const session = await startSession(editor, lib.page);
    const opened = await stream(editor, session, session.joinId, 1);
    await editor.ctx.api.call(liveRoutes.end, { params: { sessionId: session.sessionId } });
    expect(await opened.next((l) => 'ended' in l)).toMatchObject({ ended: 'ended' });
    await editor.ctx.api.call(liveRoutes.end, { params: { sessionId: session.sessionId } });
    const next = await startSession(editor, lib.page);
    expect((await liveOf(editor, lib.page.pageId)).open?.sessionId).toBe(next.sessionId);
  });
});

describe('deleting a session', () => {
  it('deletes it a minute after everyone left, once its last change is saved', async () => {
    const { editor, lib } = await sharedLibrary();
    const session = await startSession(editor, lib.page);
    const me = typist(editor, session, session.joinId);
    me.started();
    await me.send([me.message('update'), { message: me.message('saved'), covers: 2 }]);
    await everyoneLeft(session.sessionId, '10 seconds');
    await sweepLive(t.db, RETENTION);
    expect(await sessionRow(session.sessionId)).toBeDefined();
    await everyoneLeft(session.sessionId);
    await sweepLive(t.db, RETENTION);
    expect(await sessionRow(session.sessionId)).toBeUndefined();
    expect(await liveOf(editor, lib.page.pageId)).toMatchObject({ open: null, ended: null });
  });

  it('keeps one whose last change is unsaved for the next editor, up to the draft retention', async () => {
    const { owner, editor, lib } = await sharedLibrary();
    const session = await startSession(editor, lib.page);
    const me = typist(editor, session, session.joinId);
    me.started();
    await me.send([me.message('update'), { message: me.message('saved'), covers: 2 }]);
    await me.send([me.message('update')]);
    await everyoneLeft(session.sessionId);
    await sweepLive(t.db, RETENTION);
    const { open } = await liveOf(owner, lib.page.pageId);
    expect(open?.messages.map((m) => m.position)).toEqual([2, 3, 4]);
    expect(open?.joins.every((j) => !j.present)).toBe(true);
    await sweepLive(t.db, { retentionMs: 60_000 });
    expect(await sessionRow(session.sessionId)).toBeDefined();
    await t.db.execute(sql`
      update live_sessions set active_at = now() - interval '2 minutes'
      where id = ${session.sessionId}`);
    await sweepLive(t.db, { retentionMs: 60_000 });
    expect(await sessionRow(session.sessionId)).toBeUndefined();
  });

  it('keeps an ended one with unsaved changes read-only, serves it once all have left, and lets one editor catch up from it', async () => {
    const { owner, editor, lib } = await sharedLibrary();
    const session = await startSession(editor, lib.page);
    const me = typist(editor, session, session.joinId);
    me.started();
    await me.send([me.message('update')]);
    await editor.ctx.api.call(liveRoutes.end, { params: { sessionId: session.sessionId } });
    // While its joins are there, it isn't served as one to catch up from.
    expect((await liveOf(owner, lib.page.pageId)).ended).toBeNull();
    const catcher = typist(owner, session);
    expect(await rejection(catcher.send([], { fold: session.sessionId }))).toBe('not-found');
    await everyoneLeft(session.sessionId);
    await sweepLive(t.db, RETENTION);
    const { open, ended } = await liveOf(owner, lib.page.pageId);
    expect(open).toBeNull();
    expect(ended).toMatchObject({ sessionId: session.sessionId, ended: 'ended' });
    expect(ended?.messages.map((m) => m.position)).toEqual([2]);

    // One editor at a time catches up from it.
    const asked = await catcher.send([], { fold: session.sessionId });
    expect(asked.grant).toMatchObject({
      subject: session.sessionId,
      holder: { senderId: owner.vault.identity.public.id, joinId: catcher.joinId },
      lapsed: false,
      position: null,
    });
    // Nobody else catches up while that join is there.
    const rival = typist(editor, session);
    expect(await rejection(rival.send([], { fold: session.sessionId }))).toBe('not-found');
    expect(
      await rejection(catcher.send([catcher.message('update')], { fold: session.sessionId })),
    ).toBe('forbidden');
    const done = await catcher.send([{ message: catcher.message('saved'), covers: 2 }], {
      fold: session.sessionId,
    });
    expect(done.grant?.position).toBe(3);
    expect(await sessionRow(session.sessionId)).toBeUndefined();
  });

  it('deletes an ended one at once when it holds nothing unsaved, or when nobody’s keys count for it', async () => {
    const { owner, editor, lib, shareId } = await sharedLibrary();
    const saved = await startSession(editor, lib.page);
    await editor.ctx.api.call(liveRoutes.end, { params: { sessionId: saved.sessionId } });
    await everyoneLeft(saved.sessionId, '1 second');
    await sweepLive(t.db, RETENTION);
    expect(await sessionRow(saved.sessionId)).toBeUndefined();

    // Unsaved typing, then a rotation: the old key opens nothing anyone may write under.
    const session = await startSession(editor, lib.page);
    const me = typist(editor, session, session.joinId);
    me.started();
    await me.send([me.message('update')]);
    await sharing.rotateKeys(owner.ctx, { spaceId: lib.spaceId, shareId });
    expect(await sessionRow(session.sessionId)).toMatchObject({ endedReason: 'access' });
    await everyoneLeft(session.sessionId, '1 second');
    await sweepLive(t.db, RETENTION);
    expect(await sessionRow(session.sessionId)).toBeUndefined();
  });
});

describe('snapshots', () => {
  it('deletes what a later snapshot covers but the first snapshot and each join’s latest change', async () => {
    const { owner, editor, lib } = await sharedLibrary();
    const session = await startSession(editor, lib.page);
    const me = typist(editor, session, session.joinId);
    me.started();
    await me.send([me.message('update'), me.message('update')]);
    const other = typist(owner, session);
    await stream(owner, session, other.joinId, 1);
    await other.send([other.message('update')]);
    const poster = typist(editor, session);
    const post = (covers: number, seq: number, revisionId: RevisionId = session.revisionId) =>
      editor.ctx.api.call(liveRoutes.postSnapshot, {
        params: { sessionId: session.sessionId },
        body: {
          joinId: poster.joinId,
          parent: me.joinId,
          message: sealMessage(editor.ctx, session, {
            kind: 'snapshot',
            joinId: poster.joinId,
            seq,
          }),
          covers,
          revisionId,
        },
      });
    expect(await rejection(post(9, 1))).toBe('invalid-request');
    expect(await rejection(post(4, 1, (await headOf(owner, lib.beside)) as RevisionId))).toBe(
      'binding-mismatch',
    );
    expect(await post(4, 1)).toEqual({ position: 5 });
    const { open } = await liveOf(owner, lib.page.pageId);
    expect(open).toMatchObject({
      firstSnapshot: { position: 1 },
      snapshot: { position: 5, covers: 4, revisionId: session.revisionId },
      messages: [],
      position: 5,
    });
    expect(open?.latest.map((m) => m.position)).toEqual([3, 4]);
    const kept = await t.db
      .select({ position: schema.liveMessages.position })
      .from(schema.liveMessages)
      .where(eq(schema.liveMessages.sessionId, session.sessionId));
    expect(kept.map((r) => r.position).sort((a, b) => a - b)).toEqual([1, 3, 4, 5]);
    // None covers less than the latest, and what it covered can't be fetched again.
    expect(await rejection(post(3, 2))).toBe('stale-head');
    expect(await streamRefusal(owner, session, newId(JoinId), 2)).toBe('stale-head');
    const again = await post(5, 2);
    expect(again.position).toBe(6);
    const left = await t.db
      .select({ position: schema.liveMessages.position })
      .from(schema.liveMessages)
      .where(eq(schema.liveMessages.sessionId, session.sessionId));
    expect(left.map((r) => r.position).sort((a, b) => a - b)).toEqual([1, 3, 4, 6]);
  });

  it('keeps the drafts a kept session names past draft retention, and lets them go after', async () => {
    const { editor, lib } = await sharedLibrary();
    const session = await startSession(editor, lib.page);
    await pages.editDraft(editor.ctx, lib.page, { markdown: 'one' });
    const named = (await headOf(editor, lib.page)) as RevisionId;
    await pages.editDraft(editor.ctx, lib.page, { markdown: 'two' });
    await pages.editDraft(editor.ctx, lib.page, { markdown: 'three' });
    const poster = typist(editor, session);
    await editor.ctx.api.call(liveRoutes.postSnapshot, {
      params: { sessionId: session.sessionId },
      body: {
        joinId: poster.joinId,
        parent: session.joinId,
        message: poster.message('snapshot'),
        covers: 1,
        revisionId: named,
      },
    });
    const exists = async (id: string) =>
      (await t.db.select().from(schema.revisions).where(eq(schema.revisions.id, id))).length === 1;
    await sweepDrafts(t.db, { retentionMs: 0 });
    expect(await exists(session.revisionId)).toBe(true);
    expect(await exists(named)).toBe(true);
    await editor.ctx.api.call(liveRoutes.end, { params: { sessionId: session.sessionId } });
    await everyoneLeft(session.sessionId);
    await sweepLive(t.db, RETENTION);
    await sweepDrafts(t.db, { retentionMs: 0 });
    expect(await exists(session.revisionId)).toBe(false);
    expect(await exists(named)).toBe(false);
  });
});

describe('fold grants', () => {
  it('gives one join at a time the grant for the draft head, placed by a further join’s one update', async () => {
    const { owner, editor, lib } = await sharedLibrary();
    const session = await startSession(editor, lib.page);
    const saver = typist(editor, session, session.joinId);
    saver.started();
    const opened = await stream(editor, session, saver.joinId, 1);
    const other = typist(owner, session);
    await stream(owner, session, other.joinId, 1);
    // An outsider's save (an agent's, in the app) moves the head.
    await pages.editDraft(owner.ctx, lib.page, { markdown: 'from outside' });
    const outsider = await headOf(owner, lib.page);
    expect(await rejection(saver.send([], { fold: session.revisionId }))).toBe('stale-head');
    const given = await saver.send([], { fold: outsider });
    expect(given.grant).toMatchObject({
      subject: outsider,
      holder: { joinId: saver.joinId },
      position: null,
      lapsed: false,
    });
    expect(await opened.next((l) => 'grant' in l)).toMatchObject({
      grant: { subject: outsider, holder: { joinId: saver.joinId } },
    });
    // Another person asking gets the holder.
    expect((await other.send([], { fold: outsider })).grant?.holder.joinId).toBe(saver.joinId);
    // The other's further join holds nothing to place.
    const theirCopy = typist(owner, session);
    expect(
      await rejection(
        theirCopy.send([theirCopy.message('update')], { parent: other.joinId, fold: outsider }),
      ),
    ).toBe('forbidden');
    // The saver's copy places it with exactly one update.
    const copy = typist(editor, session);
    expect(
      await rejection(
        copy.send([copy.message('update'), copy.message('update')], {
          parent: saver.joinId,
          fold: outsider,
        }),
      ),
    ).toBe('invalid-request');
    const placed = await copy.send([copy.message('update')], {
      parent: saver.joinId,
      fold: outsider,
    });
    expect(placed.grant).toMatchObject({
      holder: { joinId: saver.joinId },
      position: placed.positions[0],
    });
    // None again for a revision whose fold was placed.
    expect((await other.send([], { fold: outsider })).grant).toMatchObject({
      holder: { joinId: saver.joinId },
      position: placed.positions[0],
    });
    const { open } = await liveOf(owner, lib.page.pageId);
    expect(open?.grants).toEqual([expect.objectContaining({ subject: outsider })]);
  });

  it('passes a lapsed grant to another person before the one whose grant lapsed', async () => {
    const { owner, editor, lib } = await sharedLibrary();
    const session = await startSession(editor, lib.page);
    const saver = typist(editor, session, session.joinId);
    saver.started();
    const other = typist(owner, session);
    await stream(owner, session, other.joinId, 1);
    await pages.editDraft(owner.ctx, lib.page, { markdown: 'from outside' });
    const outsider = await headOf(owner, lib.page);
    await saver.send([], { fold: outsider });
    const lapse = () =>
      t.db.execute(sql`
        update live_grants set granted_at = now() - interval '31 seconds'
        where session_id = ${session.sessionId} and position is null and lapsed_at is null`);
    await lapse();
    // The editor whose grant lapsed waits while someone else could ask.
    expect((await saver.send([], { fold: outsider })).grant).toMatchObject({
      holder: { joinId: saver.joinId },
      lapsed: true,
    });
    expect((await other.send([], { fold: outsider })).grant).toMatchObject({
      holder: { joinId: other.joinId },
      lapsed: false,
    });
    await lapse();
    expect((await saver.send([], { fold: outsider })).grant).toMatchObject({
      holder: { joinId: saver.joinId },
      lapsed: false,
    });
    expect(
      await t.db
        .select({ id: schema.liveGrants.id })
        .from(schema.liveGrants)
        .where(
          and(
            eq(schema.liveGrants.sessionId, session.sessionId),
            eq(schema.liveGrants.subject, outsider),
          ),
        ),
    ).toHaveLength(3);
  });
});

describe('limits', () => {
  it('charges stored messages to their sender’s storage until the session goes', async () => {
    const app = await scratch({ limits: { uploadBytes: 1024 * 1024, storageBytes: 300_000 } });
    const { editor, lib } = await sharedLibrary(app);
    const session = await startSession(editor, lib.page);
    const me = typist(editor, session, session.joinId);
    me.started();
    const size = 128 * 1024;
    await me.send([me.message('update', { size })]);
    const twice = me.message('update', { size: 2 * size });
    expect(await rejection(me.send([twice]))).toBe('storage-full');
  });

  it('takes at most 16 MiB of stored messages a minute from a person', async () => {
    const { editor, lib } = await sharedLibrary();
    const session = await startSession(editor, lib.page);
    const me = typist(editor, session, session.joinId);
    me.started();
    // The largest update that pads to a multiple of 128 bytes within 512 KiB sealed.
    const size = liveRoutes.MAX_UPDATE_BYTES - 128;
    let refused: string | undefined = 'no error';
    let sent = 0;
    while (refused === 'no error' && sent < 40) {
      const message = me.message('update', { size });
      refused = await rejection(me.send([message]));
      sent++;
    }
    expect(refused).toBe('rate-limited');
    expect((sent - 1) * (size + 16)).toBeLessThanOrEqual(liveRoutes.STORED_BYTES_PER_MINUTE);
    expect(sent * (size + 16)).toBeGreaterThan(liveRoutes.STORED_BYTES_PER_MINUTE - size);
  });

  it('counts every live route, the stream’s opening included, against one allowance', async () => {
    const app = await scratch({ rateLimit: true });
    const { editor, lib } = await sharedLibrary(app);
    const session = await startSession(editor, lib.page);
    await liveOf(editor, lib.page.pageId);
    const opened = await openStream(editor, session, { joinId: session.joinId, after: 1 });
    await opened.close();
    const [row] = await app.db
      .select()
      .from(schema.appRateLimits)
      .where(eq(schema.appRateLimits.key, `live account:${editor.id}`));
    // headOf's fetch, the start, the fetch and the stream.
    expect(row?.count).toBe(4);
  });
});
