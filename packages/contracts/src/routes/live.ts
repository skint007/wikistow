// Live sessions (protocol section 5.10, ADR 0015). New routes only:
// released apps parse existing answers strictly, so no answer gains a field.
// Every route answers `not-found` to an agent, and to anyone who can't
// edit the page now, before anything that shows whether a session exists.
// The server relays and keeps ciphertext; the session payload, the sealed
// content of messages and their extensions are the client's (`live`).
import { z } from 'zod';
import { PositiveInt, Timestamp } from '../records/encoding.ts';
import { IdentityId, PageId, RevisionId } from '../records/ids.ts';
import {
  JoinId,
  LIVE_LIMITS,
  LiveMessage,
  LiveSessionId,
  SealedLiveRecord,
} from '../records/live.ts';
import { MetadataEnvelopeV2 } from '../records/metadata.ts';
import { KeyWrap } from '../records/share.ts';
import type { RouteDef, StreamRouteDef } from '../route.ts';

/** Bytes a session record's sealed payload may hold, decoded, as a comment's may. */
export const MAX_RECORD_PAYLOAD_BYTES = 65_536;

/**
 * Bytes of sealed ciphertext, decoded, each kind of message may hold
 * (`payload-too-large`): a presence is always 512 bytes padded, so 528
 * sealed; an `update` and a `saved` at most 512 KiB; a `snapshot` at most
 * 2 MiB. Every stored kind pads to a multiple of 128 bytes, so its
 * ciphertext is 16 bytes more than one.
 */
export const PRESENCE_CIPHERTEXT_BYTES = LIVE_LIMITS.presence;
export const MAX_UPDATE_BYTES = LIVE_LIMITS.update;
export const MAX_SAVED_BYTES = LIVE_LIMITS.saved;
export const MAX_SNAPSHOT_BYTES = LIVE_LIMITS.snapshot;

/** The body limit of the routes that carry a snapshot: starting a session, and posting one. */
export const SNAPSHOT_BODY_BYTES = 4 * 1024 * 1024;

/** Stored messages a person may send in a minute, in bytes of ciphertext (`rate-limited`). */
export const STORED_BYTES_PER_MINUTE = 16 * 1024 * 1024;

/** Joins a person may have present in one session, further joins included (`rate-limited`). */
export const MAX_JOINS_PER_PERSON = 8;

/**
 * Joins one person may make in one session, and joins a session may have
 * in all, past ones included (`rate-limited`): every join is listed to
 * everyone, and its latest change is kept, so a session past them starts
 * again.
 */
export const MAX_JOINS_MADE_PER_PERSON = 64;
export const MAX_JOINS_PER_SESSION = 512;

/** Further joins one join may have present at a time (`rate-limited`). */
export const MAX_FURTHER_JOINS = 2;

/**
 * How long a join stays present after its stream breaks or after its last
 * message, presence included, whichever is sooner, and how long a fold
 * grant lasts unplaced while its revision is the draft head.
 */
export const JOIN_GRACE_MS = 30_000;

/** Messages one request may carry. */
export const MAX_MESSAGES = 64;

/** A message's place in its session, given by the server, from 1. */
export const Position = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

/**
 * A message in a session, as its sender signed it (section 5.10,
 * **Messages**), as `records/live.ts` has it, and the client's `live`
 * module seals it. The server checks its sender, join, kind and size,
 * never its signature or what it seals.
 */
export { LiveMessage };

/**
 * A stored message (`update`, `snapshot` or `saved`) with its position.
 * `covers` is what its sender named, unsigned: for a snapshot, the
 * position up to which it holds every stored message; for a `saved`, the
 * position up to which the saved document held them; null for an
 * `update`. `revisionId` is the draft a snapshot was made at, named in the
 * clear; null for the other kinds.
 */
export const StoredMessage = z.strictObject({
  position: Position,
  message: LiveMessage,
  covers: Position.nullable(),
  revisionId: RevisionId.nullable(),
});
export type StoredMessage = z.infer<typeof StoredMessage>;

/**
 * A join of the session, past or present, as the server lists it: its
 * person's identity and key version, its `joinId`, the order joins were
 * made in (from 1), the join a further join belongs to, and whether it is
 * still present. Only whether it is present ever changes.
 */
export const Join = z.strictObject({
  senderId: IdentityId,
  senderKeyVersion: PositiveInt,
  joinId: JoinId,
  order: PositiveInt,
  parent: JoinId.nullable(),
  present: z.boolean(),
});
export type Join = z.infer<typeof Join>;

/**
 * A fold grant (section 5.10, **Saving**): for an outsider's draft
 * (`subject` its revision ID), or for catching up from an ended session
 * (`subject` that session's ID), held by one join at a time. `position`
 * is its `update`'s once placed, or for a catch-up its `saved`'s.
 * `lapsed` once its join went, or once 30 s passed with neither the draft
 * head moved on nor its `update` placed; a catch-up's, once 10 minutes
 * passed unplaced.
 */
export const Grant = z.strictObject({
  subject: z.union([RevisionId, LiveSessionId]),
  holder: z.strictObject({ senderId: IdentityId, joinId: JoinId }),
  grantedAt: Timestamp,
  position: Position.nullable(),
  lapsed: z.boolean(),
});
export type Grant = z.infer<typeof Grant>;

/** Why a session ended: the page's access changed, or a participant ended it. */
export const EndReason = z.enum(['access', 'ended']);
export type EndReason = z.infer<typeof EndReason>;

/**
 * A session as served to one person who can edit its page: its record,
 * with the wrap, or their own envelopes, which may be none; its first
 * snapshot; its latest later snapshot, if any; each join's latest kept
 * `update` or `saved` at or before the position that snapshot covers;
 * and the stored messages after it, up to `position`, oldest first. One
 * fetch serves about 8 MiB of messages, its sessions together. When
 * `complete` is false there are more, which the stream serves from
 * `position`, with `kept` set to what the snapshot covers while
 * `position` is below it (the rest of `latest`). Snapshots come whole,
 * beyond the 8 MiB. `grants` are those given since the
 * latest snapshot, and the one for the current draft head.
 */
export const ServedSession = z.strictObject({
  sessionId: LiveSessionId,
  record: SealedLiveRecord,
  wrap: KeyWrap.nullable(),
  envelopes: z.array(MetadataEnvelopeV2),
  revisionId: RevisionId,
  startedAt: Timestamp,
  ended: EndReason.nullable(),
  firstSnapshot: StoredMessage,
  snapshot: StoredMessage.nullable(),
  latest: z.array(StoredMessage),
  messages: z.array(StoredMessage),
  position: Position,
  complete: z.boolean(),
  joins: z.array(Join),
  grants: z.array(Grant),
});
export type ServedSession = z.infer<typeof ServedSession>;

const PageParams = z.object({ pageId: PageId });
const SessionParams = z.object({ sessionId: LiveSessionId });
const Ok = z.strictObject({ ok: z.literal(true) });

/**
 * The page's open session, and beside it an ended one kept with unsaved
 * changes, once every join of it has left; either may be null. The page's
 * draft head is the one the stream's lines carry.
 */
export const getLive = {
  method: 'GET',
  path: '/api/pages/:pageId/live',
  params: PageParams,
  response: z.strictObject({
    open: ServedSession.nullable(),
    ended: ServedSession.nullable(),
    draftHead: RevisionId.nullable(),
  }),
} as const satisfies RouteDef;

/**
 * Start a session on the page (section 5.10, **Writing the record**), with
 * its first snapshot, the message with `seq` 1 of the join `joinId` the
 * payload names, which the server makes, present for 30 s until its stream
 * opens. Under the locks of a draft save: the record is a v2 record of
 * kind `live` for `sessionId`, signed by the caller over its payload
 * (`bad-signature`, `binding-mismatch`; another identity's, `forbidden`); the key material is the page's
 * region's at its key version (`region-mismatch`, `key-version`); the
 * permission version is current (`permission-version`); `revisionId` is
 * the draft head (`stale-head`, with the heads); the session and version
 * IDs are new, and the page has no open session (`duplicate`). A start
 * sent again byte for byte after a lost answer is answered as before;
 * any other start is made afresh, with a new session ID and key.
 */
export const startLive = {
  method: 'POST',
  path: '/api/pages/:pageId/live',
  params: PageParams,
  body: z.object({
    sessionId: LiveSessionId,
    joinId: JoinId,
    revisionId: RevisionId,
    metadata: SealedLiveRecord,
    wrap: KeyWrap.nullable(),
    envelopes: z.array(MetadataEnvelopeV2).max(100),
    snapshot: LiveMessage,
    /** The page's permission version. */
    permissionVersion: z.number().int(),
  }),
  response: z.strictObject({ sessionId: LiveSessionId, position: Position }),
  status: 201,
} as const satisfies RouteDef;

/**
 * A line of the session's stream. Every line carries the page's draft
 * head. The first is `joins`, the session's joins past and present, sent
 * again whenever one comes or goes; then each stored message after
 * `after`, in order, and from then on each as it is stored; each presence
 * as it is relayed, and on opening each present join's latest; each fold
 * grant as it is given, placed or lapses; `draftHead` alone when only it
 * moved; and last `ended`, after which the stream closes.
 */
export const StreamLine = z.union([
  z.strictObject({ joins: z.array(Join), draftHead: RevisionId.nullable() }),
  z.strictObject({ message: StoredMessage, draftHead: RevisionId.nullable() }),
  z.strictObject({ presence: LiveMessage, draftHead: RevisionId.nullable() }),
  z.strictObject({ grant: Grant, draftHead: RevisionId.nullable() }),
  z.strictObject({ draftHead: RevisionId.nullable() }),
  z.strictObject({
    ended: z.union([EndReason, z.literal('deleted')]),
    draftHead: RevisionId.nullable(),
  }),
]);
export type StreamLine = z.infer<typeof StreamLine>;

/**
 * The session's stream, in NDJSON. Opening it joins the session as
 * `joinId`: a new join, or one of the caller's still present, which it
 * resumes; a join of the caller's that has gone, or a further join, is
 * `not-found`, a new join past the person's storage `storage-full`, and a
 * person's ninth present join `rate-limited`, as is a
 * join past `MAX_JOINS_MADE_PER_PERSON` or `MAX_JOINS_PER_SESSION`, or a
 * person's stream past the server's limit of open streams. `after` is
 * the position the app holds; below what the latest snapshot covers, which
 * may have deleted messages after it, it is `stale-head`, and the app
 * joins again as a newcomer.
 * `kept`, what the snapshot its fetch was built on covers, lets a
 * newcomer start below it, to fetch the rest of what that snapshot kept
 * (`ServedSession.complete`), while that snapshot is the latest
 * (`stale-head` otherwise). The first lines are the joins, each present
 * join's latest presence and the grants a newcomer is served. A stream
 * that a newer snapshot leaves short of messages closes, as one too slow
 * to read does; the app opens it again from where it got. A stream opened
 * from another site, or as a navigation (`Accept` naming `text/html`), is
 * `forbidden`. An ended session's stream makes no join: it sends what the
 * session keeps after `after`, as a fetch cut short leaves to it, then
 * `ended`, and closes.
 */
export const stream = {
  method: 'GET',
  path: '/api/live/:sessionId/stream',
  params: SessionParams,
  query: z.object({
    after: z.coerce.number().pipe(Position),
    joinId: JoinId,
    kept: z.coerce.number().pipe(Position).optional(),
  }),
  event: StreamLine,
} as const satisfies StreamRouteDef;

/**
 * One message a request sends, with `covers` for a `saved`, the position
 * up to which the saved document held every stored message (unsigned),
 * and for no other kind.
 */
export const Outgoing = z.strictObject({ message: LiveMessage, covers: Position.optional() });

/**
 * Send messages from the caller's join `joinId`, in `seq` order: stored
 * kinds numbered from one more than the join's last stored, at most one
 * presence, with the `seq` of the last stored before it (`invalid-request`). A
 * stored message sent again unchanged after a lost answer is taken as
 * stored; another at its `seq` is `duplicate`. `parent` makes `joinId` a
 * further join of the caller's present join `parent` (at most two present,
 * `rate-limited`), which keeps no presence and goes when `parent` goes,
 * or 30 s after its last request: an app keeps one through a long save
 * with a request from it with no messages. Any request from a join keeps
 * it present, in an open session. A join that has gone is `not-found`;
 * the app joins afresh. A starter's
 * join is present for 30 s until its stream opens, whatever it sends.
 * Snapshots go to `postSnapshot`. Over the limits: `payload-too-large`,
 * `rate-limited` (16 MiB of stored messages a minute per person) or
 * `storage-full`. An ended session takes only `saved` (`forbidden`).
 *
 * `fold`, from a main join, asks for the fold grant of the outsider's
 * revision `fold`, which must be the draft head (`stale-head`), for that
 * join. From a further join of the grant's holder it places the grant:
 * the request's one `update` is the grant's; from any other further join
 * it is `forbidden`. In an
 * ended session every join of which has left, `fold` is the session's own
 * ID and asks to catch up from it: `joinId` becomes the caller's join for
 * that, whose `saved` then lets the server delete the session; a `saved`
 * from a catch-up join that doesn't hold the grant is `forbidden`. A
 * catch-up's grant lasts 10 minutes unplaced, and a catch-up join stays
 * present 10 minutes after its last request.
 * `grant` is that revision's grant as it stands, someone else's included.
 */
export const sendMessages = {
  method: 'POST',
  path: '/api/live/:sessionId/messages',
  params: SessionParams,
  body: z.object({
    joinId: JoinId,
    messages: z.array(Outgoing).max(MAX_MESSAGES),
    parent: JoinId.optional(),
    fold: z.union([RevisionId, LiveSessionId]).optional(),
  }),
  response: z.strictObject({
    /**
     * Each message's position, in order; null for a presence, and for a
     * message sent again whose first sending a snapshot has since covered.
     */
    positions: z.array(Position.nullable()),
    grant: Grant.nullable(),
  }),
} as const satisfies RouteDef;

/**
 * Post a later snapshot (section 5.10), from the caller's join `joinId`,
 * a further join for it as `sendMessages` makes one, naming in the clear
 * the draft of the page it was made at, which the server then keeps.
 * `covers` must not be below the latest kept snapshot's (`stale-head`),
 * nor past the last position. The server then deletes the stored
 * messages it covers but the first snapshot and each join's latest
 * `update` or `saved`, and older later snapshots.
 */
export const postSnapshot = {
  method: 'POST',
  path: '/api/live/:sessionId/snapshots',
  params: SessionParams,
  body: z.object({
    joinId: JoinId,
    parent: JoinId.optional(),
    message: LiveMessage,
    covers: Position,
    revisionId: RevisionId,
  }),
  response: z.strictObject({ position: Position }),
  status: 201,
} as const satisfies RouteDef;

/** The caller's join `joinId` leaves at once, with its further joins. */
export const leave = {
  method: 'POST',
  path: '/api/live/:sessionId/leave',
  params: SessionParams,
  body: z.object({ joinId: JoinId }),
  response: Ok,
} as const satisfies RouteDef;

/**
 * End the session (section 5.10, **Ending**), for anyone who can edit the
 * page: the saver to start again, or an app that can't take part. It
 * takes only `saved` from then on. Ending an ended session changes nothing.
 */
export const end = {
  method: 'POST',
  path: '/api/live/:sessionId/end',
  params: SessionParams,
  response: Ok,
} as const satisfies RouteDef;
