// Live sessions (protocol section 5.10, ADR 0015): the session record and
// its payload, the messages a session relays and what they hold once
// opened, and the two payload extensions a session's drafts carry
// (section 5.5). The record is a metadata record v2 with
// `subjectKind: "live"`, in a schema of its own as a comment's is, so no
// route that takes a name takes it.
import { z } from 'zod';
import { Base64, PositiveInt, Sealed } from './encoding.ts';
import { IdentityId, PageId, RevisionId } from './ids.ts';
import { LiveSubjectKind, MetadataRecordV2 } from './metadata.ts';

// The ID shape of section 3.2, as `ids.ts` has it. An ID starting with
// `agent-` is no session's or join's: only agents' identities take one.
const id = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,64}$/)
  .refine((value) => !value.startsWith('agent-'), 'Not a session or join ID');

/** A live session (section 5.10), made with `newId`, unique across the installation. */
export const LiveSessionId = id.brand<'LiveSessionId'>();
export type LiveSessionId = z.infer<typeof LiveSessionId>;

/** One join of a session: made with `newId` each time an app joins, or for a save's own join. */
export const JoinId = id.brand<'JoinId'>();
export type JoinId = z.infer<typeof JoinId>;

/** A format version, loose so a newer minor's fields survive. */
const Format = z.looseObject({
  major: z.number().int().positive(),
  minor: z.number().int().nonnegative(),
});

/** 32 bytes in their one canonical base64url form. */
const Bytes32 = z.string().regex(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/);

/**
 * An Ed25519 signature, 64 bytes in their one canonical base64url form, so
 * a message or record can't carry more than its sealed part says.
 */
const Signature = z.string().regex(/^[A-Za-z0-9_-]{85}[AQgw]$/);

/**
 * A session's record: a metadata record v2 (sections 5.4 and 5.7) with
 * `subjectKind: "live"`, `subjectId` the session ID and `basedOn: null`,
 * since a session record is never edited. There is no v1 session record.
 */
export const LiveRecord = z.strictObject({
  ...MetadataRecordV2.shape,
  subjectKind: LiveSubjectKind,
  subjectId: LiveSessionId,
  basedOn: z.null(),
});
export type LiveRecord = z.infer<typeof LiveRecord>;

export const SealedLiveRecord = z.strictObject({
  record: LiveRecord,
  signature: Signature,
  payload: Sealed,
});
export type SealedLiveRecord = z.infer<typeof SealedLiveRecord>;

/**
 * A session record's decrypted payload, session format 1.0: the page, the
 * draft the session started from, the starter's join, which sends the
 * first snapshot, and the session key. `sealedTo` lists the owners the
 * record is sealed to in the owner region, and is `null` in a share.
 * Loose, as section 5.5's payloads are.
 */
export const LiveSessionPayload = z.looseObject({
  format: Format.extend({ major: z.literal(1) }),
  pageId: PageId,
  revisionId: RevisionId,
  joinId: JoinId,
  key: Bytes32,
  sealedTo: z.array(IdentityId).nullable(),
  extensions: z.record(z.string(), z.json()),
});
export type LiveSessionPayload = z.infer<typeof LiveSessionPayload>;

export const LiveMessageKind = z.enum(['update', 'snapshot', 'presence', 'saved']);
export type LiveMessageKind = z.infer<typeof LiveMessageKind>;

/**
 * One message of a session, as the server relays and stores it: a strict
 * object, sealed under the session key and signed by its sender (section
 * 5.10, **Messages**). `seq` counts the join's stored messages (every kind
 * but `presence`) from 1; a presence carries the `seq` of the last stored
 * message before it, 0 if there is none.
 */
export const LiveMessage = z.strictObject({
  kind: LiveMessageKind,
  senderId: IdentityId,
  senderKeyVersion: PositiveInt,
  joinId: JoinId,
  seq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  sealed: Sealed,
  signature: Signature,
});
export type LiveMessage = z.infer<typeof LiveMessage>;

/** The most a message may hold, as its sealed ciphertext, decoded (section 5.10). */
export const LIVE_LIMITS = {
  /** An `update`'s ciphertext. */
  update: 512 * 1024,
  /** A `snapshot`'s, on its own route. */
  snapshot: 2 * 1024 * 1024,
  /** A `saved`'s. */
  saved: 512 * 1024,
  /** A presence pads to exactly 512 bytes, so its ciphertext is 528. */
  presence: 512 + 16,
} as const satisfies Record<LiveMessageKind, number>;

/** A reason a presence gives for its saves failing: 1 to 64 of `a` to `z` and `-`. */
export const SaveFailing = z.string().regex(/^[a-z-]{1,64}$/);

/**
 * A `presence`'s plaintext: which editor, whether the page is visible,
 * whether its app is publishing or its saves fail, and the cursor in `body`
 * as Yjs relative positions. Loose; every check but `visible` and
 * `saveFailing` affects only what is shown.
 */
export const LivePresence = z.looseObject({
  format: Format.extend({ major: z.literal(1) }),
  editor: z.enum(['source', 'visual']),
  visible: z.boolean(),
  publishing: z.boolean(),
  saveFailing: SaveFailing.nullable(),
  cursor: z.looseObject({ anchor: Base64, head: Base64 }).nullable(),
});
export type LivePresence = z.infer<typeof LivePresence>;

/**
 * A `snapshot`'s plaintext: the whole document as one Yjs update (v1),
 * made when its sender saved `revisionId`.
 */
export const LiveSnapshot = z.looseObject({
  format: Format.extend({ major: z.literal(1) }),
  revisionId: RevisionId,
  state: Base64,
});
export type LiveSnapshot = z.infer<typeof LiveSnapshot>;

/**
 * A `saved`'s plaintext: its sender saved `revisionId`, which holds the
 * document as of `state`, a Yjs snapshot (section 5.10, **States**). A
 * hint: the revision's own `wikistow.live` is what counts.
 */
export const LiveSaved = z.looseObject({
  format: Format.extend({ major: z.literal(1) }),
  revisionId: RevisionId,
  state: Base64,
});
export type LiveSaved = z.infer<typeof LiveSaved>;

/** The payload extension a live session's drafts carry (section 5.5). */
export const LIVE_NAMESPACE = 'wikistow.live';

/**
 * What a live session's draft holds (`wikistow.live`): its own revision ID,
 * the session, the state of the document it was written from, and who
 * edited it since the page's latest publication, on the saver's word. One
 * with a `format` above 1 is of a newer format.
 */
export const LiveExtension = z.looseObject({
  format: z.literal(1),
  revision: RevisionId,
  session: LiveSessionId,
  state: Base64,
  with: z.array(IdentityId),
});
export type LiveExtension = z.infer<typeof LiveExtension>;

/** Changes waiting for review, from drafts written outside a session (section 5.5). */
export const OVERLAPS_NAMESPACE = 'wikistow.overlaps';

/**
 * One draft from outside a session whose overlapping parts wait for review:
 * the draft, and each part that overlapped, by its place in that draft. A
 * part of a form `overlapPart` doesn't know is ignored, not refused.
 */
export const OverlapEntry = z.looseObject({
  revision: RevisionId,
  parts: z.array(z.string()).min(1),
});
export type OverlapEntry = z.infer<typeof OverlapEntry>;

export const OverlapsExtension = z.looseObject({
  format: z.literal(1),
  revisions: z.array(OverlapEntry),
});
export type OverlapsExtension = z.infer<typeof OverlapsExtension>;

const INDEX = '(?:0|[1-9][0-9]*)';
const PART = new RegExp(
  `^(?:body:(${INDEX})-(${INDEX})|title|frontmatter|banner|icon|property:(${INDEX})|data:(${INDEX}))$`,
);

/**
 * A part an overlap names, read: blocks `start` to `end` of the body, `end`
 * excluded and equal to `start` for a deletion; the title, the front
 * matter, the banner or the icon; the `index`th front-matter key; or the
 * `index`th extension namespace in code point order. `null` for any other
 * form, which is ignored.
 */
export type OverlapPart =
  | { kind: 'body'; start: number; end: number }
  | { kind: 'title' | 'frontmatter' | 'banner' | 'icon' }
  | { kind: 'property' | 'data'; index: number };

export function overlapPart(text: string): OverlapPart | null {
  const match = PART.exec(text);
  if (!match) return null;
  const [, start, end, property, data] = match;
  const number = (digits: string) => {
    const value = Number(digits);
    return Number.isSafeInteger(value) ? value : null;
  };
  if (start !== undefined && end !== undefined) {
    const [s, e] = [number(start), number(end)];
    return s !== null && e !== null && s <= e ? { kind: 'body', start: s, end: e } : null;
  }
  if (property !== undefined) {
    const index = number(property);
    return index === null ? null : { kind: 'property', index };
  }
  if (data !== undefined) {
    const index = number(data);
    return index === null ? null : { kind: 'data', index };
  }
  return { kind: text as 'title' | 'frontmatter' | 'banner' | 'icon' };
}
