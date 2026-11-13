// A live session's messages (protocol section 5.10, **Messages**): their
// exact padding, the two domains that bind each one to its session record,
// and the refusals a receiver makes before it reads what a message holds.
import { describe, expect, it } from 'vite-plus/test';
import { canonical, generateIdentity, toBase64, utf8 } from '../src/index.ts';
import {
  JoinId,
  liveBinding,
  liveClientId,
  liveMessageAd,
  MAX_PRESENCE_CONTENT,
  openLiveMessage,
  pad,
  presenceContent,
  readPresence,
  readSaved,
  readSnapshot,
  sealLiveMessage,
  unpad,
  type LiveBinding,
  type LiveMessage,
} from '../src/live/index.ts';
import { sodium } from '../src/sodium.ts';
import { aeadEncrypt, hash, sealedBytes, sign } from '../src/index.ts';
import { app, bob, carol, installationId, open, start } from './support/live.ts';

const code = (expected: string) => expect.objectContaining({ code: expected });
const session = open(start(), app(bob));
const binding = liveBinding(session);
const joinId = JoinId.parse('carol-join');
const carols = app(carol);
const everyone = () => true;

const seal = (changes: Partial<Parameters<typeof sealLiveMessage>[0]> = {}) =>
  sealLiveMessage({
    sender: carol,
    binding,
    kind: 'update',
    joinId,
    seq: 1,
    clock: 3,
    content: new Uint8Array([0, 0]),
    ...changes,
  });

const receive = (message: unknown, at: LiveBinding = binding, listed = everyone) =>
  openLiveMessage({ binding: at, trust: carols.trust, listed, message });

describe('padding', () => {
  it('pads to 128-byte buckets, after the clock, with 0x80 and zeros', () => {
    expect(pad('update', 1, new Uint8Array(1))).toHaveLength(128);
    expect(pad('update', 1, new Uint8Array(119))).toHaveLength(128);
    expect(pad('update', 1, new Uint8Array(120))).toHaveLength(256);
    const padded = pad('saved', 258, new Uint8Array([7, 7]));
    expect([...padded.slice(0, 12)]).toEqual([0, 0, 0, 0, 0, 0, 1, 2, 7, 7, 0x80, 0]);
    expect(padded.slice(11).every((byte) => byte === 0)).toBe(true);
    expect(unpad('saved', padded)).toEqual({ clock: 258, content: new Uint8Array([7, 7]) });
  });

  it('pads a presence to exactly 512 bytes', () => {
    expect(pad('presence', 0, new Uint8Array(1))).toHaveLength(512);
    expect(pad('presence', 0, new Uint8Array(MAX_PRESENCE_CONTENT))).toHaveLength(512);
    expect(() => pad('presence', 0, new Uint8Array(MAX_PRESENCE_CONTENT + 1))).toThrow(
      code('malformed'),
    );
  });

  it('never pads nothing, or a clock that isn’t one', () => {
    expect(() => pad('update', 0, new Uint8Array())).toThrow(code('malformed'));
    expect(() => pad('update', -1, new Uint8Array(1))).toThrow(code('malformed'));
    expect(() => pad('update', 2 ** 53, new Uint8Array(1))).toThrow(code('malformed'));
  });

  it('refuses padding of any other length or form', () => {
    const good = pad('update', 1, new Uint8Array([5]));
    // An extra bucket of zeros.
    const longer = new Uint8Array(256);
    longer.set(good);
    expect(() => unpad('update', longer)).toThrow(code('malformed'));
    // No 0x80, or another byte where it goes.
    const noMark = good.slice();
    noMark[9] = 0;
    expect(() => unpad('update', noMark)).toThrow(code('malformed'));
    const otherMark = good.slice();
    otherMark[9] = 0x81;
    expect(() => unpad('update', otherMark)).toThrow(code('malformed'));
    // A 0x80 with no content before it.
    const empty = new Uint8Array(128);
    empty[8] = 0x80;
    expect(() => unpad('update', empty)).toThrow(code('malformed'));
    // A presence of fewer than 512 bytes.
    expect(() => unpad('presence', good)).toThrow(code('malformed'));
  });

  it('refuses a clock above 2^53 − 1', () => {
    const padded = pad('update', 0, new Uint8Array([5]));
    new DataView(padded.buffer).setBigUint64(0, 2n ** 53n);
    expect(() => unpad('update', padded)).toThrow(code('binding-mismatch'));
  });
});

describe('sealing and opening messages', () => {
  it('opens a message its sender sealed, with its clock and content', () => {
    const message = seal({ content: new Uint8Array([1, 2, 3]) });
    const opened = receive(message);
    expect(opened).toMatchObject({ kind: 'update', senderId: carol.public.id, joinId, seq: 1 });
    expect(opened.clock).toBe(3);
    expect(opened.content).toEqual(new Uint8Array([1, 2, 3]));
    expect(opened.payloadHash).toBe(hash(sealedBytes(message.sealed)));
  });

  it('refuses a message bound to another record, session, page or key', () => {
    const message = seal();
    const rebound: LiveBinding[] = [
      { ...binding, recordHash: hash(utf8('another record')) },
      { ...binding, sessionId: start().sessionId },
      { ...binding, pageId: 'another-page' as LiveBinding['pageId'] },
      { ...binding, installationId: 'another' as LiveBinding['installationId'] },
    ];
    for (const other of rebound)
      expect(() => receive(message, other)).toThrow(code('bad-signature'));
    const key = { ...binding, key: sodium.randombytes_buf(32) };
    expect(() => receive(message, key)).toThrow(code('decrypt-failed'));
  });

  it('refuses a ciphertext sealed under another record’s AD, though its signature is good', () => {
    // A starter who signed two records for one session: the AD binds the
    // record hash too, so the ciphertext opens under one record only.
    const header = {
      kind: 'update' as const,
      senderId: carol.public.id,
      senderKeyVersion: 1,
      joinId,
      seq: 1,
    };
    const other = { ...binding, recordHash: hash(utf8('second record')) };
    const sealed = aeadEncrypt({
      key: binding.key,
      plaintext: pad('update', 0, new Uint8Array([0, 0])),
      ad: liveMessageAd(other, header),
    });
    const payloadHash = hash(sealedBytes(sealed));
    const signed = canonical('live-message/v1', [
      binding.installationId,
      binding.spaceId,
      binding.pageId,
      binding.sessionId,
      binding.recordHash,
      'update',
      carol.public.id,
      1,
      joinId,
      1,
      payloadHash,
    ]);
    const message: LiveMessage = { ...header, sealed, signature: sign(carol, signed) };
    expect(() => receive(message)).toThrow(code('decrypt-failed'));
  });

  it('refuses a message whose header was changed after signing', () => {
    const message = seal();
    for (const changed of [
      { ...message, kind: 'saved' as const },
      { ...message, seq: 2 },
      { ...message, joinId: JoinId.parse('another-join') },
      { ...message, sealed: seal().sealed },
    ]) {
      expect(() => receive(changed)).toThrow(code('bad-signature'));
    }
  });

  it('refuses a join the server doesn’t list, an unpinned key, and an agent', () => {
    expect(() => receive(seal(), binding, () => false)).toThrow(code('binding-mismatch'));
    expect(() => receive({ ...seal(), senderKeyVersion: 2 })).toThrow(code('unknown-identity'));
    const agent = generateIdentity({ kind: 'agent', installationId, ownerId: carol.public.id });
    expect(() => seal({ sender: agent })).toThrow(code('malformed'));
    expect(() => receive({ ...seal(), senderId: agent.public.id })).toThrow(
      code('untrusted-sealer'),
    );
  });

  it('refuses a stored message with seq 0, and anything but the strict wire form', () => {
    expect(() => seal({ seq: 0 })).toThrow(code('malformed'));
    expect(receive(seal({ kind: 'presence', seq: 0, content: new Uint8Array([1]) })).seq).toBe(0);
    const zero = { ...seal(), seq: 0 };
    expect(() => receive(zero)).toThrow(code('malformed'));
    expect(() => receive({ ...seal(), extra: true })).toThrow(code('malformed'));
    expect(() => receive({ ...seal(), seq: 1.5 })).toThrow(code('malformed'));
  });

  it('refuses a message over its kind’s limit', () => {
    expect(() => seal({ content: new Uint8Array(512 * 1024) })).toThrow(code('malformed'));
    expect(() => seal({ kind: 'snapshot', content: new Uint8Array(1024 * 1024) })).not.toThrow();
  });
});

describe('Yjs client IDs (live-client/v1)', () => {
  const ids = {
    installationId,
    sessionId: binding.sessionId,
    senderId: carol.public.id,
    senderKeyVersion: 1,
    joinId,
  };

  it('are 53 bits of an 8-byte BLAKE2b, read big-endian', () => {
    const id = liveClientId(ids);
    expect(Number.isSafeInteger(id)).toBe(true);
    const digest = sodium.crypto_generichash(
      8,
      canonical('live-client/v1', [installationId, ids.sessionId, ids.senderId, 1, joinId]),
      null,
    );
    const expected = Number(BigInt(`0x${sodium.to_hex(digest)}`) & ((1n << 53n) - 1n));
    expect(id).toBe(expected);
    // Not a cut of a longer hash.
    const long = sodium.crypto_generichash(
      32,
      canonical('live-client/v1', [installationId, ids.sessionId, ids.senderId, 1, joinId]),
      null,
    );
    expect(sodium.to_hex(long).slice(0, 16)).not.toBe(sodium.to_hex(digest));
  });

  it('differ for every join, key version and session', () => {
    const id = liveClientId(ids);
    expect(liveClientId({ ...ids, joinId: JoinId.parse('other') })).not.toBe(id);
    expect(liveClientId({ ...ids, senderKeyVersion: 2 })).not.toBe(id);
    expect(liveClientId({ ...ids, senderId: bob.public.id })).not.toBe(id);
    expect(liveClientId({ ...ids, sessionId: start().sessionId })).not.toBe(id);
  });
});

describe('what messages hold', () => {
  const presence = {
    format: { major: 1 as const, minor: 0 },
    editor: 'source' as const,
    visible: true,
    publishing: false,
    saveFailing: null,
    cursor: null,
  };

  it('reads a presence, and only its saver fields from a newer major', () => {
    expect(readPresence(presenceContent(presence))).toEqual({
      visible: true,
      saveFailing: null,
      shown: presence,
    });
    const newer = utf8(
      JSON.stringify({ format: { major: 2, minor: 0 }, visible: true, saveFailing: 'storage' }),
    );
    expect(readPresence(newer)).toEqual({ visible: true, saveFailing: 'storage', shown: null });
  });

  it('counts a broken presence as not visible and not failing', () => {
    const broken = [
      utf8('{"visible": true'),
      utf8(JSON.stringify({ ...presence, visible: 'yes' })),
      utf8(JSON.stringify({ ...presence, saveFailing: 'Storage!' })),
      utf8(JSON.stringify({ ...presence, saveFailing: 'a'.repeat(65) })),
      new Uint8Array([0xef, 0xbb, 0xbf, ...utf8(JSON.stringify(presence))]),
    ];
    for (const content of broken) {
      expect(readPresence(content)).toEqual({ visible: false, saveFailing: null, shown: null });
    }
    // A cursor that breaks its type only stops it being shown.
    const cursor = readPresence(utf8(JSON.stringify({ ...presence, cursor: 'here' })));
    expect(cursor).toEqual({ visible: true, saveFailing: null, shown: null });
  });

  it('reads a snapshot or Saved notice, and says when its format is newer', () => {
    const state = new Uint8Array([0, 0]);
    const content = utf8(
      JSON.stringify({
        format: { major: 1, minor: 3 },
        revisionId: 'draft-2',
        state: toBase64(state),
        later: 1,
      }),
    );
    expect(readSnapshot(content)).toEqual({ kind: 'current', revisionId: 'draft-2', state });
    expect(readSaved(content)).toEqual({ kind: 'current', revisionId: 'draft-2', state });
    const newer = utf8(JSON.stringify({ format: { major: 2, minor: 0 } }));
    expect(readSnapshot(newer)).toEqual({ kind: 'newer-format', major: 2 });
    for (const bad of [
      utf8(
        JSON.stringify({ format: { major: 1, minor: 0 }, revisionId: 'draft-2', state: 'AA==' }),
      ),
      utf8(
        JSON.stringify({ format: { major: 1.0, minor: 0 }, revisionId: 'x', state: '' }).replace(
          '1,',
          '1.0,',
        ),
      ),
      utf8('{"format":{"major":1,"minor":0},"revisionId":"a","revisionId":"b","state":""}'),
    ]) {
      expect(() => readSaved(bad)).toThrow(code('malformed'));
    }
  });
});
