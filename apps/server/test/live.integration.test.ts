// The live sessions server (protocol section 5.10, ADR 0015 step 4): who is
// served a session and may take part, how messages are numbered, relayed
// and limited, how a session ends with the page's access, and when it goes.
import {
  aeadDecrypt,
  endingOperations as ending,
  moveOperations as moves,
  fromBase64,
  metadataAd,
  newId,
  openSealedKey,
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
import {
  liveRecordHash,
  presenceContent,
  sealLiveMessage,
  startLiveSession,
  stateContent,
} from '@wikistow/client/live';
import {
  listenForTreeChanges,
  schema,
  storedAfter,
  sweepDrafts,
  sweepLive,
  usedBytes,
} from '@wikistow/server';
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
  send,
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

/** The first `count` message lines of a stream, then it is cancelled. */
async function readLines(response: Response, count: number) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('no body');
  const lines: liveRoutes.StreamLine[] = [];
  let rest = '';
  const decoder = new TextDecoder();
  while (lines.filter((line) => 'message' in line).length < count) {
    const { done, value } = await reader.read();
    if (done) break;
    rest += decoder.decode(value, { stream: true });
    const parts = rest.split('\n');
    rest = parts.pop() ?? '';
    for (const part of parts) {
      if (part.trim() !== '') lines.push(liveRoutes.StreamLine.parse(JSON.parse(part)));
    }
  }
  await reader.cancel();
  return lines;
}

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

  it('takes a start and messages as the client’s live module seals them', async () => {
    const { owner, lib } = await sharedLibrary();
    const page = lib.beside;
    const revisionId = await headOf(owner, page);
    const owners = (await sharing.ownerKeys(owner.ctx, page.spaceId)).owners.sealingOwners();
    const started = startLiveSession({
      author: owner.ctx.identity,
      installationId: owner.ctx.installationId,
      spaceId: page.spaceId,
      pageId: page.pageId,
      revisionId,
      owners,
    });
    // The session key, from the owner's own envelope, as opening the record finds it.
    const [envelope] = started.envelopes;
    if (!envelope) throw new Error('an envelope to the owner');
    const contentKey = openSealedKey(owner.ctx.identity, envelope.sealedKey);
    const opened = JSON.parse(
      new TextDecoder().decode(
        aeadDecrypt({
          key: contentKey,
          sealed: started.sealed.payload,
          ad: metadataAd(started.sealed.record),
        }),
      ),
    ) as { key: string };
    const binding = {
      installationId: owner.ctx.installationId,
      spaceId: page.spaceId,
      pageId: page.pageId,
      sessionId: started.sessionId,
      recordHash: liveRecordHash(started.sealed.record),
      key: fromBase64(opened.key),
    };
    const seal = (kind: liveRoutes.LiveMessage['kind'], seq: number, content: Uint8Array) =>
      sealLiveMessage({
        sender: owner.ctx.identity,
        binding,
        kind,
        joinId: started.joinId,
        seq,
        clock: 0,
        content,
      });
    const { permissionVersion } = await pages.loadPage(owner.ctx, page.pageId);
    await owner.ctx.api.call(liveRoutes.startLive, {
      params: { pageId: page.pageId },
      body: {
        sessionId: started.sessionId,
        joinId: started.joinId,
        revisionId,
        metadata: started.sealed,
        wrap: started.wrap,
        envelopes: started.envelopes,
        snapshot: seal('snapshot', 1, stateContent(revisionId, new Uint8Array([0, 0]))),
        permissionVersion,
      },
    });
    const update = seal('update', 2, new Uint8Array([0, 0]));
    const presence = seal(
      'presence',
      2,
      presenceContent({
        format: { major: 1, minor: 0 },
        editor: 'source',
        visible: true,
        publishing: false,
        saveFailing: null,
        cursor: null,
      }),
    );
    expect(
      await owner.ctx.api.call(liveRoutes.sendMessages, {
        params: { sessionId: started.sessionId },
        body: { joinId: started.joinId, messages: [{ message: update }, { message: presence }] },
      }),
    ).toEqual({ positions: [2, null], grant: null });
    const { open } = await liveOf(owner, page.pageId);
    expect(open?.record).toEqual(started.sealed);
    expect(open?.messages.map((m) => m.message)).toEqual([update]);
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

  it('keeps a starter’s join present 30 s until its stream opens, whatever it sends', async () => {
    const { owner, editor, lib } = await sharedLibrary();
    const session = await startSession(editor, lib.page);
    const me = typist(editor, session, session.joinId);
    me.started();
    await me.send([me.message('presence')]);
    await t.db.execute(sql`
      update live_joins set stream_broke_at = now() - interval '31 seconds'
      where session_id = ${session.sessionId}`);
    expect(await rejection(me.send([me.message('presence')]))).toBe('not-found');
    // Opened in time, the stream keeps it.
    const other = await startSession(owner, lib.beside);
    await stream(owner, other, other.joinId, 1);
    await t.db.execute(sql`
      update live_joins set last_message_at = now() - interval '20 seconds'
      where session_id = ${other.sessionId}`);
    const theirs = typist(owner, other, other.joinId);
    theirs.started();
    expect(await theirs.send([theirs.message('presence')])).toMatchObject({ positions: [null] });
  });

  it('lets a person make so many joins in one session, then refuses more', async () => {
    const { editor, lib } = await sharedLibrary();
    const session = await startSession(editor, lib.page);
    const leave = (joinId: JoinId) =>
      editor.ctx.api.call(liveRoutes.leave, {
        params: { sessionId: session.sessionId },
        body: { joinId },
      });
    // The starter's join is the first; further joins, made and left, count too.
    for (let made = 1; made < liveRoutes.MAX_JOINS_MADE_PER_PERSON; made++) {
      const copy = typist(editor, session);
      await copy.send([copy.message('update')], { parent: session.joinId });
      await leave(copy.joinId);
    }
    const one = typist(editor, session);
    expect(await rejection(one.send([one.message('update')], { parent: session.joinId }))).toBe(
      'rate-limited',
    );
    expect(await streamRefusal(editor, session, newId(JoinId), 1)).toBe('rate-limited');
  });

  it('reads stored messages for a stream 2 MiB at a time', async () => {
    const { editor, lib } = await sharedLibrary();
    const session = await startSession(editor, lib.page);
    const me = typist(editor, session, session.joinId);
    me.started();
    const size = liveRoutes.MAX_UPDATE_BYTES - 128;
    for (let i = 0; i < 6; i++) await me.send([me.message('update', { size })]);
    const { messages: batch } = await storedAfter(t.db, session.sessionId, 1);
    // Four make just under 2 MiB, so a fifth starts the next read.
    expect(batch.map((m) => m.position)).toEqual([2, 3, 4, 5]);
    const { messages: rest } = await storedAfter(t.db, session.sessionId, 5);
    expect(rest.map((m) => m.position)).toEqual([6, 7]);
  });

  it('takes a request with a presence before its stored messages sent again unchanged', async () => {
    const { editor, lib } = await sharedLibrary();
    const session = await startSession(editor, lib.page);
    const me = typist(editor, session, session.joinId);
    me.started();
    const request = [me.message('presence'), me.message('update')];
    const first = await me.send(request);
    expect(first.positions).toEqual([null, 2]);
    expect(await me.send(request)).toEqual(first);
  });

  it('takes one presence a request, and opens no stream from another site', async () => {
    const { editor, lib } = await sharedLibrary();
    const session = await startSession(editor, lib.page);
    const me = typist(editor, session, session.joinId);
    me.started();
    expect(await rejection(me.send([me.message('presence'), me.message('presence')]))).toBe(
      'invalid-request',
    );
    const response = await editor.browser.request(
      `/api/live/${session.sessionId}/stream?after=1&joinId=${newId(JoinId)}`,
      { headers: { 'sec-fetch-site': 'cross-site' } },
    );
    expect(response.status).toBe(403);
    // Nor by a navigation, which asks for a page.
    const navigated = await editor.browser.request(
      `/api/live/${session.sessionId}/stream?after=1&joinId=${newId(JoinId)}`,
      { headers: { accept: 'text/html,application/xhtml+xml,*/*;q=0.8' } },
    );
    expect(navigated.status).toBe(403);
    expect((await liveOf(editor, lib.page.pageId)).open?.joins).toHaveLength(1);
  });

  it('keeps a person to 16 open streams, every session together', async () => {
    const { owner, lib } = await sharedLibrary();
    const more = await Promise.all(
      ['A', 'B', 'C'].map((title) =>
        pages.createPage(owner.ctx, { spaceId: lib.spaceId, parentId: null, title }),
      ),
    );
    const sessions = [];
    for (const pageId of more)
      sessions.push(await startSession(owner, { spaceId: lib.spaceId, pageId }));
    const [a, b, c] = sessions;
    if (!a || !b || !c) throw new Error('three');
    for (const session of [a, b]) {
      // The starter's join and seven more: eight in each.
      await stream(owner, session, session.joinId, 1);
      await Promise.all(Array.from({ length: 7 }, () => stream(owner, session, newId(JoinId), 1)));
    }
    expect(await streamRefusal(owner, c, newId(JoinId), 1)).toBe('rate-limited');
  });

  it('opens no stream past the last position', async () => {
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
    // A stream opened now makes no join, and sends the end; the saved covers what the
    // session kept, so there is nothing to catch up from, and it sends none of it.
    const joinsBefore = (await liveOf(other, lib.page.pageId)).ended?.joins.length;
    const late = await stream(other, session, newId(JoinId), 0);
    const kept = [];
    for (let line = await late.next(); !('ended' in line); line = await late.next()) {
      if ('message' in line) kept.push(line.message.position);
    }
    expect(kept).toEqual([]);
    await late.closed();
    expect((await liveOf(other, lib.page.pageId)).ended?.joins.length).toBe(joinsBefore);
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

  it('takes a message stored before the end, sent again after it, as stored', async () => {
    const { editor, lib } = await sharedLibrary();
    const session = await startSession(editor, lib.page);
    const me = typist(editor, session, session.joinId);
    me.started();
    const update = me.message('update');
    const presence = me.message('presence');
    expect(await me.send([update, presence])).toMatchObject({ positions: [2, null] });
    await editor.ctx.api.call(liveRoutes.end, { params: { sessionId: session.sessionId } });
    // The whole request, its presence too, as it went the first time.
    expect(await me.send([update, presence])).toMatchObject({ positions: [2, null] });
    expect(await me.send([update])).toMatchObject({ positions: [2] });
    expect(await rejection(me.send([me.message('update')]))).toBe('forbidden');
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
    // The retention counts from when its last join went.
    await sweepLive(t.db, { retentionMs: 10 * 60_000 });
    expect(await sessionRow(session.sessionId)).toBeDefined();
    await sweepLive(t.db, { retentionMs: 60_000 });
    expect(await sessionRow(session.sessionId)).toBeUndefined();
  });

  it('deletes an ended one past the draft retention from its end, whoever is still in it', async () => {
    const { editor, lib } = await sharedLibrary();
    const session = await startSession(editor, lib.page);
    const me = typist(editor, session, session.joinId);
    me.started();
    await stream(editor, session, me.joinId, 1);
    await me.send([me.message('update')]);
    await editor.ctx.api.call(liveRoutes.end, { params: { sessionId: session.sessionId } });
    await t.db.execute(sql`
      update live_sessions set ended_at = now() - interval '2 minutes'
      where id = ${session.sessionId}`);
    await sweepLive(t.db, RETENTION);
    expect(await sessionRow(session.sessionId)).toBeDefined();
    await sweepLive(t.db, { retentionMs: 60_000 });
    expect(await sessionRow(session.sessionId)).toBeUndefined();
  });

  it('keeps nobody present in an ended session by requests that send nothing', async () => {
    const { owner, editor, lib } = await sharedLibrary();
    const session = await startSession(editor, lib.page);
    const me = typist(editor, session, session.joinId);
    me.started();
    await me.send([me.message('update')]);
    await editor.ctx.api.call(liveRoutes.end, { params: { sessionId: session.sessionId } });
    await t.db.execute(sql`
      update live_joins set last_message_at = now() - interval '25 seconds',
        stream_broke_at = null
      where session_id = ${session.sessionId}`);
    await me.send([]);
    await t.db.execute(sql`
      update live_joins set last_message_at = last_message_at - interval '10 seconds'
      where session_id = ${session.sessionId}`);
    expect((await liveOf(owner, lib.page.pageId)).ended?.sessionId).toBe(session.sessionId);
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
    // Nobody else takes it while it holds, nor sends the saved that lets the session go,
    // but once it lapses, another may.
    const rival = typist(editor, session);
    expect(
      await rejection(
        rival.send([{ message: rival.message('saved'), covers: 2 }], { fold: session.sessionId }),
      ),
    ).toBe('forbidden');
    expect(await sessionRow(session.sessionId)).toBeDefined();
    expect((await rival.send([], { fold: session.sessionId })).grant?.holder.joinId).toBe(
      catcher.joinId,
    );
    // Nor from its catch-up join without naming the grant.
    expect(await rejection(rival.send([{ message: rival.message('saved'), covers: 2 }]))).toBe(
      'forbidden',
    );
    await t.db.execute(sql`
      update live_grants set granted_at = now() - interval '11 minutes'
      where session_id = ${session.sessionId}`);
    expect((await rival.send([], { fold: session.sessionId })).grant).toMatchObject({
      holder: { joinId: rival.joinId },
      lapsed: false,
    });
    expect((await catcher.send([], { fold: session.sessionId })).grant?.holder.joinId).toBe(
      rival.joinId,
    );
    await t.db.execute(sql`
      update live_grants set granted_at = now() - interval '11 minutes'
      where session_id = ${session.sessionId} and join_id = ${rival.joinId}`);
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
    // Nobody catches up from it, which would only keep it.
    const catcher = typist(owner, saved);
    expect(await rejection(catcher.send([], { fold: saved.sessionId }))).toBe('not-found');
    await sweepLive(t.db, RETENTION);
    expect(await sessionRow(saved.sessionId)).toBeUndefined();

    // Unsaved typing, then a rotation: the old key opens nothing anyone may write under.
    const session = await startSession(editor, lib.page);
    const me = typist(editor, session, session.joinId);
    me.started();
    await me.send([me.message('update')]);
    await sharing.rotateKeys(owner.ctx, { spaceId: lib.spaceId, shareId });
    expect(await sessionRow(session.sessionId)).toMatchObject({ endedReason: 'access' });
    // Everyone has left, but nobody's keys count for it, so its stream reads nothing of it.
    await everyoneLeft(session.sessionId, '1 second');
    const reading = await stream(owner, session, newId(JoinId), 0);
    expect(await reading.next()).toMatchObject({ ended: 'access' });
    expect(reading.lines.some((l) => 'message' in l)).toBe(false);
    await sweepLive(t.db, RETENTION);
    expect(await sessionRow(session.sessionId)).toBeUndefined();

    // Unsaved typing, then the share ends: its wrap goes with it, and so does the session.
    const last = await startSession(editor, lib.page);
    const typing = typist(editor, last, last.joinId);
    typing.started();
    await typing.send([typing.message('update')]);
    await ending.endShare(owner.ctx, {
      preview: await ending.previewEnding(owner.ctx, { spaceId: lib.spaceId, shareId }),
    });
    expect(await sessionRow(last.sessionId)).toMatchObject({ endedReason: 'access' });
    await everyoneLeft(last.sessionId, '1 second');
    expect((await liveOf(owner, lib.page.pageId)).ended).toBeNull();
    await sweepLive(t.db, RETENTION);
    expect(await sessionRow(last.sessionId)).toBeUndefined();
  });

  it('serves nobody a session its page moved out of, even once the page is back', async () => {
    const { owner, editor, lib } = await sharedLibrary();
    const session = await startSession(editor, lib.page);
    const me = typist(editor, session, session.joinId);
    me.started();
    await me.send([me.message('update')]);
    const move = async (parentId: typeof lib.shared) =>
      moves.moveNode(owner.ctx, {
        preview: await moves.previewMove(owner.ctx, {
          spaceId: lib.spaceId,
          nodeId: lib.page.pageId,
          parentId,
        }),
      });
    await move(lib.above);
    await move(lib.shared);
    expect(await sessionRow(session.sessionId)).toMatchObject({ endedReason: 'access' });
    await everyoneLeft(session.sessionId);
    expect((await liveOf(owner, lib.page.pageId)).ended).toBeNull();
    const catcher = typist(owner, session);
    expect(await rejection(catcher.send([], { fold: session.sessionId }))).toBe('not-found');
    await sweepLive(t.db, RETENTION);
    expect(await sessionRow(session.sessionId)).toBeUndefined();
  });

  it('keeps only a page’s latest ended session with unsaved changes', async () => {
    const { editor, lib } = await sharedLibrary();
    const sessions = [];
    for (let i = 0; i < 2; i++) {
      const session = await startSession(editor, lib.page);
      const me = typist(editor, session, session.joinId);
      me.started();
      await me.send([me.message('update')]);
      await editor.ctx.api.call(liveRoutes.end, { params: { sessionId: session.sessionId } });
      await everyoneLeft(session.sessionId);
      sessions.push(session);
    }
    const [older, newer] = sessions;
    if (!older || !newer) throw new Error('two');
    await sweepLive(t.db, RETENTION);
    expect(await sessionRow(older.sessionId)).toBeUndefined();
    expect(await sessionRow(newer.sessionId)).toBeDefined();
    expect((await liveOf(editor, lib.page.pageId)).ended?.sessionId).toBe(newer.sessionId);
  });

  it('keeps session IDs and their version IDs taken after the session goes', async () => {
    const { editor, lib } = await sharedLibrary();
    const session = await startSession(editor, lib.page);
    await editor.ctx.api.call(liveRoutes.end, { params: { sessionId: session.sessionId } });
    await everyoneLeft(session.sessionId);
    await sweepLive(t.db, RETENTION);
    expect(await sessionRow(session.sessionId)).toBeUndefined();
    const revisionId = await headOf(editor, lib.page);
    const { body } = await sealStart(editor.ctx, lib.page, {
      revisionId,
      sessionId: session.sessionId,
    });
    expect(await rejection(sendStart(editor.ctx, lib.page.pageId, body))).toBe('duplicate');
    const { body: version } = await sealStart(editor.ctx, lib.page, {
      revisionId,
      versionId: session.versionId,
    });
    expect(await rejection(sendStart(editor.ctx, lib.page.pageId, version))).toBe('duplicate');
    const comment = await sealComment(editor.ctx, lib.page, {
      audience: 'draft',
      text: 'later',
      versionId: session.versionId,
    });
    expect(await rejection(sendComment(editor.ctx, lib.page.pageId, comment))).toBe('duplicate');
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
    // A read of what it deleted finds nothing, and says what the snapshot covers.
    expect(await storedAfter(t.db, session.sessionId, 1, { upTo: 2 })).toEqual({
      messages: [],
      snapshotCovers: 4,
    });
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

  it('serves what a snapshot kept within one fetch’s budget, and the rest from the stream', async () => {
    const { owner, editor, lib } = await sharedLibrary();
    const session = await startSession(editor, lib.page);
    const size = liveRoutes.MAX_UPDATE_BYTES - 128;
    // Twenty joins each keep one large change once a snapshot covers them.
    for (let i = 0; i < 20; i++) {
      const copy = typist(editor, session);
      await copy.send([copy.message('update', { size })], { parent: session.joinId });
      await editor.ctx.api.call(liveRoutes.leave, {
        params: { sessionId: session.sessionId },
        body: { joinId: copy.joinId },
      });
    }
    const poster = typist(editor, session);
    await editor.ctx.api.call(liveRoutes.postSnapshot, {
      params: { sessionId: session.sessionId },
      body: {
        joinId: poster.joinId,
        parent: session.joinId,
        message: poster.message('snapshot'),
        covers: 21,
        revisionId: session.revisionId,
      },
    });
    const { open } = await liveOf(owner, lib.page.pageId);
    if (!open) throw new Error('expected the session');
    expect(open.complete).toBe(false);
    expect(open.messages).toEqual([]);
    const served = open.latest.map((m) => m.position);
    expect(served.length).toBeGreaterThan(10);
    expect(served.length).toBeLessThan(20);
    expect(open.position).toBe(served.at(-1));
    // Without `kept`, below what the snapshot covers is refused; with it, the rest comes.
    const join = newId(JoinId);
    expect(await streamRefusal(owner, session, join, open.position)).toBe('stale-head');
    const response = await owner.browser.request(
      `/api/live/${session.sessionId}/stream?after=${open.position}&joinId=${join}&kept=${open.snapshot?.covers}`,
    );
    expect(response.ok).toBe(true);
    // The rest of what it kept, then the snapshot itself, at 22.
    const left = 22 - (served.length + 1);
    const text = await readLines(response, left);
    const positions = text.flatMap((line) => ('message' in line ? [line.message.position] : []));
    expect(positions).toEqual(Array.from({ length: left }, (_, i) => served.length + 2 + i));
    // Once a newer snapshot comes, a fetch built on the older one starts afresh.
    const later = typist(editor, session);
    await editor.ctx.api.call(liveRoutes.postSnapshot, {
      params: { sessionId: session.sessionId },
      body: {
        joinId: later.joinId,
        parent: session.joinId,
        message: later.message('snapshot'),
        covers: 22,
        revisionId: session.revisionId,
      },
    });
    const stale = await owner.browser.request(
      `/api/live/${session.sessionId}/stream?after=${open.position}&joinId=${newId(JoinId)}&kept=${open.snapshot?.covers}`,
    );
    expect(stale.status).toBe(409);
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
    const placing = copy.message('update');
    const placed = await copy.send([placing], { parent: saver.joinId, fold: outsider });
    expect(placed.grant).toMatchObject({
      holder: { joinId: saver.joinId },
      position: placed.positions[0],
    });
    // Sent again byte for byte after a lost answer, it is answered as before.
    expect(
      await send(editor, session, copy.joinId, [placing], { parent: saver.joinId, fold: outsider }),
    ).toEqual(placed);
    // None again for a revision whose fold was placed.
    expect((await other.send([], { fold: outsider })).grant).toMatchObject({
      holder: { joinId: saver.joinId },
      position: placed.positions[0],
    });
    const { open } = await liveOf(owner, lib.page.pageId);
    expect(open?.grants).toEqual([expect.objectContaining({ subject: outsider })]);
    // A stream opened now hears of it among its first lines.
    const late = await stream(owner, session, newId(JoinId), open?.position ?? 0);
    expect(await late.next((l) => 'grant' in l)).toMatchObject({
      grant: { subject: outsider, position: placed.positions[0] },
    });
  });

  it('gives a lapsed grant back to its holder 30 s on, when nobody else asked', async () => {
    const { owner, editor, lib } = await sharedLibrary();
    const session = await startSession(editor, lib.page);
    const saver = typist(editor, session, session.joinId);
    saver.started();
    const other = typist(owner, session);
    await stream(owner, session, other.joinId, 1);
    await pages.editDraft(owner.ctx, lib.page, { markdown: 'from outside' });
    const outsider = await headOf(owner, lib.page);
    await saver.send([], { fold: outsider });
    await t.db.execute(sql`
      update live_grants set granted_at = now() - interval '31 seconds'
      where session_id = ${session.sessionId}`);
    expect((await saver.send([], { fold: outsider })).grant?.lapsed).toBe(true);
    await t.db.execute(sql`
      update live_grants set lapsed_at = now() - interval '31 seconds'
      where session_id = ${session.sessionId}`);
    expect((await saver.send([], { fold: outsider })).grant).toMatchObject({
      holder: { joinId: saver.joinId },
      lapsed: false,
    });
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
    // A message that fits what is left lands, counted once.
    const before = await usedBytes(app.db, editor.id);
    const room = 300_000 - before;
    const size = 128 * Math.floor(((room * 2) / 3 - 16) / 128);
    expect(size + 16).toBeLessThan(room);
    expect(2 * (size + 16)).toBeGreaterThan(room);
    await me.send([me.message('update', { size })]);
    // Its ciphertext as stored, and what its row takes besides.
    expect(await usedBytes(app.db, editor.id)).toBe(
      before + Math.ceil(((size + 16) * 4) / 3) + schema.LIVE_MESSAGE_BYTES,
    );
    expect(await rejection(me.send([me.message('update', { size })]))).toBe('storage-full');
    // And it stops counting once the session goes.
    await editor.ctx.api.call(liveRoutes.end, { params: { sessionId: session.sessionId } });
    await app.db.execute(sql`
      update live_joins set left_at = now() - interval '2 minutes'
      where session_id = ${session.sessionId}`);
    await app.db.execute(sql`
      update live_sessions set ended_at = now() - interval '2 minutes'
      where id = ${session.sessionId}`);
    await sweepLive(app.db, { retentionMs: 60_000 });
    expect(await usedBytes(app.db, editor.id)).toBeLessThan(before);
  });

  it('charges a snapshot once what it covers has gone, so it can free room for itself', async () => {
    const app = await scratch({ limits: { uploadBytes: 1024 * 1024, storageBytes: 400_000 } });
    const { editor, lib } = await sharedLibrary(app);
    const session = await startSession(editor, lib.page);
    const me = typist(editor, session, session.joinId);
    me.started();
    // Two changes that fill most of the room left.
    const room = 400_000 - (await usedBytes(app.db, editor.id));
    const size = 128 * Math.floor((room * 0.36) / 128);
    await me.send([me.message('update', { size })]);
    await me.send([me.message('update', { size })]);
    expect(await rejection(me.send([me.message('update', { size })]))).toBe('storage-full');
    // A snapshot as large deletes the first of them, and fits.
    const poster = typist(editor, session);
    expect(
      await editor.ctx.api.call(liveRoutes.postSnapshot, {
        params: { sessionId: session.sessionId },
        body: {
          joinId: poster.joinId,
          parent: me.joinId,
          message: poster.message('snapshot', { size }),
          covers: 3,
          revisionId: session.revisionId,
        },
      }),
    ).toMatchObject({ position: 4 });
  });

  it('counts storage once a statement, so deleting many messages stays quick and exact', async () => {
    const { editor, lib } = await sharedLibrary();
    const session = await startSession(editor, lib.page);
    const before = await usedBytes(t.db, editor.id);
    const [first] = await t.db
      .select()
      .from(schema.liveMessages)
      .where(eq(schema.liveMessages.sessionId, session.sessionId));
    if (!first) throw new Error('the first snapshot');
    await t.db.execute(sql`
      insert into live_messages (session_id, position, kind, identity_id, join_id, seq,
        account_id, message, size)
      select ${session.sessionId}, 1 + g, 'update', ${first.identityId}, ${first.joinId}, 1 + g,
        ${editor.id}::uuid, ${JSON.stringify(first.message)}::jsonb, 144
      from generate_series(1, 20000) g`);
    expect(await usedBytes(t.db, editor.id)).toBe(
      before + 20000 * (Math.ceil((144 * 4) / 3) + 1024),
    );
    const row = await sessionRow(session.sessionId);
    if (!row) throw new Error('the session');
    const started = Date.now();
    await t.db.delete(schema.liveSessions).where(eq(schema.liveSessions.id, session.sessionId));
    expect(Date.now() - started).toBeLessThan(10_000);
    // Its record, first snapshot and join go with it; its used ID is kept for good.
    const snapshot = Math.ceil((first.size * 4) / 3) + schema.LIVE_MESSAGE_BYTES;
    expect(await usedBytes(t.db, editor.id)).toBe(
      before - row.payloadSize - snapshot - schema.LIVE_JOIN_BYTES,
    );
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

  it('starts sessions while the same person types elsewhere, without waiting in a ring', async () => {
    const { owner, lib } = await sharedLibrary();
    const session = await startSession(owner, lib.page);
    const me = typist(owner, session, session.joinId);
    me.started();
    await stream(owner, session, me.joinId, 1);
    const pagesToStart = await Promise.all(
      // Two at once, as many as the snapshot pool takes from one person.
      ['A', 'B'].map((title) =>
        pages.createPage(owner.ctx, { spaceId: lib.spaceId, parentId: null, title }),
      ),
    );
    const heads: RevisionId[] = [];
    for (const pageId of pagesToStart)
      heads.push(await headOf(owner, { spaceId: lib.spaceId, pageId }));
    const starts = await Promise.all(
      pagesToStart.map((pageId, i) =>
        sealStart(
          owner.ctx,
          { spaceId: lib.spaceId, pageId },
          { revisionId: heads[i] as RevisionId },
        ),
      ),
    );
    const typing = async () => {
      for (let i = 0; i < 6; i++) await me.send([me.message('update')]);
    };
    const answers = await Promise.all([
      typing().then(() => 'no error'),
      ...starts.map(({ body }, i) =>
        rejection(sendStart(owner.ctx, pagesToStart[i] as typeof lib.page.pageId, body)),
      ),
    ]);
    expect(answers).toEqual(['no error', 'no error', 'no error']);
  });

  it('takes so many live writes of one person’s at once, and refuses the rest', async () => {
    const { editor, lib } = await sharedLibrary();
    const session = await startSession(editor, lib.page);
    const me = typist(editor, session, session.joinId);
    me.started();
    const answers = await Promise.all(
      Array.from({ length: 40 }, () => rejection(me.send([me.message('presence')]))),
    );
    expect(answers).toContain('rate-limited');
    expect(answers).toContain('no error');
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
