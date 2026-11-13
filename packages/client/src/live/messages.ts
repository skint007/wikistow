// A live session's messages (protocol section 5.10, **Messages**): padded,
// sealed under the session key with `live-message-payload/v1` as their AD,
// and signed over `live-message/v1`, both binding the session record's hash.
// Also the Yjs client ID each join writes under (`live-client/v1`).
import {
  IdentityId,
  LiveMessage,
  LivePresence,
  LiveSaved,
  LiveSnapshot,
  LIVE_LIMITS,
  type InstallationId,
  type JoinId,
  type LiveMessageKind,
  type LiveSessionId,
  type PageId,
  type SpaceId,
} from '@wikistow/contracts';
import { z } from 'zod';
import {
  aeadDecrypt,
  aeadEncrypt,
  canonical,
  fromBase64,
  hash,
  parseJson,
  parseWith,
  sealedBytes,
  toBase64,
  utf8,
} from '../encoding.ts';
import { CryptoError } from '../errors.ts';
import { isAgentId, sign, verifySignature, type PrivateIdentity } from '../identity.ts';
import { sodium } from '../sodium.ts';
import type { TrustStore } from '../trust.ts';

export { LiveMessage };

/** What every message of one session binds: where it is, and which record and key. */
export type LiveBinding = {
  installationId: InstallationId;
  spaceId: SpaceId;
  pageId: PageId;
  sessionId: LiveSessionId;
  /** BLAKE2b-256 of the session record's signed bytes (`liveRecordHash`). */
  recordHash: string;
  /** The session key, 32 bytes. Wiped when the app leaves the session or locks. */
  key: Uint8Array;
};

/** Who sent a message, from which join, and its place in that join's order. */
export type LiveHeader = {
  kind: LiveMessageKind;
  senderId: IdentityId;
  senderKeyVersion: number;
  joinId: JoinId;
  seq: number;
};

/** The kinds the server stores, numbered by `seq` without gaps; `presence` is relayed only. */
export const isStoredKind = (kind: LiveMessageKind): boolean => kind !== 'presence';

const BUCKET = 128;
const PRESENCE_SIZE = 512;
const CLOCK_BYTES = 8;
/** The most a presence's content may be: 512 bytes, less the clock and the `0x80`. */
export const MAX_PRESENCE_CONTENT = PRESENCE_SIZE - CLOCK_BYTES - 1;

/**
 * `clock ‖ content ‖ 0x80 ‖ zeros` (ISO/IEC 7816-4): 128 × ⌈(9 + content)
 * / 128⌉ bytes, and exactly 512 for a presence. Content is never empty.
 */
export function pad(kind: LiveMessageKind, clock: number, content: Uint8Array): Uint8Array {
  if (!Number.isSafeInteger(clock) || clock < 0) {
    throw new CryptoError('malformed', `${String(clock)} is not a clock`);
  }
  if (content.length === 0) throw new CryptoError('malformed', 'A message holds something');
  const size =
    kind === 'presence'
      ? PRESENCE_SIZE
      : BUCKET * Math.ceil((CLOCK_BYTES + 1 + content.length) / BUCKET);
  if (CLOCK_BYTES + 1 + content.length > size) {
    throw new CryptoError('malformed', `A presence holds at most ${MAX_PRESENCE_CONTENT} bytes`);
  }
  const padded = new Uint8Array(size);
  new DataView(padded.buffer).setBigUint64(0, BigInt(clock));
  padded.set(content, CLOCK_BYTES);
  padded[CLOCK_BYTES + content.length] = 0x80;
  return padded;
}

/**
 * The clock and content of a padded plaintext, or `malformed`: a length
 * other than `pad` would give, padding that isn't a `0x80` and zeros after
 * at least one byte of content, or a clock above 2^53 − 1 (`binding-mismatch`).
 */
export function unpad(
  kind: LiveMessageKind,
  padded: Uint8Array,
): { clock: number; content: Uint8Array } {
  let last = padded.length - 1;
  while (last >= 0 && padded[last] === 0) last--;
  if (last < CLOCK_BYTES + 1 || padded[last] !== 0x80) {
    throw new CryptoError('malformed', 'A message’s padding is not 0x80 and zeros after content');
  }
  const content = padded.slice(CLOCK_BYTES, last);
  const size =
    kind === 'presence'
      ? PRESENCE_SIZE
      : BUCKET * Math.ceil((CLOCK_BYTES + 1 + content.length) / BUCKET);
  if (padded.length !== size) {
    throw new CryptoError('malformed', 'A message is not padded to its size');
  }
  const clock = new DataView(padded.buffer, padded.byteOffset).getBigUint64(0);
  if (clock > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new CryptoError('binding-mismatch', 'A message’s clock is above 2^53 − 1');
  }
  return { clock: Number(clock), content };
}

const headerFields = (binding: LiveBinding, header: LiveHeader) => [
  binding.installationId,
  binding.spaceId,
  binding.pageId,
  binding.sessionId,
  binding.recordHash,
  header.kind,
  header.senderId,
  header.senderKeyVersion,
  header.joinId,
  header.seq,
];

/** A message's AEAD associated data (`live-message-payload/v1`). */
export const liveMessageAd = (binding: LiveBinding, header: LiveHeader) =>
  canonical('live-message-payload/v1', headerFields(binding, header));

/** The bytes a sender signs for a message (`live-message/v1`). */
export const liveMessageBytes = (binding: LiveBinding, header: LiveHeader, payloadHash: string) =>
  canonical('live-message/v1', [...headerFields(binding, header), payloadHash]);

/**
 * The Yjs client ID a join writes under (section 5.10, **`update`**):
 * BLAKE2b with an 8-byte output over `live-client/v1`, read big-endian,
 * keeping its low 53 bits. Not a cut of a longer hash.
 */
export function liveClientId({
  installationId,
  sessionId,
  senderId,
  senderKeyVersion,
  joinId,
}: {
  installationId: InstallationId;
  sessionId: LiveSessionId;
  senderId: IdentityId;
  senderKeyVersion: number;
  joinId: JoinId;
}): number {
  const digest = sodium.crypto_generichash(
    8,
    canonical('live-client/v1', [installationId, sessionId, senderId, senderKeyVersion, joinId]),
    null,
  );
  const value = new DataView(digest.buffer, digest.byteOffset).getBigUint64(0);
  return Number(value & ((1n << 53n) - 1n));
}

/**
 * Seal and sign one message as `sender` (section 5.10, **Messages**):
 * `content`, after its join's `clock`, padded and sealed under the session
 * key, then signed over the hash of the ciphertext. A message over its
 * kind's limit is refused (`malformed`) before anything is sent. A message
 * sent again after a lost answer is this one unchanged, never sealed afresh.
 */
export function sealLiveMessage({
  sender,
  binding,
  kind,
  joinId,
  seq,
  clock,
  content,
}: {
  sender: PrivateIdentity;
  binding: LiveBinding;
  kind: LiveMessageKind;
  joinId: JoinId;
  seq: number;
  clock: number;
  content: Uint8Array;
}): LiveMessage {
  if (isAgentId(sender.public.id)) {
    throw new CryptoError('malformed', 'Only people take part in a live session');
  }
  if (!Number.isSafeInteger(seq) || seq < (isStoredKind(kind) ? 1 : 0)) {
    throw new CryptoError('malformed', `${String(seq)} is not a ${kind}’s seq`);
  }
  const header: LiveHeader = {
    kind,
    senderId: sender.public.id,
    senderKeyVersion: sender.public.keyVersion,
    joinId,
    seq,
  };
  const sealed = aeadEncrypt({
    key: binding.key,
    plaintext: pad(kind, clock, content),
    ad: liveMessageAd(binding, header),
  });
  if (fromBase64(sealed.ciphertext).length > LIVE_LIMITS[kind]) {
    throw new CryptoError('malformed', `A ${kind} holds at most ${LIVE_LIMITS[kind]} bytes`);
  }
  const payloadHash = hash(sealedBytes(sealed));
  return {
    ...header,
    sealed,
    signature: sign(sender, liveMessageBytes(binding, header, payloadHash)),
  };
}

/** A message whose signature verified and that decrypted: only these count. */
export type OpenedLiveMessage = LiveHeader & {
  /** The hash of its ciphertext, which its signature covers; a repeat has the same one. */
  payloadHash: string;
  /** The clock sealed at the start of its plaintext. */
  clock: number;
  /** The plaintext after the clock: a Yjs update for an `update`, JSON otherwise. */
  content: Uint8Array;
};

/**
 * Verify and open one message as relayed (section 5.10): a strict wire
 * object, from a person, not an agent; from a join `listed` says the
 * server lists among the session's joins, past or present, at that key
 * version; whose sender's key is pinned (`trust.require`, section 8.4);
 * whose signature verifies (`bad-signature`); that decrypts under the AD
 * (`decrypt-failed`); and whose padding is exact (`malformed`). A stored
 * kind with `seq` 0 is refused. What it holds, and its place in its join's
 * order, are checked after (`LiveJoins`).
 */
export function openLiveMessage({
  binding,
  trust,
  listed,
  message: raw,
}: {
  binding: LiveBinding;
  trust: TrustStore;
  /** Whether the server lists this join, at this key version, among the session's. */
  listed: (header: Pick<LiveHeader, 'senderId' | 'senderKeyVersion' | 'joinId'>) => boolean;
  message: unknown;
}): OpenedLiveMessage {
  const message = parseWith(LiveMessage, raw, 'Live message');
  const { sealed, signature, ...header } = message;
  if (isAgentId(header.senderId)) {
    throw new CryptoError('untrusted-sealer', 'Agents don’t take part in live sessions');
  }
  if (isStoredKind(header.kind) && header.seq === 0) {
    throw new CryptoError('malformed', `A ${header.kind} with seq 0`);
  }
  if (!listed(header)) {
    throw new CryptoError('binding-mismatch', 'The server doesn’t list this message’s join');
  }
  const sender = trust.require(header.senderId, header.senderKeyVersion);
  const payloadHash = hash(sealedBytes(sealed));
  if (!verifySignature(sender, liveMessageBytes(binding, header, payloadHash), signature)) {
    throw new CryptoError('bad-signature', 'A live message’s signature is invalid');
  }
  const padded = aeadDecrypt({ key: binding.key, sealed, ad: liveMessageAd(binding, header) });
  return { ...header, payloadHash, ...unpad(header.kind, padded) };
}

const FORMAT = z.object({ format: z.looseObject({ major: z.number().int().positive() }) });

/** A `snapshot`'s or `saved`'s plaintext, read: its revision and state, or a newer major format. */
export type OpenedState =
  | { kind: 'current'; revisionId: LiveSnapshot['revisionId']; state: Uint8Array }
  | { kind: 'newer-format'; major: number };

function readStateContent(
  schema: typeof LiveSnapshot | typeof LiveSaved,
  content: Uint8Array,
  what: string,
): OpenedState {
  const json = parseJson(z.unknown(), content, what);
  const format = FORMAT.safeParse(json);
  if (!format.success) throw new CryptoError('malformed', `${what} has no format version`);
  if (format.data.format.major > 1)
    return { kind: 'newer-format', major: format.data.format.major };
  const parsed = parseWith(schema, json, what);
  return { kind: 'current', revisionId: parsed.revisionId, state: fromBase64(parsed.state) };
}

/**
 * A `snapshot`'s plaintext: the revision it was made at, and the whole
 * document as one Yjs update. One of a newer major format makes the app
 * say to update and edit as a writer outside the session.
 */
export const readSnapshot = (content: Uint8Array): OpenedState =>
  readStateContent(LiveSnapshot, content, 'Live snapshot');

/** A `saved`'s plaintext: the revision its sender saved, and the state it holds. */
export const readSaved = (content: Uint8Array): OpenedState =>
  readStateContent(LiveSaved, content, 'Saved notice');

/**
 * A presence as an app reads it (section 5.10, **`presence`**). `visible`
 * and `saveFailing` choose the saver, the same in every app: they are read
 * from a presence of any major format, and one whose plaintext doesn't
 * decode, or whose two fields break their types, counts as not visible and
 * not failing. `shown` is the rest, only from a presence of a format this
 * app reads, for what the page shows.
 */
export type ReadPresence = {
  visible: boolean;
  saveFailing: string | null;
  shown: LivePresence | null;
};

const NOT_VISIBLE: ReadPresence = { visible: false, saveFailing: null, shown: null };

const SaverFields = z.object({
  visible: z.boolean(),
  saveFailing: LivePresence.shape.saveFailing,
});

export function readPresence(content: Uint8Array): ReadPresence {
  let json: unknown;
  try {
    json = parseJson(z.unknown(), content, 'Presence');
  } catch {
    return NOT_VISIBLE;
  }
  const fields = SaverFields.safeParse(json);
  if (!fields.success) return NOT_VISIBLE;
  const shown = LivePresence.safeParse(json);
  return { ...fields.data, shown: shown.success ? (json as LivePresence) : null };
}

/** A presence's content, for `sealLiveMessage`. */
export const presenceContent = (presence: LivePresence): Uint8Array =>
  utf8(JSON.stringify(parseWith(LivePresence, presence, 'Presence')));

/** A `snapshot`'s or `saved`'s content, for `sealLiveMessage`. */
export const stateContent = (revisionId: string, state: Uint8Array): Uint8Array =>
  utf8(JSON.stringify({ format: { major: 1, minor: 0 }, revisionId, state: toBase64(state) }));
