// A receiver's checks of each join's messages (protocol section 5.10): `seq`
// order with no gaps, repeats and equivocation, `clock` contiguous per join,
// updates only under their own join's client, and nothing placed next to or
// deleted from typing its join hasn't signed.
import { describe, expect, it } from 'vite-plus/test';
import * as Y from 'yjs';
import { newPayload } from '../src/index.ts';
import {
  decodeUpdate,
  firstSnapshot,
  JoinId,
  liveBinding,
  LiveJoins,
  openLiveMessage,
  readSnapshot,
  stateContent,
  type LiveMessage,
  type OpenedLiveMessage,
} from '../src/live/index.ts';
import { update } from './support/yjs-bytes.ts';
import {
  alice,
  app,
  bob,
  carol,
  draftId,
  everyoneTrusted,
  installationId,
  open,
  start,
  Typist,
} from './support/live.ts';

const started = start();
const session = open(started, app(alice));
const binding = liveBinding(session);
const starter = { senderId: carol.public.id, joinId: started.joinId };

// Carol started the session and types; Bob joined and types. Alice's app receives.
function setup() {
  const clientId = new Typist(carol, binding, started.joinId).clientId;
  const first = firstSnapshot({
    sender: carol,
    binding,
    joinId: started.joinId,
    clientId,
    revisionId: draftId,
    payload: newPayload({ title: 'Lasagne', markdown: 'Brown the mince.' }),
  });
  const carols = new Typist(carol, binding, started.joinId, first.document);
  carols.seq = 1;
  const bobs = new Typist(bob, binding);
  const joins = new LiveJoins({ installationId, sessionId: binding.sessionId, starter });
  joins.list([carols.listed, bobs.listed]);
  return { carols, bobs, joins, first: first.message };
}

const opened = (message: LiveMessage): OpenedLiveMessage =>
  openLiveMessage({ binding, trust: everyoneTrusted, listed: () => true, message });

// What a receiver does: open, decode, check, and take what fits.
function receive(joins: LiveJoins, message: LiveMessage) {
  const m = opened(message);
  const content =
    m.kind === 'update'
      ? decodeUpdate(m.content)
      : m.kind === 'snapshot'
        ? (() => {
            const read = readSnapshot(m.content);
            return read.kind === 'current' ? decodeUpdate(read.state) : undefined;
          })()
        : undefined;
  const verdict = joins.check(m, content);
  if (verdict.kind === 'take') joins.take(m);
  return verdict;
}

const body = (t: Typist) => t.document.text('body');

describe('taking a join’s messages', () => {
  it('takes the first snapshot, then each join’s updates in order, signing its clock', () => {
    const { carols, bobs, joins, first } = setup();
    expect(receive(joins, first)).toEqual({ kind: 'take' });
    expect(joins.signed(carols.clientId)).toBe(
      Y.getState(carols.document.doc.store, carols.clientId),
    );
    const a = carols.type((d) => d.text('body').insert(0, 'First, ')).send();
    expect(receive(joins, a)).toEqual({ kind: 'take' });
    bobs.receive(first);
    bobs.receive(a);
    const b = bobs.type((d) => d.text('body').insert(body(bobs).length, ' Then bake.')).send();
    expect(receive(joins, b)).toEqual({ kind: 'take' });
    // A change that only deletes leaves its clock where it was.
    const c = carols.type((d) => d.text('body').delete(0, 2)).send();
    expect(opened(c).clock).toBe(opened(a).clock);
    expect(receive(joins, c)).toEqual({ kind: 'take' });
  });

  it('drops a repeat, and reports two messages signed at one seq', () => {
    const { carols, joins, first } = setup();
    receive(joins, first);
    const a = carols.type((d) => d.text('body').insert(0, 'x')).send();
    expect(receive(joins, a)).toEqual({ kind: 'take' });
    expect(receive(joins, a)).toEqual({ kind: 'repeat' });
    carols.seq -= 1;
    const twin = carols.type((d) => d.text('body').insert(0, 'y')).send();
    expect(receive(joins, twin)).toEqual({
      kind: 'equivocation',
      sender: { senderId: carol.public.id, joinId: started.joinId },
    });
    // Even a twin of the first snapshot, of another kind.
    carols.seq = 0;
    const saved = carols.seal('saved', new TextEncoder().encode('{}'));
    expect(receive(joins, saved)).toMatchObject({ kind: 'equivocation' });
  });

  it('holds a message past a gap, and refuses one below where its order started', () => {
    const { carols, joins, first } = setup();
    receive(joins, first);
    const a = carols.type((d) => d.text('body').insert(0, 'a')).send();
    const b = carols.type((d) => d.text('body').insert(0, 'b')).send();
    expect(receive(joins, b)).toEqual({ kind: 'hold', reason: 'gap' });
    expect(receive(joins, a)).toEqual({ kind: 'take' });
    expect(receive(joins, b)).toEqual({ kind: 'take' });
    // Another message at a seq taken already is equivocation, whatever its seq.
    carols.seq = 1;
    const twin = carols.type((d) => d.text('body').insert(0, 'c')).send();
    expect(receive(joins, twin)).toMatchObject({ kind: 'equivocation' });
    expect(() => joins.take(opened(twin))).toThrow();
    // A newcomer that started after it refuses one below where it started.
    const newcomer = new LiveJoins({ installationId, sessionId: binding.sessionId, starter });
    newcomer.list([carols.listed]);
    newcomer.startFrom(opened(b));
    expect(receive(newcomer, a)).toEqual({
      kind: 'refuse',
      why: 'its seq is below the last taken',
    });
  });

  it('refuses a clock that isn’t the join’s last plus its own structs', () => {
    const { carols, joins, first } = setup();
    receive(joins, first);
    carols.type((d) => d.text('body').insert(0, 'abc'));
    const batch = carols.send();
    const honest = opened(batch).clock;
    for (const clock of [honest - 1, honest + 1]) {
      carols.seq -= 1;
      const lie = carols.seal('update', opened(batch).content, clock);
      expect(receive(joins, lie)).toEqual({
        kind: 'refuse',
        why: 'its clock isn’t its join’s last plus its own structs',
      });
    }
    // A Saved notice adds nothing to the clock.
    carols.seq -= 1;
    expect(
      receive(joins, carols.seal('saved', new TextEncoder().encode('{}'), honest - 3)),
    ).toEqual({
      kind: 'take',
    });
  });

  it('refuses structs that don’t start where the join’s last clock ended', () => {
    const { carols, joins, first } = setup();
    receive(joins, first);
    const a = carols.type((d) => d.text('body').insert(0, 'abc')).send();
    receive(joins, a);
    // The same structs again, at the next seq.
    const again = carols.seal('update', opened(a).content, opened(a).clock + 3);
    expect(receive(joins, again)).toEqual({
      kind: 'refuse',
      why: 'its structs don’t start at its join’s last clock',
    });
  });

  it('refuses an update that adds structs under another join’s client', () => {
    const { carols, bobs, joins, first } = setup();
    receive(joins, first);
    const a = carols.type((d) => d.text('body').insert(0, 'Carol typed this')).send();
    // Bob relays Carol's structs as his own message.
    const forged = bobs.seal('update', opened(a).content, 0);
    expect(receive(joins, forged)).toEqual({
      kind: 'refuse',
      why: 'it adds structs under another client',
    });
    // Or adds his own and hers together.
    bobs.seq = 0;
    bobs.receive(first);
    bobs.receive(a);
    bobs.type((d) => d.text('body').insert(0, 'Bob '));
    const mine = opened(bobs.send()).content;
    bobs.seq = 0;
    const both = bobs.seal('update', Y.mergeUpdates([mine, opened(a).content]));
    expect(receive(joins, both)).toEqual({
      kind: 'refuse',
      why: 'it adds structs under another client',
    });
  });

  it('holds a change placed next to typing of a present join not taken yet', () => {
    const { carols, bobs, joins, first } = setup();
    receive(joins, first);
    bobs.receive(first);
    const a = carols.type((d) => d.text('body').insert(0, 'Carol ')).send();
    bobs.receive(a);
    const b = bobs.type((d) => d.text('body').insert(3, 'Bob')).send();
    const waiting = receive(joins, b);
    expect(waiting).toMatchObject({ kind: 'hold', reason: 'origin' });
    expect(receive(joins, a)).toEqual({ kind: 'take' });
    expect(receive(joins, b)).toEqual({ kind: 'take' });
  });

  it('refuses one placed next to typing nobody signed, once that join has gone', () => {
    const { carols, bobs, joins, first } = setup();
    receive(joins, first);
    bobs.receive(first);
    const a = carols.type((d) => d.text('body').insert(0, 'Carol ')).send();
    bobs.receive(a);
    const b = bobs.type((d) => d.text('body').insert(3, 'Bob')).send();
    joins.list([{ ...carols.listed, present: false }, bobs.listed]);
    expect(receive(joins, b)).toEqual({
      kind: 'refuse',
      why: 'it is placed next to typing nobody signed',
    });
  });

  it('refuses a deletion of text its join hasn’t signed, present or not', () => {
    const { carols, bobs, joins, first } = setup();
    receive(joins, first);
    bobs.receive(first);
    const a = carols.type((d) => d.text('body').insert(0, 'Carol ')).send();
    bobs.receive(a);
    const b = bobs.type((d) => d.text('body').delete(0, 3)).send();
    expect(receive(joins, b)).toEqual({
      kind: 'refuse',
      why: 'it deletes text nobody has signed as typed',
    });
    // Deleting the starting draft's text, which Carol signed, is a change like any other.
    bobs.seq = 0;
    const fresh = new Typist(bob, binding, JoinId.parse('bob-second'));
    joins.list([carols.listed, bobs.listed, fresh.listed]);
    fresh.receive(first);
    const c = fresh.type((d) => d.text('body').delete(0, 5)).send();
    expect(receive(joins, c)).toEqual({ kind: 'take' });
  });

  it('refuses a deletion under a client no join derives', () => {
    const { bobs, joins, first } = setup();
    receive(joins, first);
    const ghost = bobs.seal('update', update({ deletes: [{ client: 42, ranges: [[0, 1]] }] }), 0);
    expect(receive(joins, ghost)).toEqual({
      kind: 'refuse',
      why: 'it deletes text nobody has signed as typed',
    });
  });

  it('takes presence as it comes, outside the order', () => {
    const { bobs, joins } = setup();
    const presence = opened(bobs.seal('saved', new Uint8Array([1])));
    expect(joins.check({ ...presence, kind: 'presence', seq: 0 })).toEqual({ kind: 'take' });
    // Not once the join is refused, as folded in as gone.
    joins.refuse(bobs.listed, 'folded in as gone');
    expect(joins.check({ ...presence, kind: 'presence', seq: 0 })).toMatchObject({
      kind: 'refuse',
    });
  });
});

describe('the first snapshot', () => {
  it('must be the starter join’s first message', () => {
    const { carols, joins } = setup();
    carols.seq = 0;
    const update1 = carols.type((d) => d.text('body').insert(0, 'x')).send();
    expect(receive(joins, update1)).toEqual({
      kind: 'refuse',
      why: 'the starter’s first message isn’t the first snapshot',
    });
  });

  it('holds structs of its sender’s client alone', () => {
    const { carols, bobs, joins } = setup();
    bobs.type((d) => d.text('title').insert(0, 'Bob'));
    const doc = new Y.Doc();
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(carols.document.doc));
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(bobs.document.doc));
    carols.seq = 0;
    const content = new TextEncoder().encode(
      JSON.stringify({
        format: { major: 1, minor: 0 },
        revisionId: draftId,
        state: Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64url'),
      }),
    );
    const mixed = carols.seal('snapshot', content);
    expect(receive(joins, mixed)).toEqual({
      kind: 'refuse',
      why: 'the first snapshot holds structs of another client',
    });
  });
});

describe('a later snapshot', () => {
  it('comes only from a save’s own join that has sent no structs', () => {
    const { carols, joins, first } = setup();
    receive(joins, first);
    const later = (t: Typist, clock: number) =>
      t.seal('snapshot', stateContent(draftId, Y.encodeStateAsUpdate(carols.document.doc)), clock);
    // From Carol's main join.
    expect(receive(joins, later(carols, opened(first).clock))).toEqual({
      kind: 'refuse',
      why: 'a later snapshot isn’t from a save’s own join',
    });
    // From a save's own join of hers that has sent nothing.
    const poster = new Typist(carol, binding, JoinId.parse('carol-poster'));
    poster.parent = { senderId: carol.public.id, joinId: carols.joinId };
    joins.list([carols.listed, poster.listed]);
    expect(receive(joins, poster.seal('update', new Uint8Array([0, 0]), 0))).toEqual({
      kind: 'take',
    });
    expect(receive(joins, later(poster, 0))).toEqual({ kind: 'take' });
  });
});

describe('the list of joins', () => {
  it('refuses a save’s own join listed under another person’s join', () => {
    const { carols, bobs, joins } = setup();
    const saveJoin = {
      ...bobs.listed,
      joinId: JoinId.parse('bob-save'),
      parent: { senderId: carol.public.id, joinId: carols.joinId },
    };
    const orphan = {
      ...bobs.listed,
      joinId: JoinId.parse('bob-orphan'),
      parent: { senderId: bob.public.id, joinId: JoinId.parse('never') },
    };
    const own = {
      ...bobs.listed,
      joinId: JoinId.parse('bob-own'),
      parent: { senderId: bob.public.id, joinId: bobs.joinId },
    };
    joins.list([carols.listed, bobs.listed, saveJoin, orphan, own]);
    const from = (join: typeof own) => {
      const t = new Typist(bob, binding, join.joinId);
      return t.seal('update', new Uint8Array([0, 0]), 0);
    };
    expect(receive(joins, from(saveJoin))).toMatchObject({ kind: 'refuse' });
    expect(joins.clientOf(saveJoin)).toBeUndefined();
    // The join a save's own join belongs to is the server's to list.
    expect(receive(joins, from(orphan))).toEqual({ kind: 'take' });
    expect(receive(joins, from(own))).toEqual({ kind: 'take' });
  });

  it('keeps a join as first listed, whatever the server lists later', () => {
    const { carols, bobs, joins } = setup();
    joins.list([carols.listed, { ...bobs.listed, senderKeyVersion: 2 }]);
    expect(joins.listed(bobs.listed)).toBe(true);
    expect(joins.listed({ ...bobs.listed, senderKeyVersion: 2 })).toBe(false);
    // Left out of a later list, it stays listed, as gone.
    joins.list([carols.listed]);
    expect(joins.listed(bobs.listed)).toBe(true);
    expect(joins.joinOf(bobs.clientId)?.present).toBe(false);
  });

  it('refuses a join’s messages for good once its changes were folded in as gone', () => {
    const { carols, bobs, joins } = setup();
    joins.list([carols.listed, bobs.listed]);
    const typed = bobs.type((d) => d.text('title').insert(0, 'Bob')).send();
    expect(receive(joins, typed)).toEqual({ kind: 'take' });
    joins.refuse(bobs.listed, 'folded in as gone');
    expect(joins.clientOf(bobs.listed)).toBeUndefined();
    // What it signed still counts, so others may still delete or type next to it.
    expect(joins.signed(bobs.clientId)).toBe(3);
    expect(receive(joins, bobs.type((d) => d.text('title').insert(0, 'x')).send())).toMatchObject({
      kind: 'refuse',
    });
    // A second message it signed at a seq taken already is still equivocation.
    bobs.seq = 0;
    const twin = bobs.type((d) => d.text('title').insert(0, 'y')).send();
    expect(receive(joins, twin)).toMatchObject({ kind: 'equivocation' });
  });

  it('starts a newcomer’s order from each join’s latest kept message', () => {
    const { carols, joins, first } = setup();
    receive(joins, first);
    carols.type((d) => d.text('body').insert(0, 'a')).send();
    const kept = carols.type((d) => d.text('body').insert(0, 'b')).send();
    const next = carols.type((d) => d.text('body').insert(0, 'c')).send();
    const newcomer = new LiveJoins({ installationId, sessionId: binding.sessionId, starter });
    newcomer.list([carols.listed]);
    newcomer.startFrom(opened(kept));
    expect(newcomer.signed(carols.clientId)).toBe(opened(kept).clock);
    expect(receive(newcomer, next)).toEqual({ kind: 'take' });
    expect(() => newcomer.startFrom(opened(kept))).toThrow();
  });
});
