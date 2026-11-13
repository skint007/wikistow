// The snapshot check (protocol section 5.10, **`snapshot`**): a newcomer
// builds its document only from a snapshot whose text equals the revision
// it names, which claims no more of anyone's typing than they signed, and
// which leaves nothing pending in Yjs.
import { describe, expect, it } from 'vite-plus/test';
import * as Y from 'yjs';
import { newPayload, RevisionId, utf8, type PagePayload } from '../src/index.ts';
import {
  firstSnapshot,
  JoinId,
  liveBinding,
  LiveJoins,
  openLiveMessage,
  openSnapshot,
  stateContent,
  withLive,
  type LiveMessage,
} from '../src/live/index.ts';
import {
  alice,
  app,
  bob,
  carol,
  draftId,
  everyoneTrusted,
  installationId,
  open,
  pageId,
  start,
  Typist,
} from './support/live.ts';

const code = (expected: string) => expect.objectContaining({ code: expected });
const refused = (why: RegExp) =>
  expect.objectContaining({ code: 'binding-mismatch', message: expect.stringMatching(why) });
const started = start();
const session = open(started, app(alice));
const binding = liveBinding(session);
const starter = { senderId: carol.public.id, joinId: started.joinId };
const draft = newPayload({ title: 'Lasagne', markdown: '## Method\n\nBrown the mince.' });
const opened = (message: LiveMessage) =>
  openLiveMessage({ binding, trust: everyoneTrusted, listed: () => true, message });

function begin(payload: PagePayload = draft) {
  const clientId = new Typist(carol, binding, started.joinId).clientId;
  const first = firstSnapshot({
    sender: carol,
    binding,
    joinId: started.joinId,
    clientId,
    revisionId: draftId,
    payload,
  });
  const carols = new Typist(carol, binding, started.joinId, first.document);
  carols.seq = 1;
  return { carols, first: first.message };
}

// Bob arrives: his app lists the joins and checks the snapshot against the
// revision it names.
function newcomer(listed: Typist[], kept: LiveMessage[] = []) {
  const bobs = new Typist(bob, binding, JoinId.parse('bob-new'));
  const joins = new LiveJoins({ installationId, sessionId: binding.sessionId, starter });
  joins.list([...listed.map((t) => t.listed), bobs.listed]);
  for (const message of kept) joins.startFrom(opened(message));
  return {
    joins,
    check: (
      message: LiveMessage,
      revision: { revisionId: RevisionId; payload: PagePayload } = {
        revisionId: draftId,
        payload: draft,
      },
    ) =>
      openSnapshot({
        message: opened(message),
        session,
        joins,
        revision: { ...revision, pageId, authorId: carol.public.id },
        clientId: bobs.clientId,
      }),
  };
}

describe('the first snapshot', () => {
  it('opens when its text equals the draft the session started from', () => {
    const { carols, first } = begin();
    const { document, provisional } = newcomer([carols]).check(first);
    expect(provisional).toBe(false);
    expect(document.payload(draft)).toMatchObject({ title: 'Lasagne', markdown: draft.markdown });
    expect(document.clientId).not.toBe(carols.clientId);
  });

  it('is compared with the draft repaired as a save repairs it', () => {
    const broken = newPayload({ title: 'Cut \ud83d', markdown: 'x' });
    const { carols, first } = begin(broken);
    expect(() =>
      newcomer([carols]).check(first, { revisionId: draftId, payload: broken }),
    ).not.toThrow();
  });

  it('refuses text other than the draft’s', () => {
    const { carols, first } = begin(newPayload({ title: 'Lasagne', markdown: 'Something else' }));
    expect(() => newcomer([carols]).check(first)).toThrow(refused(/text isn’t its revision’s/));
  });

  it('refuses one naming another draft than the record, or than the one opened', () => {
    const { carols } = begin();
    const other = RevisionId.parse('draft-0');
    carols.seq = 0;
    const content = stateContent(other, Y.encodeStateAsUpdate(carols.document.doc));
    const named = carols.seal('snapshot', content);
    expect(() => newcomer([carols]).check(named, { revisionId: other, payload: draft })).toThrow(
      refused(/another draft than the record/),
    );
    const { first } = begin();
    expect(() => newcomer([carols]).check(first, { revisionId: other, payload: draft })).toThrow(
      refused(/another revision than the one opened/),
    );
  });

  it('refuses structs of another client, or a clock its structs don’t end at', () => {
    const { carols } = begin();
    const doc = new Y.Doc();
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(carols.document.doc));
    const others = new Typist(bob, binding);
    others.type((d) => d.text('title').insert(0, '!'));
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(others.document.doc));
    carols.seq = 0;
    const mixed = carols.seal('snapshot', stateContent(draftId, Y.encodeStateAsUpdate(doc)));
    expect(() => newcomer([carols, others]).check(mixed)).toThrow(refused(/another client/));
    carols.seq = 0;
    const update = Y.encodeStateAsUpdate(carols.document.doc);
    const clock = Y.getState(carols.document.doc.store, carols.clientId);
    const lie = carols.seal('snapshot', stateContent(draftId, update), clock + 1);
    expect(() => newcomer([carols]).check(lie)).toThrow(refused(/don’t end at its clock/));
  });

  it('says to update the app for a newer major format', () => {
    const { carols } = begin();
    carols.seq = 0;
    const newer = carols.seal('snapshot', utf8(JSON.stringify({ format: { major: 2, minor: 0 } })));
    expect(() => newcomer([carols]).check(newer)).toThrow(code('unsupported-format'));
  });
});

describe('a later snapshot', () => {
  // Carol types, saves draft-2 with the state she saved, and posts a
  // snapshot of it from a join of her own made for that.
  function later({ claimed }: { claimed?: Uint8Array } = {}) {
    const { carols, first } = begin();
    const a = carols.type((d) => d.text('body').insert(0, 'First, ')).send();
    const b = carols.type((d) => d.text('body').delete(0, 2)).send();
    const revisionId = RevisionId.parse('draft-2');
    const saved = withLive(carols.document.payload(draft), {
      revision: revisionId,
      session: binding.sessionId,
      state: claimed ?? carols.document.stateBytes(),
      with: [carol.public.id],
    });
    const poster = new Typist(carol, binding, JoinId.parse('carol-snapshots'));
    poster.parent = { senderId: carol.public.id, joinId: started.joinId };
    const hello = poster.seal('update', new Uint8Array([0, 0]), 0);
    const snapshot = poster.seal(
      'snapshot',
      stateContent(revisionId, Y.encodeStateAsUpdate(carols.document.doc)),
      0,
    );
    return {
      carols,
      poster,
      first,
      a,
      b,
      hello,
      snapshot,
      revision: { revisionId, payload: saved },
    };
  }

  it('opens, as provisional, when it holds no more than each join signed', () => {
    const { carols, poster, b, hello, snapshot, revision } = later();
    const { document, provisional } = newcomer([carols, poster], [b, hello]).check(
      snapshot,
      revision,
    );
    expect(provisional).toBe(true);
    expect(document.content().body).toBe(carols.document.content().body);
  });

  it('refuses one claiming typing past what its join signed', () => {
    const { carols, poster, a, hello, snapshot, revision } = later();
    // Carol's typing ends past the clock of `a`, the latest message kept.
    carols.type((d) => d.text('body').insert(0, 'more'));
    const ahead = poster.seal(
      'snapshot',
      stateContent(revision.revisionId, Y.encodeStateAsUpdate(carols.document.doc)),
      0,
    );
    const { check } = newcomer([carols, poster], [a, hello]);
    expect(() => check(ahead, revision)).toThrow(refused(/typing nobody signed/));
    expect(() => newcomer([carols, poster], [hello]).check(snapshot, revision)).toThrow(
      refused(/nobody signed/),
    );
  });

  it('refuses one whose state isn’t its revision’s', () => {
    const { carols, poster, b, hello, snapshot, revision } = later({
      claimed: Y.encodeSnapshot(Y.emptySnapshot),
    });
    expect(() => newcomer([carols, poster], [b, hello]).check(snapshot, revision)).toThrow(
      refused(/state isn’t its revision’s/),
    );
  });

  it('refuses one whose revision isn’t a draft of the session', () => {
    const { carols, poster, b, hello, snapshot, revision } = later();
    const live = revision.payload.extensions['wikistow.live'] as Record<string, unknown>;
    const elsewhere = {
      ...revision,
      payload: {
        ...revision.payload,
        extensions: { 'wikistow.live': { ...live, session: 'other' } },
      },
    };
    expect(() => newcomer([carols, poster], [b, hello]).check(snapshot, elsewhere)).toThrow(
      refused(/isn’t a draft of the session/),
    );
    const copied = {
      ...revision,
      payload: {
        ...revision.payload,
        extensions: { 'wikistow.live': { ...live, revision: 'draft-1' } },
      },
    };
    expect(() => newcomer([carols, poster], [b, hello]).check(snapshot, copied)).toThrow(
      refused(/isn’t a draft of the session/),
    );
  });

  it('refuses one from a join that isn’t a save’s own, or that has typed', () => {
    const { carols, poster, b, hello, revision } = later();
    // Carol posts it from her main join, which typed.
    const main = carols.seal(
      'snapshot',
      stateContent(revision.revisionId, Y.encodeStateAsUpdate(carols.document.doc)),
      opened(b).clock,
    );
    const kept = newcomer([carols, poster], [b, hello]);
    expect(() => kept.check(main, revision)).toThrow(refused(/isn’t from a save’s own join/));
  });

  it('refuses one holding structs under its own join’s client', () => {
    const { carols, poster, b, hello, revision } = later();
    poster.type((d) => d.text('title').insert(0, '!'));
    const doc = new Y.Doc();
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(carols.document.doc));
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(poster.document.doc));
    const own = poster.seal(
      'snapshot',
      stateContent(revision.revisionId, Y.encodeStateAsUpdate(doc)),
      0,
    );
    expect(() => newcomer([carols, poster], [b, hello]).check(own, revision)).toThrow(
      refused(/own join’s client/),
    );
  });

  it('refuses one that leaves something pending in Yjs', () => {
    const { carols, poster, b, hello, revision } = later();
    // Everything but Carol's first two characters, which the rest hangs on.
    const all = Y.encodeStateAsUpdate(carols.document.doc);
    const missing = Y.diffUpdate(all, encodeVector(new Map([[carols.clientId, 2]])));
    const cut = poster.seal('snapshot', stateContent(revision.revisionId, missing), 0);
    expect(() => newcomer([carols, poster], [b, hello]).check(cut, revision)).toThrow(
      refused(/holds part of it back/),
    );
  });
});

// A state vector as Yjs encodes one: count, then client and clock pairs.
function encodeVector(vector: Map<number, number>): Uint8Array {
  const bytes: number[] = [];
  const write = (value: number) => {
    let rest = value;
    while (rest > 0x7f) {
      bytes.push(0x80 | (rest % 128));
      rest = Math.floor(rest / 128);
    }
    bytes.push(rest);
  };
  write(vector.size);
  for (const [client, clock] of vector) {
    write(client);
    write(clock);
  }
  return new Uint8Array(bytes);
}
