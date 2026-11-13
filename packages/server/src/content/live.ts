// Live sessions on pages (protocol section 5.10, ADR 0015). The server
// can't open a session's record or its messages, so it checks what it can
// see: who sends, at which key version, from which join, in which order,
// of which kind and size, and that only people who can edit the page now
// take part. It keeps the stored messages, numbered by position, until the
// session goes, and ends a page's open session in the transaction that
// moves its permission version (the `nodes_live_end` trigger).
import {
  KeyWrap,
  liveRoutes,
  MetadataEnvelopeV2,
  SealedLiveRecord,
  type PublicIdentity,
} from '@wikistow/contracts';
import {
  hash,
  metadataEnvelopeV2Bytes,
  metadataRecordV2Bytes,
  sealedBytes,
  verifySignature,
} from '@wikistow/client';
import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import type { Database } from '../db/client.ts';
import { LIVE_ID_BYTES, LIVE_JOIN_BYTES, LIVE_MESSAGE_BYTES } from '../db/schema/live.ts';
import {
  appRateLimits,
  commentVersions,
  liveEnvelopes,
  liveGrants,
  liveJoins,
  liveMessages,
  liveSessionIds,
  liveSessions,
  liveWraps,
  metadataRevisions,
  pageHeads,
  revisions,
  shares,
  spaceOwners,
} from '../db/schema/index.ts';
import { readSettings } from '../settings.ts';
import { canEdit, lockShare, lockSpace, lockSpaceOf, readSnapshot, shareAt } from './access.ts';
import { ContentError } from './errors.ts';
import { requireCaller, type Actor, type Caller } from './identities.ts';
import { checkKeyMaterial } from './key-material.ts';
import { requirePage, requirePageAccess } from './pages.ts';
import { charge, chargeLive, lockQuota } from './quota.ts';
import { readStored, type ReportUnreadable } from './stored.ts';

type LiveMessage = liveRoutes.LiveMessage;
type SessionRow = typeof liveSessions.$inferSelect;
type JoinRow = typeof liveJoins.$inferSelect;
type MessageRow = typeof liveMessages.$inferSelect;
type GrantRow = typeof liveGrants.$inferSelect;
type Heads = typeof pageHeads.$inferSelect;

const GRACE_MS = liveRoutes.JOIN_GRACE_MS;
/** How long an open session nobody is in waits before it goes, if everything in it is saved. */
const EMPTY_MS = 60_000;
/**
 * How long a catch-up's grant lasts unplaced (section 5.10, **Ending**):
 * long enough to fetch and fold a large session, and no longer, so one
 * editor can't keep everyone else from catching up.
 */
const CATCH_UP_GRANT_MS = 10 * 60_000;

/** What a stored message of `size` bytes of ciphertext takes, as `live_usage` counts it. */
const storedSize = (size: number) => Math.ceil((size * 4) / 3) + LIVE_MESSAGE_BYTES;

/** Bytes of a base64url text, decoded (unpadded: three bytes in every four characters). */
const decodedLength = (text: string) => Math.floor((text.length * 3) / 4);

// Stable comparison for replays: jsonb doesn't keep key order.
const stable = (value: unknown): string =>
  JSON.stringify(value, (_key, v: unknown) =>
    v !== null && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );

async function dbNow(tx: Database): Promise<Date> {
  const [row] = await tx.execute<{ now: Date | string }>(sql`select now() as now`);
  return new Date(row?.now ?? Date.now());
}

// --- Joins -----------------------------------------------------------------

/** Whether a join, taken alone, is present at `now` (section 5.10, **Serving and relaying**). */
function presentAlone(join: JoinRow, now: Date) {
  const at = now.getTime();
  if (join.leftAt !== null) return false;
  // A catch-up join opens no stream, and lasts as long as its grant may.
  const grace = join.catchUp ? CATCH_UP_GRANT_MS : GRACE_MS;
  if (join.lastMessageAt.getTime() + grace <= at) return false;
  return join.streamBrokeAt === null || join.streamBrokeAt.getTime() + GRACE_MS > at;
}

const joinKey = (identityId: string, joinId: string) => `${identityId} ${joinId}`;

/** The keys of the present joins: a further join only while the join it belongs to is. */
function presentSet(joins: readonly JoinRow[], now: Date) {
  const alone = new Set(
    joins.filter((j) => presentAlone(j, now)).map((j) => joinKey(j.identityId, j.joinId)),
  );
  return new Set(
    [...alone].filter((key) => {
      const join = joins.find((j) => joinKey(j.identityId, j.joinId) === key);
      return (
        !join ||
        join.parentJoinId === null ||
        alone.has(joinKey(join.identityId, join.parentJoinId))
      );
    }),
  );
}

/** When a join went, or will go if nothing else comes from it. */
function goneAt(join: JoinRow) {
  const times = [join.lastMessageAt.getTime() + (join.catchUp ? CATCH_UP_GRANT_MS : GRACE_MS)];
  if (join.leftAt) times.push(join.leftAt.getTime());
  if (join.streamBrokeAt) times.push(join.streamBrokeAt.getTime() + GRACE_MS);
  return Math.min(...times);
}

const joinsOf = (tx: Database, sessionId: string) =>
  tx
    .select()
    .from(liveJoins)
    .where(eq(liveJoins.sessionId, sessionId))
    .orderBy(asc(liveJoins.ordinal));

function servedJoins(joins: readonly JoinRow[], now: Date): liveRoutes.Join[] {
  const present = presentSet(joins, now);
  return joins.map((j) => ({
    senderId: j.identityId as liveRoutes.Join['senderId'],
    senderKeyVersion: j.keyVersion,
    joinId: j.joinId as liveRoutes.Join['joinId'],
    order: j.ordinal,
    parent: j.parentJoinId as liveRoutes.Join['parent'],
    present: present.has(joinKey(j.identityId, j.joinId)),
  }));
}

// --- Access ----------------------------------------------------------------

/**
 * The session `sessionId` and its page, for a person who can edit the page
 * now, or `not-found` for anyone else, an agent included, before anything
 * that shows whether a session exists. With `lock`, under the locks that
 * the transaction that moves the page's permission version takes too: the
 * space's row shared, the page's row FOR SHARE, which waits for (or holds
 * up) a change of access, and the session's row FOR UPDATE, so its
 * positions are given one at a time. Access is checked once the page is
 * held, so it is the access that change leaves.
 */
async function sessionFor(
  tx: Database,
  actor: Actor,
  sessionId: string,
  { lock }: { lock: boolean },
) {
  const caller = await requireCaller(tx, actor);
  if (caller.personId !== null) throw new ContentError('not-found');
  const [found] = await tx
    .select({ pageId: liveSessions.pageId, spaceId: liveSessions.spaceId })
    .from(liveSessions)
    .where(eq(liveSessions.id, sessionId));
  if (!found) throw new ContentError('not-found');
  if (lock) await lockSpace(tx, found.spaceId);
  const page = await requirePage(tx, found.pageId, { lock });
  const access = await requirePageAccess(tx, caller, page);
  if (!canEdit(access)) throw new ContentError('not-found');
  const query = tx.select().from(liveSessions).where(eq(liveSessions.id, sessionId));
  const [session] = lock ? await query.for('update') : await query;
  if (!session || session.pageId !== page.id) throw new ContentError('not-found');
  return { caller, page, access, session };
}

/** The page's caller who can edit it now, or `not-found`, an agent included. */
async function editorOfPage(tx: Database, actor: Actor, pageId: string) {
  const caller = await requireCaller(tx, actor);
  if (caller.personId !== null) throw new ContentError('not-found');
  const page = await requirePage(tx, pageId);
  const access = await requirePageAccess(tx, caller, page);
  if (!canEdit(access)) throw new ContentError('not-found');
  return { caller, page, access };
}

/**
 * Before a large body is read (a session's start, a snapshot): the caller
 * can edit the page, of the session `sessionId` when it names one.
 */
export async function checkLiveEditor(
  db: Database,
  actor: Actor,
  target: { pageId: string } | { sessionId: string },
) {
  if ('pageId' in target) {
    await editorOfPage(db, actor, target.pageId);
    return;
  }
  await sessionFor(db, actor, target.sessionId, { lock: false });
}

async function headsOf(tx: Database, pageId: string): Promise<Heads> {
  const [heads] = await tx.select().from(pageHeads).where(eq(pageHeads.pageId, pageId));
  if (!heads) throw new ContentError('not-found');
  return heads;
}

// --- Version IDs -----------------------------------------------------------

/**
 * Whether a session's record took `versionId`, kept or not, for names' and
 * comments' versions to refuse it.
 */
export async function isLiveVersion(tx: Database, versionId: string) {
  const [taken] = await tx
    .select({ id: liveSessionIds.id })
    .from(liveSessionIds)
    .where(eq(liveSessionIds.versionId, versionId));
  return taken !== undefined;
}

/** A session record's version ID is new in the one set of metadata, comment and session versions. */
async function requireNewVersionId(tx: Database, versionId: string) {
  const [name] = await tx
    .select({ id: metadataRevisions.id })
    .from(metadataRevisions)
    .where(eq(metadataRevisions.id, versionId));
  const [comment] = await tx
    .select({ id: commentVersions.id })
    .from(commentVersions)
    .where(eq(commentVersions.id, versionId));
  if (name || comment || (await isLiveVersion(tx, versionId))) {
    throw new ContentError('duplicate', 'That version ID is taken');
  }
}

// --- Messages --------------------------------------------------------------

/**
 * What the server checks of a message: its sender is the caller at its
 * current key version, its join the request's, and its size that of its
 * kind, padded as section 5.10 pads (a presence always 512 bytes, any
 * other kind a multiple of 128).
 */
function checkMessage(message: LiveMessage, caller: Caller, joinId: string) {
  if (
    message.senderId !== caller.identity.id ||
    message.senderKeyVersion !== caller.identity.keyVersion
  ) {
    throw new ContentError(
      'forbidden',
      'Messages must be sent by your own identity, at its current key',
    );
  }
  if (message.joinId !== joinId) {
    throw new ContentError('binding-mismatch', 'The message is from another join');
  }
  const bytes = decodedLength(message.sealed.ciphertext);
  if (message.kind === 'presence') {
    if (bytes !== liveRoutes.PRESENCE_CIPHERTEXT_BYTES) {
      throw new ContentError('invalid-request', 'A presence is padded to 512 bytes');
    }
    return bytes;
  }
  const limit =
    message.kind === 'snapshot'
      ? liveRoutes.MAX_SNAPSHOT_BYTES
      : message.kind === 'saved'
        ? liveRoutes.MAX_SAVED_BYTES
        : liveRoutes.MAX_UPDATE_BYTES;
  if (bytes > limit) throw new ContentError('too-large', `This ${message.kind} is too large`);
  if (bytes < 144 || (bytes - 16) % 128 !== 0) {
    throw new ContentError('invalid-request', 'A message is padded to a multiple of 128 bytes');
  }
  if (message.seq < 1) throw new ContentError('invalid-request', 'Stored messages count from 1');
  return bytes;
}

/**
 * Count `bytes` of stored messages against the person's minute
 * (`rate-limited`), in the transaction that stores them, so a refused
 * write counts nothing.
 */
async function spendStoredBytes(
  tx: Database,
  accountId: string,
  bytes: number,
  limit: number | null,
  { lockOnly = false }: { lockOnly?: boolean } = {},
) {
  if (limit === null || (bytes === 0 && !lockOnly)) return;
  const now = Date.now();
  const windowMs = 60_000;
  const key = `live-stored account:${accountId}`;
  const expired = sql`${appRateLimits.windowStart} <= ${now - windowMs}`;
  const [row] = await tx
    .insert(appRateLimits)
    .values({ key, windowStart: now, count: bytes })
    .onConflictDoUpdate({
      target: appRateLimits.key,
      set: {
        windowStart: sql`case when ${expired} then ${now} else ${appRateLimits.windowStart} end`,
        count: sql`case when ${expired} then ${bytes} else ${appRateLimits.count} + ${bytes} end`,
      },
    })
    .returning();
  if (!row || row.count > limit) {
    throw new ContentError('busy', 'Too much typing stored this minute; try again shortly');
  }
}

/**
 * Take, before any live row is written, the locks a charge takes, in the
 * order `startLive` takes them: the person's minute, then their quota. Rows
 * written after lock their `live_usage` row for the session, last, so one
 * person's transactions never wait on each other in a ring.
 */
async function lockCharges(tx: Database, accountId: string, limit: number | null) {
  if (limit !== null) await spendStoredBytes(tx, accountId, 0, limit, { lockOnly: true });
  await lockQuota(tx, accountId);
}

/**
 * Charge stored messages to their sender's minute (`rate-limited`) and
 * storage (`storage-full`). With `stored`, the rows are in already, so
 * the storage they take counts once, as `usedBytes` sums it.
 */
async function chargeStored(
  tx: Database,
  caller: Caller,
  bytes: number,
  limits: { storageBytes: number; storedBytesPerMinute: number | null },
  { stored }: { stored: boolean },
) {
  if (bytes === 0) return;
  await spendStoredBytes(tx, caller.accountId, bytes, limits.storedBytesPerMinute);
  await chargeLive(tx, caller.accountId, stored ? 0 : bytes, limits.storageBytes);
}

function servedMessage(row: MessageRow, report: ReportUnreadable) {
  return readStored(
    liveRoutes.StoredMessage,
    {
      position: row.position,
      message: row.message,
      covers: row.covers,
      revisionId: row.revisionId,
    },
    { table: 'live_messages', id: `${row.sessionId} ${row.position}` },
    report,
  );
}

/** Reports nothing: rows this module wrote passed the same schemas. */
const ignore: ReportUnreadable = () => {};

// --- Grants ----------------------------------------------------------------

/**
 * Whether a grant has lapsed (section 5.10, **Saving**): its join went,
 * or, unplaced, 30 s passed while its revision is the draft head. A
 * catch-up's grant lapses with its join, or unplaced after 10 minutes.
 */
function lapsed(
  grant: GrantRow,
  { present, now, heads }: { present: Set<string>; now: Date; heads: Heads },
) {
  if (grant.lapsedAt !== null) return true;
  if (grant.position !== null) return false;
  if (!present.has(joinKey(grant.identityId, grant.joinId))) return true;
  if (grant.catchUp) {
    return grant.grantedAt.getTime() + CATCH_UP_GRANT_MS <= now.getTime();
  }
  return heads.draftHead === grant.subject && grant.grantedAt.getTime() + GRACE_MS <= now.getTime();
}

function servedGrant(grant: GrantRow, isLapsed: boolean): liveRoutes.Grant {
  return liveRoutes.Grant.parse({
    subject: grant.subject,
    holder: { senderId: grant.identityId, joinId: grant.joinId },
    grantedAt: grant.grantedAt.toISOString(),
    position: grant.position,
    lapsed: isLapsed,
  });
}

/**
 * The fold grant for `subject`, giving it to `holder` if nobody holds it
 * (section 5.10, **Saving**). None is given for a revision whose fold was
 * placed, and the latest grant comes back as it stands. Once a person's
 * grant lapsed, a join of theirs gets it again only 30 s later, or sooner
 * if no other person has a join present, so another who asks meanwhile
 * gets it first, and one member can't hold the session's saves up by
 * taking it again and again.
 */
async function takeGrant(
  tx: Database,
  session: SessionRow,
  subject: string,
  holder: JoinRow,
  {
    joins,
    now,
    heads,
    catchUp = false,
  }: { joins: JoinRow[]; now: Date; heads: Heads; catchUp?: boolean },
) {
  const present = presentSet(joins, now);
  // A catch-up's grants and a fold's are kept apart, whatever their subjects.
  const ofSubject = and(
    eq(liveGrants.sessionId, session.id),
    eq(liveGrants.subject, subject),
    eq(liveGrants.catchUp, catchUp),
  );
  const [placed] = await tx
    .select()
    .from(liveGrants)
    .where(and(ofSubject, isNotNull(liveGrants.position)))
    .limit(1);
  if (placed) return { grant: placed, lapsed: false };
  // The latest, and any not yet seen to lapse: at most one holds at a time.
  const grants = await tx
    .select()
    .from(liveGrants)
    .where(
      and(
        ofSubject,
        or(
          isNull(liveGrants.lapsedAt),
          sql`${liveGrants.id} = (select max(id) from ${liveGrants} where ${ofSubject})`,
        ),
      ),
    )
    .orderBy(desc(liveGrants.id));
  const at = { present, now, heads };
  for (const grant of grants) {
    if (grant.lapsedAt === null && lapsed(grant, at)) {
      // When it lapsed, not when that was seen, so the 30 s wait after counts from then.
      const holder = joins.find(
        (j) => j.identityId === grant.identityId && j.joinId === grant.joinId,
      );
      const limit = catchUp ? CATCH_UP_GRANT_MS : GRACE_MS;
      const when = new Date(
        Math.min(
          now.getTime(),
          grant.grantedAt.getTime() + limit,
          holder ? goneAt(holder) : now.getTime(),
        ),
      );
      await tx.update(liveGrants).set({ lapsedAt: when }).where(eq(liveGrants.id, grant.id));
      grant.lapsedAt = when;
    }
  }
  const held = grants.find((g) => g.lapsedAt === null);
  if (held) return { grant: held, lapsed: false };
  // The person whose grant lapsed last waits 30 s, while anyone else here may ask first.
  const latest = grants[0];
  const othersHere = joins.some(
    (j) => j.identityId !== holder.identityId && present.has(joinKey(j.identityId, j.joinId)),
  );
  if (
    latest?.lapsedAt &&
    latest.identityId === holder.identityId &&
    othersHere &&
    latest.lapsedAt.getTime() + GRACE_MS > now.getTime()
  ) {
    return { grant: latest, lapsed: true };
  }
  const [given] = await tx
    .insert(liveGrants)
    .values({
      sessionId: session.id,
      subject,
      identityId: holder.identityId,
      joinId: holder.joinId,
      givenAfter: session.lastPosition,
      grantedAt: now,
      catchUp,
    })
    .returning();
  if (!given) throw new Error('grant insert returned nothing');
  return { grant: given, lapsed: false, changed: true };
}

// --- Serving ---------------------------------------------------------------

/**
 * Bytes of stored messages one fetch serves at most, its sessions
 * together, snapshots included; past them it serves at least one more of
 * each session, and the stream serves the rest.
 */
const SERVED_MESSAGE_BYTES = 8 * 1024 * 1024;

/** Stored messages one session in a fetch serves at most, however small. */
const SERVED_ROWS = 4096;

/**
 * Grants a fetch or a stream's read lists at most, the latest: one is
 * given only for the draft head, so older ones are of drafts long folded.
 */
const GRANTS_SERVED = 64;

async function servedSession(
  tx: Database,
  session: SessionRow,
  {
    identity,
    heads,
    now,
    report,
    budget,
  }: {
    identity: PublicIdentity;
    heads: Heads;
    now: Date;
    report: ReportUnreadable;
    /** Bytes left of the fetch's `SERVED_MESSAGE_BYTES`. */
    budget: { left: number };
  },
): Promise<liveRoutes.ServedSession | null> {
  const row = { table: 'live_sessions', id: session.id };
  const record = readStored(SealedLiveRecord, session.sealed, row, report);
  if (!record) return null;
  const [wrapRow] = await tx
    .select({ wrap: liveWraps.wrap })
    .from(liveWraps)
    .where(eq(liveWraps.sessionId, session.id));
  const wrap = wrapRow ? readStored(KeyWrap, wrapRow.wrap, row, report) : null;
  if (wrap === undefined) return null;
  const envelopeRows = await tx
    .select({ envelope: liveEnvelopes.envelope })
    .from(liveEnvelopes)
    .where(
      and(
        eq(liveEnvelopes.sessionId, session.id),
        eq(liveEnvelopes.recipientIdentityId, identity.id),
        eq(liveEnvelopes.recipientKeyVersion, identity.keyVersion),
      ),
    );
  const envelopes = envelopeRows.flatMap((e) => {
    const parsed = readStored(MetadataEnvelopeV2, e.envelope, row, report);
    return parsed ? [parsed] : [];
  });
  const base = session.snapshotCovers ?? 0;
  const pinned = [1, session.snapshotPosition ?? 1];
  const [first] = await tx
    .select()
    .from(liveMessages)
    .where(and(eq(liveMessages.sessionId, session.id), eq(liveMessages.position, 1)));
  const firstSnapshot = first && servedMessage(first, report);
  if (!firstSnapshot) return null;
  let snapshot: liveRoutes.StoredMessage | null = null;
  let snapshotSize: number | null = null;
  if (session.snapshotPosition !== null) {
    const [later] = await tx
      .select()
      .from(liveMessages)
      .where(
        and(
          eq(liveMessages.sessionId, session.id),
          eq(liveMessages.position, session.snapshotPosition),
        ),
      );
    snapshot = (later && servedMessage(later, report)) ?? null;
    if (!snapshot) return null;
    snapshotSize = later?.size ?? 0;
  }
  // Each join's latest kept `update` or `saved` at or before what the snapshot covers.
  const latest =
    session.snapshotPosition === null
      ? []
      : (
          await tx.execute<{ position: number | string }>(sql`
            select distinct on (identity_id, join_id) position from ${liveMessages}
            where session_id = ${session.id} and position <= ${base}
              and kind in ('update', 'saved')
            order by identity_id, join_id, position desc`)
        ).map((r) => Number(r.position));
  budget.left -= first.size + (session.snapshotPosition === null ? 0 : (snapshotSize ?? 0));
  // Each join's latest kept change, in order, as far as the budget goes:
  // each counts what its row takes besides, so small ones are bounded too.
  let served = 0;
  const fits = (size: number) =>
    served === 0 || (budget.left - size - LIVE_MESSAGE_BYTES >= 0 && served < SERVED_ROWS);
  const sizes =
    latest.length === 0
      ? []
      : await tx
          .select({ position: liveMessages.position, size: liveMessages.size })
          .from(liveMessages)
          .where(
            and(eq(liveMessages.sessionId, session.id), inArray(liveMessages.position, latest)),
          )
          .orderBy(asc(liveMessages.position));
  const taken: number[] = [];
  for (const { position, size } of sizes) {
    if (!fits(size)) break;
    budget.left -= size + LIVE_MESSAGE_BYTES;
    served++;
    taken.push(position);
  }
  const latestRows =
    taken.length === 0
      ? []
      : await tx
          .select()
          .from(liveMessages)
          .where(and(eq(liveMessages.sessionId, session.id), inArray(liveMessages.position, taken)))
          .orderBy(asc(liveMessages.position));
  const messages: liveRoutes.StoredMessage[] = [];
  let position = taken.at(-1) ?? base;
  let complete = taken.length === sizes.length;
  if (complete) position = base;
  // Sizes first, then only the bodies that fit, so a fetch holds what it serves.
  for (let after = base; complete;) {
    const batch = await tx
      .select({ position: liveMessages.position, size: liveMessages.size })
      .from(liveMessages)
      .where(and(eq(liveMessages.sessionId, session.id), gt(liveMessages.position, after)))
      .orderBy(asc(liveMessages.position))
      .limit(200);
    if (batch.length === 0) break;
    const wanted: number[] = [];
    for (const message of batch) {
      after = message.position;
      if (pinned.includes(message.position)) {
        position = message.position;
        continue;
      }
      if (!fits(message.size)) {
        complete = false;
        break;
      }
      budget.left -= message.size + LIVE_MESSAGE_BYTES;
      served++;
      wanted.push(message.position);
      position = message.position;
    }
    if (wanted.length === 0) continue;
    const bodies = await tx
      .select()
      .from(liveMessages)
      .where(and(eq(liveMessages.sessionId, session.id), inArray(liveMessages.position, wanted)))
      .orderBy(asc(liveMessages.position));
    for (const body of bodies) {
      const one = servedMessage(body, report);
      if (one) messages.push(one);
    }
  }
  if (complete) position = session.lastPosition;
  const joins = await joinsOf(tx, session.id);
  const grants = await grantsOf(tx, session, { heads, now, joins });
  return {
    sessionId: session.id as liveRoutes.ServedSession['sessionId'],
    record,
    wrap,
    envelopes,
    revisionId: session.revisionId as liveRoutes.ServedSession['revisionId'],
    startedAt: session.createdAt.toISOString(),
    ended: session.endedReason,
    firstSnapshot,
    snapshot,
    latest: latestRows.flatMap((r) => {
      const served = servedMessage(r, report);
      return served ? [served] : [];
    }),
    messages,
    position,
    complete,
    joins: servedJoins(joins, now),
    grants,
  };
}

/**
 * The grants a newcomer is served: the latest given since the latest
 * snapshot or placed after what it covers, and the one for the current
 * draft head, at most `GRANTS_SERVED`.
 */
async function grantsOf(
  tx: Database,
  session: SessionRow,
  { heads, now, joins }: { heads: Heads; now: Date; joins?: JoinRow[] },
) {
  const base = session.snapshotCovers ?? 0;
  const rows = await tx
    .select()
    .from(liveGrants)
    .where(
      and(
        eq(liveGrants.sessionId, session.id),
        or(
          sql`${liveGrants.givenAfter} >= ${base}`,
          sql`${liveGrants.position} > ${base}`,
          heads.draftHead === null ? sql`false` : eq(liveGrants.subject, heads.draftHead),
        ),
      ),
    )
    .orderBy(desc(liveGrants.id))
    .limit(GRANTS_SERVED);
  const present = presentSet(joins ?? (await joinsOf(tx, session.id)), now);
  return rows.reverse().map((g) => servedGrant(g, lapsed(g, { present, now, heads })));
}

/** Whether an ended session holds an `update` after the position its latest `saved` covers. */
const unsaved = (session: SessionRow) => session.lastUpdatePosition > (session.savedCovers ?? 0);

/**
 * Whether an ended session is one to catch up from now (section 5.10,
 * **Ending**): it holds unsaved changes under keys that still count, and
 * every join of it has left, catch-up joins aside.
 */
async function catchable(tx: Database, session: SessionRow, now: Date) {
  if (session.endedReason === null || !unsaved(session)) return false;
  const joins = await joinsOf(tx, session.id);
  const present = presentSet(joins, now);
  if (joins.some((j) => !j.catchUp && present.has(joinKey(j.identityId, j.joinId)))) return false;
  if (!(await keysCount(tx, session))) return false;
  // Only the page's latest kept one: a later one with unsaved changes under keys that count.
  for (const later of await laterEnded(tx, session)) {
    if (await keysCount(tx, later)) return false;
  }
  return true;
}

/** The page's sessions that ended after `session`, with unsaved changes, a few at most. */
const laterEnded = (tx: Database, session: SessionRow) =>
  tx
    .select()
    .from(liveSessions)
    .where(
      and(
        eq(liveSessions.pageId, session.pageId),
        // Against its own row, in microseconds, which a JavaScript date drops.
        sql`${liveSessions.endedAt} > (select ended_at from ${liveSessions} where id = ${session.id})`,
        sql`${liveSessions.lastUpdatePosition} > coalesce(${liveSessions.savedCovers}, 0)`,
      ),
    )
    .orderBy(desc(liveSessions.endedAt))
    .limit(10);

/**
 * The page's open session, and the latest ended one kept with unsaved
 * changes once every join of it has left, for a person who can edit the
 * page now (section 5.10, **Ending**), with the caller's key material.
 */
export async function getLive(
  db: Database,
  actor: Actor,
  pageId: string,
  report: ReportUnreadable,
) {
  return readSnapshot(db, async (tx) => {
    const { caller, page } = await editorOfPage(tx, actor, pageId);
    const heads = await headsOf(tx, page.id);
    const now = await dbNow(tx);
    const [openRow] = await tx
      .select()
      .from(liveSessions)
      .where(and(eq(liveSessions.pageId, page.id), isNull(liveSessions.endedAt)));
    // Ended ones kept with unsaved changes, newest first, a few at most.
    const endedRows = await tx
      .select()
      .from(liveSessions)
      .where(
        and(
          eq(liveSessions.pageId, page.id),
          isNotNull(liveSessions.endedAt),
          sql`${liveSessions.lastUpdatePosition} > coalesce(${liveSessions.savedCovers}, 0)`,
        ),
      )
      .orderBy(desc(liveSessions.endedAt))
      .limit(10);
    const at = {
      identity: caller.identity,
      heads,
      now,
      report,
      budget: { left: SERVED_MESSAGE_BYTES },
    };
    // The open one first, so the budget goes to it.
    const open = openRow ? await servedSession(tx, openRow, at) : null;
    let ended: liveRoutes.ServedSession | null = null;
    // The latest kept with unsaved changes under keys that count, once its joins have left.
    for (const session of endedRows) {
      if (!(await keysCount(tx, session))) continue;
      if (await catchable(tx, session, now)) ended = await servedSession(tx, session, at);
      break;
    }
    return {
      open,
      ended,
      draftHead: heads.draftHead as liveRoutes.ServedSession['revisionId'] | null,
    };
  });
}

// --- Starting --------------------------------------------------------------

export type StartLive = {
  actor: Actor;
  pageId: string;
  sessionId: string;
  joinId: string;
  revisionId: string;
  metadata: SealedLiveRecord;
  wrap: KeyWrap | null;
  envelopes: MetadataEnvelopeV2[];
  snapshot: LiveMessage;
  permissionVersion: number;
  storageBytes: number;
  storedBytesPerMinute: number | null;
};

/**
 * Start a session (section 5.10, **Writing the record**), under the locks
 * of a draft save, with its first snapshot and the starter's join. A start
 * sent again byte for byte is answered as before; any other start with a
 * taken session ID is `duplicate`.
 */
export async function startLive(db: Database, input: StartLive) {
  const { record, signature, payload } = input.metadata;
  return db.transaction(async (tx) => {
    const caller = await requireCaller(tx, input.actor);
    if (caller.personId !== null) throw new ContentError('not-found');
    await lockSpaceOf(tx, input.pageId);
    const access = await requirePageAccess(tx, caller, await requirePage(tx, input.pageId));
    if (!canEdit(access)) throw new ContentError('not-found');
    const share = await lockShare(tx, access.share);
    const page = await requirePage(tx, input.pageId, { lock: true });
    // Again under the locks, so a change of access that landed meanwhile counts.
    if (!canEdit(await requirePageAccess(tx, caller, page))) throw new ContentError('not-found');
    const [heads] = await tx
      .select()
      .from(pageHeads)
      .where(eq(pageHeads.pageId, page.id))
      .for('update');
    if (!heads) throw new ContentError('not-found');
    const [taken] = await tx
      .select()
      .from(liveSessions)
      .where(eq(liveSessions.id, input.sessionId));
    if (taken) {
      if (await sameStart(tx, taken, input, caller)) {
        return { sessionId: input.sessionId, position: 1 };
      }
      throw new ContentError('duplicate', 'That session ID is taken');
    }
    // Taken by a session that has gone: IDs stay unique across the installation.
    const [used] = await tx
      .select({ id: liveSessionIds.id })
      .from(liveSessionIds)
      .where(eq(liveSessionIds.id, input.sessionId));
    if (used) throw new ContentError('duplicate', 'That session ID is taken');
    if (page.permissionVersion !== input.permissionVersion) {
      throw new ContentError('permission-version', 'Access changed; reload and try again');
    }
    // A page published from another page has no draft until it is detached (section 13).
    if (heads.draftHead === null) {
      throw new ContentError('forbidden', 'Detach this page from its source to edit it here');
    }
    const { installationId } = await readSettings(tx);
    if (
      record.installationId !== installationId ||
      record.spaceId !== page.spaceId ||
      record.subjectId !== input.sessionId
    ) {
      throw new ContentError('binding-mismatch', 'The record is for another session or space');
    }
    if (
      record.authorId !== caller.identity.id ||
      record.authorKeyVersion !== caller.identity.keyVersion
    ) {
      throw new ContentError('forbidden', 'A session’s record is signed by its starter');
    }
    if (!verifySignature(caller.identity, metadataRecordV2Bytes(record), signature)) {
      throw new ContentError('bad-signature', 'Session record signature is invalid');
    }
    if (hash(sealedBytes(payload)) !== record.payloadHash) {
      throw new ContentError('bad-signature', 'Session ciphertext does not match its signed hash');
    }
    if (decodedLength(payload.ciphertext) > liveRoutes.MAX_RECORD_PAYLOAD_BYTES) {
      throw new ContentError('too-large', 'This session record is too large');
    }
    // A sealed 32-byte key is 80 bytes, so an envelope holds nothing its charge leaves out.
    if (input.envelopes.some((e) => decodedLength(e.sealedKey) !== 80)) {
      throw new ContentError('invalid-request', 'An envelope seals a 32-byte key');
    }
    await checkKeyMaterial(tx, {
      spaceId: page.spaceId,
      share,
      wrap: input.wrap,
      envelopes: input.envelopes,
      author: caller.identity,
      namesVersion: (e) => e.metadataRevisionId === record.metadataRevisionId,
      signedBytes: (e) => metadataEnvelopeV2Bytes(record, e),
    });
    if (input.revisionId !== heads.draftHead) {
      throw new ContentError('stale-head', 'The page changed since you loaded it', {
        draftHead: heads.draftHead,
        publishedHead: heads.publishedHead,
      });
    }
    const { snapshot } = input;
    const size = checkMessage(snapshot, caller, input.joinId);
    if (snapshot.kind !== 'snapshot' || snapshot.seq !== 1) {
      throw new ContentError('invalid-request', 'A session starts with its first snapshot, seq 1');
    }
    await requireNewVersionId(tx, record.metadataRevisionId);
    const [open] = await tx
      .select({ id: liveSessions.id })
      .from(liveSessions)
      .where(and(eq(liveSessions.pageId, page.id), isNull(liveSessions.endedAt)));
    if (open) throw new ContentError('duplicate', 'The page has an open session');
    // What `live_usage` will count for it: the record, the ID, the snapshot as stored, the join.
    const stored = payload.ciphertext.length + LIVE_ID_BYTES + storedSize(size) + LIVE_JOIN_BYTES;
    await spendStoredBytes(
      tx,
      caller.accountId,
      size + LIVE_MESSAGE_BYTES,
      input.storedBytesPerMinute,
    );
    await charge(tx, caller.accountId, stored, input.storageBytes);
    await tx.insert(liveSessionIds).values({
      id: input.sessionId,
      versionId: record.metadataRevisionId,
      starterAccountId: caller.accountId,
    });
    await tx.insert(liveSessions).values({
      id: input.sessionId,
      spaceId: page.spaceId,
      pageId: page.id,
      versionId: record.metadataRevisionId,
      revisionId: input.revisionId,
      sealed: input.metadata,
      shareId: input.wrap?.shareId ?? null,
      keyVersion: input.wrap?.keyVersion ?? null,
      starterIdentityId: caller.identity.id,
      starterAccountId: caller.accountId,
      joinsMade: 1,
      lastPosition: 1,
    });
    if (input.wrap) {
      await tx.insert(liveWraps).values({
        sessionId: input.sessionId,
        shareId: input.wrap.shareId,
        keyVersion: input.wrap.keyVersion,
        wrap: input.wrap,
      });
    }
    if (input.envelopes.length > 0) {
      await tx.insert(liveEnvelopes).values(
        input.envelopes.map((envelope) => ({
          sessionId: input.sessionId,
          recipientIdentityId: envelope.recipientId,
          recipientKeyVersion: envelope.recipientKeyVersion,
          envelope,
        })),
      );
    }
    await tx.insert(liveJoins).values({
      sessionId: input.sessionId,
      identityId: caller.identity.id,
      joinId: input.joinId,
      keyVersion: caller.identity.keyVersion,
      accountId: caller.accountId,
      ordinal: 1,
      lastSeq: 1,
      // Present for 30 s until its stream opens, whatever it sends meanwhile.
      streamBrokeAt: sql`now()`,
    });
    await tx.insert(liveMessages).values({
      sessionId: input.sessionId,
      position: 1,
      kind: 'snapshot',
      identityId: caller.identity.id,
      joinId: input.joinId,
      seq: 1,
      accountId: caller.accountId,
      message: snapshot,
      size,
      covers: 0,
      revisionId: input.revisionId,
    });
    return { sessionId: input.sessionId, position: 1 };
  });
}

// The same start again, byte for byte: same page, starter, record, key
// material, join, draft and first snapshot.
async function sameStart(tx: Database, taken: SessionRow, input: StartLive, caller: Caller) {
  if (
    taken.pageId !== input.pageId ||
    taken.starterIdentityId !== caller.identity.id ||
    taken.revisionId !== input.revisionId ||
    stable(taken.sealed) !== stable(input.metadata)
  ) {
    return false;
  }
  const [wrap] = await tx.select().from(liveWraps).where(eq(liveWraps.sessionId, taken.id));
  if (stable(wrap?.wrap ?? null) !== stable(input.wrap)) return false;
  const envelopes = await tx
    .select({ envelope: liveEnvelopes.envelope })
    .from(liveEnvelopes)
    .where(eq(liveEnvelopes.sessionId, taken.id));
  const sorted = (list: unknown[]) => list.map(stable).sort();
  if (stable(sorted(envelopes.map((e) => e.envelope))) !== stable(sorted(input.envelopes))) {
    return false;
  }
  const [first] = await tx
    .select()
    .from(liveMessages)
    .where(and(eq(liveMessages.sessionId, taken.id), eq(liveMessages.position, 1)));
  return first?.joinId === input.joinId && stable(first.message) === stable(input.snapshot);
}

// --- Joining ---------------------------------------------------------------

/** What opening the stream answers: the session ended, or the join made or resumed. */
export type Joined =
  | {
      ended: liveRoutes.EndReason;
      draftHead: string | null;
      /** What an ended session keeps after `after`, to read and then close. */
      lastPosition: number;
    }
  | {
      ended: null;
      pageId: string;
      identityId: string;
      joinId: string;
      joins: liveRoutes.Join[];
      draftHead: string | null;
      draftCount: number;
      lastPosition: number;
      snapshotCovers: number;
      token: string;
      /** The grants a newcomer is served, for the stream's first lines. */
      grants: liveRoutes.Grant[];
    };

/**
 * Open the stream as `joinId` (section 5.10, **Serving and relaying**): a
 * new join of the caller's, or one still present, resumed. A join of the
 * caller's that has gone is `not-found`, and so is a further join, which
 * has no stream. `after` past the last position is `invalid-request`, and
 * below what the latest later snapshot covers, whose messages are gone,
 * `stale-head`, but with `kept`, what the snapshot its fetch was built on
 * covers, for a newcomer still fetching what that snapshot kept, while it
 * is still the latest. An ended session makes no join: its stream serves what
 * it keeps after `after`, then the end. Each stream gets a token
 * of its own, so a stream that broke marks its join only while it is the
 * join's latest.
 */
export async function joinLive(
  db: Database,
  input: {
    actor: Actor;
    sessionId: string;
    joinId: string;
    after: number;
    /** What the snapshot covers that the caller's fetch, cut short, was built on. */
    kept?: number | undefined;
    storageBytes: number;
  },
): Promise<Joined> {
  return db.transaction(async (tx) => {
    const { caller, page, session } = await sessionFor(tx, input.actor, input.sessionId, {
      lock: true,
    });
    const heads = await headsOf(tx, page.id);
    if (input.after > session.lastPosition) {
      throw new ContentError('invalid-request', 'That position is past the session’s last');
    }
    const covers = session.snapshotCovers ?? 0;
    // Below what the snapshot covers only to finish a fetch built on that very snapshot.
    const short = input.kept === undefined ? input.after < covers : input.kept !== covers;
    if (short) {
      throw new ContentError('stale-head', 'A snapshot has covered what you missed; join afresh', {
        draftHead: heads.draftHead,
        publishedHead: heads.publishedHead,
      });
    }
    // An ended one is read, not joined: what it keeps, then its end, only as a
    // fetch would serve it, to catch up from (`catchable`); otherwise its end alone.
    if (session.endedReason !== null) {
      // As a fetch would serve it, or to someone who took part, for what it relayed them.
      const [took] = await tx
        .select({ joinId: liveJoins.joinId })
        .from(liveJoins)
        .where(
          and(eq(liveJoins.sessionId, session.id), eq(liveJoins.identityId, caller.identity.id)),
        )
        .limit(1);
      const readable = took
        ? await keysCount(tx, session)
        : await catchable(tx, session, await dbNow(tx));
      return {
        ended: session.endedReason,
        draftHead: heads.draftHead,
        lastPosition: readable ? session.lastPosition : input.after,
      };
    }
    const now = await dbNow(tx);
    const token = randomUUID();
    const joins = await joinsOf(tx, session.id);
    const present = presentSet(joins, now);
    const mine = joins.find(
      (j) => j.identityId === caller.identity.id && j.joinId === input.joinId,
    );
    if (mine) {
      if (
        mine.parentJoinId !== null ||
        mine.catchUp ||
        !present.has(joinKey(mine.identityId, mine.joinId))
      ) {
        throw new ContentError('not-found', 'That join has gone; join afresh');
      }
      if (mine.keyVersion !== caller.identity.keyVersion) {
        throw new ContentError('not-found', 'Your key changed; join afresh');
      }
      await tx
        .update(liveJoins)
        .set({ streamOpen: true, streamToken: token, streamBrokeAt: null, lastMessageAt: now })
        .where(
          and(
            eq(liveJoins.sessionId, session.id),
            eq(liveJoins.identityId, mine.identityId),
            eq(liveJoins.joinId, mine.joinId),
          ),
        );
    } else {
      requireRoomForJoin(joins, present, caller.identity.id);
      await chargeLive(tx, caller.accountId, LIVE_JOIN_BYTES, input.storageBytes);
      await tx.insert(liveJoins).values({
        sessionId: session.id,
        identityId: caller.identity.id,
        joinId: input.joinId,
        keyVersion: caller.identity.keyVersion,
        accountId: caller.accountId,
        ordinal: session.joinsMade + 1,
        streamOpen: true,
        streamToken: token,
        lastMessageAt: now,
      });
      await tx
        .update(liveSessions)
        .set({ joinsMade: session.joinsMade + 1 })
        .where(eq(liveSessions.id, session.id));
    }
    return {
      ended: null,
      pageId: page.id,
      identityId: caller.identity.id,
      joinId: input.joinId,
      joins: servedJoins(await joinsOf(tx, session.id), now),
      draftHead: heads.draftHead,
      draftCount: heads.draftCount,
      lastPosition: session.lastPosition,
      snapshotCovers: session.snapshotCovers ?? 0,
      token,
      grants: await grantsOf(tx, session, { heads, now }),
    };
  });
}

/**
 * Room for one more join of the person's (`rate-limited` otherwise): at
 * most eight present at once, and, since every join the session keeps is
 * listed to everyone and keeps its latest change, at most so many made by
 * one person and in all.
 */
function requireRoomForJoin(joins: readonly JoinRow[], present: Set<string>, identityId: string) {
  const mine = joins.filter((j) => j.identityId === identityId);
  if (
    mine.filter((j) => present.has(joinKey(j.identityId, j.joinId))).length >=
    liveRoutes.MAX_JOINS_PER_PERSON
  ) {
    throw new ContentError('busy', 'You are in this session too many times at once');
  }
  if (
    mine.length >= liveRoutes.MAX_JOINS_MADE_PER_PERSON ||
    joins.length >= liveRoutes.MAX_JOINS_PER_SESSION
  ) {
    throw new ContentError('busy', 'This session has had too many joins; start another');
  }
}

/**
 * The stream `token` of `joinId` broke: the join stays present for 30 s
 * more at most, unless a newer stream of it opened meanwhile.
 */
export async function streamClosed(
  db: Database,
  input: { sessionId: string; identityId: string; joinId: string; token: string },
) {
  await db
    .update(liveJoins)
    .set({ streamOpen: false, streamToken: null, streamBrokeAt: sql`now()` })
    .where(
      and(
        eq(liveJoins.sessionId, input.sessionId),
        eq(liveJoins.identityId, input.identityId),
        eq(liveJoins.joinId, input.joinId),
        eq(liveJoins.streamToken, input.token),
      ),
    );
}

/**
 * The join a request comes from: the caller's join `joinId` if it is
 * present, or a further
 * join of the caller's present join `parent`, made now: at most two of
 * those present at once, and at most eight joins of the person's.
 */
async function joinFor(
  tx: Database,
  { caller, session }: { caller: Caller; session: SessionRow },
  {
    joinId,
    parent,
    storageBytes,
  }: { joinId: string; parent?: string | undefined; storageBytes: number },
  now: Date,
) {
  const joins = await joinsOf(tx, session.id);
  const present = presentSet(joins, now);
  const mine = joins.find((j) => j.identityId === caller.identity.id && j.joinId === joinId);
  if (mine) {
    if (parent !== undefined && mine.parentJoinId !== parent) {
      throw new ContentError('invalid-request', 'That join belongs to another');
    }
    if (mine.keyVersion !== caller.identity.keyVersion) {
      throw new ContentError('not-found', 'Your key changed; join afresh');
    }
    if (!present.has(joinKey(mine.identityId, mine.joinId))) {
      throw new ContentError('not-found', 'That join has gone; join afresh');
    }
    return { join: mine, joins, made: false };
  }
  if (parent === undefined) {
    throw new ContentError(
      'invalid-request',
      'Open the stream to join, or name your join’s parent',
    );
  }
  if (session.endedReason !== null) {
    throw new ContentError('forbidden', 'This session has ended');
  }
  const owner = joins.find((j) => j.identityId === caller.identity.id && j.joinId === parent);
  if (
    !owner ||
    owner.parentJoinId !== null ||
    owner.catchUp ||
    !present.has(joinKey(owner.identityId, owner.joinId))
  ) {
    throw new ContentError('not-found', 'That join has gone; join afresh');
  }
  const further = joins.filter(
    (j) =>
      j.identityId === caller.identity.id &&
      j.parentJoinId === parent &&
      present.has(joinKey(j.identityId, j.joinId)),
  );
  if (further.length >= liveRoutes.MAX_FURTHER_JOINS) {
    throw new ContentError('busy', 'That join has two further joins already');
  }
  requireRoomForJoin(joins, present, caller.identity.id);
  await chargeLive(tx, caller.accountId, LIVE_JOIN_BYTES, storageBytes);
  const ordinal = session.joinsMade + 1;
  const [made] = await tx
    .insert(liveJoins)
    .values({
      sessionId: session.id,
      identityId: caller.identity.id,
      joinId,
      keyVersion: caller.identity.keyVersion,
      accountId: caller.accountId,
      ordinal,
      parentJoinId: parent,
      lastMessageAt: now,
    })
    .returning();
  if (!made) throw new Error('join insert returned nothing');
  session.joinsMade = ordinal;
  await tx.update(liveSessions).set({ joinsMade: ordinal }).where(eq(liveSessions.id, session.id));
  return { join: made, joins: [...joins, made], made: true };
}

/** A catch-up join of the caller's in an ended session, which every other join has left. */
async function catchUpJoin(
  tx: Database,
  { caller, session }: { caller: Caller; session: SessionRow },
  joinId: string,
  now: Date,
  storageBytes: number,
) {
  const joins = await joinsOf(tx, session.id);
  const present = presentSet(joins, now);
  const mine = joins.find((j) => j.identityId === caller.identity.id && j.joinId === joinId);
  if (mine) {
    if (!mine.catchUp || !present.has(joinKey(mine.identityId, mine.joinId))) {
      throw new ContentError('not-found', 'That join has gone; join afresh');
    }
    return { join: mine, joins, made: false };
  }
  // Served, and so caught up from, only once every join has left (section 5.10,
  // **Ending**), with unsaved changes under keys that still count; other
  // catch-up joins wait on the grant instead.
  const others = joins.filter((j) => !j.catchUp && present.has(joinKey(j.identityId, j.joinId)));
  if (others.length > 0 || !(await catchable(tx, session, now))) {
    throw new ContentError('not-found');
  }
  requireRoomForJoin(joins, present, caller.identity.id);
  await chargeLive(tx, caller.accountId, LIVE_JOIN_BYTES, storageBytes);
  const ordinal = session.joinsMade + 1;
  const [made] = await tx
    .insert(liveJoins)
    .values({
      sessionId: session.id,
      identityId: caller.identity.id,
      joinId,
      keyVersion: caller.identity.keyVersion,
      accountId: caller.accountId,
      ordinal,
      catchUp: true,
      lastMessageAt: now,
    })
    .returning();
  if (!made) throw new Error('join insert returned nothing');
  session.joinsMade = ordinal;
  await tx.update(liveSessions).set({ joinsMade: ordinal }).where(eq(liveSessions.id, session.id));
  return { join: made, joins: [...joins, made], made: true };
}

/** What a request changed, for the streams to relay once it commits. */
export type Relay = {
  sessionId: string;
  pageId: string;
  /** What it stored and relayed, in the order the request sent it. */
  sent: ({ stored: liveRoutes.StoredMessage } | { presence: LiveMessage })[];
  grants: liveRoutes.Grant[];
  joinsChanged: boolean;
  /** The session went with this request: a catch-up finished. */
  deleted: boolean;
  /** The session has ended: its streams end, and hear nothing more. */
  ended: boolean;
  /** The page's draft head as the request saw it, and how many drafts it had then. */
  draftHead: string | null;
  draftCount: number;
};

type StoreInput = {
  message: LiveMessage;
  covers: number | null;
  revisionId: string | null;
  size: number;
};

/**
 * Store a message from `join` at the session's next position, or, sent
 * again unchanged after a lost answer, answer the position it was stored
 * at (null if a snapshot has since covered it). Another message at a
 * `seq` the join has used is `duplicate`, and one that skips a `seq`
 * `invalid-request`.
 */
async function storeMessage(
  tx: Database,
  session: SessionRow,
  join: JoinRow,
  caller: Caller,
  { message, covers, revisionId, size }: StoreInput,
): Promise<{ position: number | null; row: MessageRow | null }> {
  if (message.seq <= join.lastSeq) {
    const [stored] = await tx
      .select()
      .from(liveMessages)
      .where(
        and(
          eq(liveMessages.sessionId, session.id),
          eq(liveMessages.identityId, join.identityId),
          eq(liveMessages.joinId, join.joinId),
          eq(liveMessages.seq, message.seq),
        ),
      );
    if (!stored) {
      // Stored once, and covered by a snapshot since: the same message, as far as anyone can tell.
      return { position: null, row: null };
    }
    if (
      stable(stored.message) === stable(message) &&
      stored.covers === covers &&
      stored.revisionId === revisionId
    ) {
      return { position: stored.position, row: null };
    }
    throw new ContentError('duplicate', 'Another message was stored at that seq');
  }
  if (message.seq !== join.lastSeq + 1) {
    throw new ContentError('invalid-request', 'Stored messages are numbered without gaps');
  }
  const position = session.lastPosition + 1;
  const [row] = await tx
    .insert(liveMessages)
    .values({
      sessionId: session.id,
      position,
      kind: message.kind as MessageRow['kind'],
      identityId: join.identityId,
      joinId: join.joinId,
      seq: message.seq,
      accountId: caller.accountId,
      message,
      size,
      covers,
      revisionId,
    })
    .returning();
  if (!row) throw new Error('message insert returned nothing');
  session.lastPosition = position;
  join.lastSeq = message.seq;
  if (message.kind === 'update') session.lastUpdatePosition = position;
  if (message.kind === 'saved') session.savedCovers = covers;
  return { position, row };
}

/**
 * Store what a request moved on. `touch` keeps its join present: any
 * request of a join in an open session, and of a catch-up join, but in an
 * ended session no other, so nobody keeps an ended session from going, or
 * a join that went from coming back.
 */
async function saveCounters(
  tx: Database,
  session: SessionRow,
  join: JoinRow,
  now: Date,
  { touch }: { touch: boolean },
) {
  await tx
    .update(liveSessions)
    .set({
      lastPosition: session.lastPosition,
      lastUpdatePosition: session.lastUpdatePosition,
      savedCovers: session.savedCovers,
      snapshotPosition: session.snapshotPosition,
      snapshotCovers: session.snapshotCovers,
    })
    .where(eq(liveSessions.id, session.id));
  await tx
    .update(liveJoins)
    .set(touch ? { lastSeq: join.lastSeq, lastMessageAt: now } : { lastSeq: join.lastSeq })
    .where(
      and(
        eq(liveJoins.sessionId, session.id),
        eq(liveJoins.identityId, join.identityId),
        eq(liveJoins.joinId, join.joinId),
      ),
    );
}

export type SendLive = {
  actor: Actor;
  sessionId: string;
  joinId: string;
  messages: { message: LiveMessage; covers?: number | undefined }[];
  parent?: string | undefined;
  fold?: string | undefined;
  storageBytes: number;
  storedBytesPerMinute: number | null;
};

/**
 * Send messages from a join (section 5.10, **Serving and relaying**),
 * under the locks a change of access takes too, so none is taken once the
 * session has ended but a `saved`. Stored kinds get positions; presence is
 * relayed, never stored. See `liveRoutes.sendMessages` for `parent` and
 * `fold`.
 */
export async function sendLive(db: Database, input: SendLive) {
  return db.transaction(async (tx) => {
    const ctx = await sessionFor(tx, input.actor, input.sessionId, { lock: true });
    const { caller, page, session } = ctx;
    const now = await dbNow(tx);
    const ended = session.endedReason !== null;
    const catchingUp = ended && input.fold === session.id;
    // Every lock a charge takes, before any row is written (a join's included).
    await lockCharges(tx, caller.accountId, input.storedBytesPerMinute);
    const { join, joins, made } = catchingUp
      ? await catchUpJoin(tx, ctx, input.joinId, now, input.storageBytes)
      : await joinFor(tx, ctx, input, now);
    // Only the catch-up grant's holder sends the `saved` that lets the session go,
    // naming the session as `fold`.
    if (join.catchUp && !catchingUp && input.messages.length > 0) {
      throw new ContentError('forbidden', 'A catch-up join sends its saved with its grant');
    }
    if (catchingUp && input.messages.length > 0) {
      const heads = await headsOf(tx, page.id);
      const taken = await takeGrant(tx, session, session.id, join, {
        joins,
        now,
        heads,
        catchUp: true,
      });
      if (
        taken.lapsed ||
        taken.grant.identityId !== join.identityId ||
        taken.grant.joinId !== join.joinId
      ) {
        throw new ContentError('forbidden', 'Another join is catching up from this session');
      }
    }
    const relay: Relay = {
      sessionId: session.id,
      pageId: page.id,
      sent: [],
      grants: [],
      joinsChanged: made,
      deleted: false,
      ended,
      draftHead: null,
      draftCount: 0,
    };
    const positions: (number | null)[] = [];
    const updates: number[] = [];
    const resent: number[] = [];
    const resending = input.messages.some(
      ({ message }) => message.kind !== 'presence' && message.seq <= join.lastSeq,
    );
    // The seq a presence in this request carries: the last stored before
    // it, which for a request sent again is below what the join has stored.
    const firstStored = input.messages.find((m) => m.message.kind !== 'presence')?.message.seq;
    let reached =
      firstStored !== undefined && firstStored <= join.lastSeq ? firstStored - 1 : join.lastSeq;
    let savedAt: number | null = null;
    let bytes = 0;
    for (const { message, covers } of input.messages) {
      const size = checkMessage(message, caller, join.joinId);
      // A request stored before the end, sent again after a lost answer, is taken as
      // stored, its presence with it, though no presence is relayed once it has ended.
      const resend = message.kind === 'presence' ? resending : message.seq <= join.lastSeq;
      if (ended && message.kind !== 'saved' && !resend) {
        throw new ContentError('forbidden', 'This session has ended; it takes only saved');
      }
      if (join.catchUp && message.kind !== 'saved') {
        throw new ContentError('invalid-request', 'A catch-up join sends only its saved');
      }
      if (message.kind === 'snapshot') {
        throw new ContentError('invalid-request', 'Snapshots go to the snapshots route');
      }
      if ((message.kind === 'saved') !== (covers !== undefined)) {
        throw new ContentError(
          'invalid-request',
          'A saved, and only a saved, names what it covers',
        );
      }
      if (message.kind === 'presence') {
        if (join.parentJoinId !== null) {
          throw new ContentError('invalid-request', 'A further join keeps no presence');
        }
        if (message.seq !== reached) {
          throw new ContentError('invalid-request', 'A presence carries its join’s last seq');
        }
        if (relay.sent.some((item) => 'presence' in item)) {
          throw new ContentError('invalid-request', 'A request carries one presence at most');
        }
        if (!ended) relay.sent.push({ presence: message });
        positions.push(null);
        continue;
      }
      if (covers !== undefined && covers > session.lastPosition) {
        throw new ContentError('invalid-request', 'A saved covers only what was stored before it');
      }
      const stored = await storeMessage(tx, session, join, caller, {
        message,
        covers: covers ?? null,
        revisionId: null,
        size,
      });
      reached = message.seq;
      positions.push(stored.position);
      if (!stored.row) {
        if (message.kind === 'update' && stored.position !== null) resent.push(stored.position);
        continue;
      }
      // Its row counts toward the minute as it does toward storage.
      bytes += size + LIVE_MESSAGE_BYTES;
      const served = servedMessage(stored.row, ignore);
      if (served) relay.sent.push({ stored: served });
      if (message.kind === 'update') updates.push(stored.row.position);
      if (message.kind === 'saved') savedAt = stored.row.position;
    }
    await chargeStored(tx, caller, bytes, input, { stored: true });
    await saveCounters(tx, session, join, now, { touch: !ended || join.catchUp });
    if (ended && savedAt !== null) {
      // What it covers moved: the sweep reads it again at its next pass.
      await tx.update(liveSessions).set({ keptAt: null }).where(eq(liveSessions.id, session.id));
    }
    const heads = await headsOf(tx, page.id);
    relay.draftHead = heads.draftHead;
    relay.draftCount = heads.draftCount;
    let grant: liveRoutes.Grant | null = null;
    if (input.fold !== undefined) {
      grant = await foldFor(tx, {
        session,
        join,
        joins,
        heads,
        now,
        fold: input.fold,
        catchingUp,
        updates,
        resent,
        savedAt,
        relay,
      });
    }
    return { positions, grant, relay };
  });
}

/** The grant of `fold` a further join's `update` at one of `resent` placed, if one did. */
async function placedBy(
  tx: Database,
  session: SessionRow,
  fold: string,
  join: JoinRow,
  resent: number[],
) {
  if (join.parentJoinId === null) return undefined;
  const [placed] = await tx
    .select()
    .from(liveGrants)
    .where(
      and(
        eq(liveGrants.sessionId, session.id),
        eq(liveGrants.subject, fold),
        eq(liveGrants.catchUp, false),
        eq(liveGrants.identityId, join.identityId),
        eq(liveGrants.joinId, join.parentJoinId),
        inArray(liveGrants.position, resent),
      ),
    );
  return placed;
}

/**
 * The fold grant a request names: asked for by a main join, placed by a
 * further join of its holder with the request's one `update`, and for a
 * catch-up given to the catch-up join and placed by its `saved`, after
 * which the session goes.
 */
async function foldFor(
  tx: Database,
  {
    session,
    join,
    joins,
    heads,
    now,
    fold,
    catchingUp,
    updates,
    resent,
    savedAt,
    relay,
  }: {
    session: SessionRow;
    join: JoinRow;
    joins: JoinRow[];
    heads: Heads;
    now: Date;
    fold: string;
    catchingUp: boolean;
    updates: number[];
    /** Positions of `update`s this request sent again, stored before. */
    resent: number[];
    savedAt: number | null;
    relay: Relay;
  },
): Promise<liveRoutes.Grant> {
  const present = presentSet(joins, now);
  const at = { present, now, heads };
  if (catchingUp) {
    const taken = await takeGrant(tx, session, session.id, join, {
      joins,
      now,
      heads,
      catchUp: true,
    });
    let grant = taken.grant;
    const mine = grant.identityId === join.identityId && grant.joinId === join.joinId;
    if (mine && !taken.lapsed && savedAt !== null) {
      [grant = taken.grant] = await tx
        .update(liveGrants)
        .set({ position: savedAt })
        .where(eq(liveGrants.id, grant.id))
        .returning();
      // Caught up: nothing in it is left to save (section 5.10, **Ending**).
      await tx.delete(liveSessions).where(eq(liveSessions.id, session.id));
      relay.deleted = true;
    }
    return servedGrant(grant, taken.lapsed || lapsed(grant, at));
  }
  if (session.endedReason !== null) {
    // The request that placed a grant, sent again after the end: answered as before.
    const placed =
      join.parentJoinId !== null && resent.length === 1 && updates.length === 0
        ? await placedBy(tx, session, fold, join, resent)
        : undefined;
    if (placed) return servedGrant(placed, false);
    throw new ContentError('forbidden', 'This session has ended');
  }
  if (join.parentJoinId === null) {
    if (heads.draftHead !== fold) {
      throw new ContentError('stale-head', 'Only the draft head is folded in', {
        draftHead: heads.draftHead,
        publishedHead: heads.publishedHead,
      });
    }
    const taken = await takeGrant(tx, session, fold, join, { joins, now, heads });
    const grant = servedGrant(taken.grant, taken.lapsed);
    if (taken.changed) relay.grants.push(grant);
    return grant;
  }
  // A further join places its parent's grant with its one `update`.
  const [held] = await tx
    .select()
    .from(liveGrants)
    .where(
      and(
        eq(liveGrants.sessionId, session.id),
        eq(liveGrants.subject, fold),
        eq(liveGrants.catchUp, false),
        eq(liveGrants.identityId, join.identityId),
        eq(liveGrants.joinId, join.parentJoinId),
        isNull(liveGrants.position),
        isNull(liveGrants.lapsedAt),
      ),
    )
    .orderBy(desc(liveGrants.id))
    .limit(1);
  if (!held && resent.length === 1) {
    // The request that placed it, sent again after a lost answer: answered as before.
    const [placed] = await tx
      .select()
      .from(liveGrants)
      .where(
        and(
          eq(liveGrants.sessionId, session.id),
          eq(liveGrants.subject, fold),
          eq(liveGrants.identityId, join.identityId),
          eq(liveGrants.joinId, join.parentJoinId),
          inArray(liveGrants.position, resent),
        ),
      );
    if (placed && updates.length === 0) return servedGrant(placed, false);
  }
  if (!held || lapsed(held, at)) {
    throw new ContentError('forbidden', 'Your join holds no grant to fold that draft');
  }
  const [only] = updates;
  if (only === undefined || updates.length !== 1) {
    throw new ContentError('invalid-request', 'A fold is placed with exactly one update');
  }
  const [placed] = await tx
    .update(liveGrants)
    .set({ position: only })
    .where(eq(liveGrants.id, held.id))
    .returning();
  if (!placed) throw new Error('grant update returned nothing');
  const grant = servedGrant(placed, false);
  relay.grants.push(grant);
  return grant;
}

export type PostSnapshot = {
  actor: Actor;
  sessionId: string;
  joinId: string;
  parent?: string | undefined;
  message: LiveMessage;
  covers: number;
  revisionId: string;
  storageBytes: number;
  storedBytesPerMinute: number | null;
};

/**
 * Post a later snapshot (section 5.10), naming a draft of the page in the
 * clear (`binding-mismatch` otherwise). It covers at least what the latest
 * kept snapshot covers (`stale-head`) and at most the last position. The
 * stored messages it covers go, but the first snapshot and each join's
 * latest `update` or `saved` at or before it, and so do older later
 * snapshots.
 */
export async function postSnapshot(db: Database, input: PostSnapshot) {
  return db.transaction(async (tx) => {
    const ctx = await sessionFor(tx, input.actor, input.sessionId, { lock: true });
    const { caller, page, session } = ctx;
    const now = await dbNow(tx);
    // Every lock a charge takes, before any row is written (a join's included).
    await lockCharges(tx, caller.accountId, input.storedBytesPerMinute);
    const { join, made } = await joinFor(tx, ctx, input, now);
    // Once it has ended, only a snapshot stored before, sent again, is answered.
    if (session.endedReason !== null && input.message.seq > join.lastSeq) {
      throw new ContentError('forbidden', 'This session has ended');
    }
    const size = checkMessage(input.message, caller, join.joinId);
    if (input.message.kind !== 'snapshot') {
      throw new ContentError('invalid-request', 'Post a snapshot here');
    }
    const [draft] = await tx
      .select({ id: revisions.id })
      .from(revisions)
      .where(
        and(
          eq(revisions.id, input.revisionId),
          eq(revisions.pageId, page.id),
          eq(revisions.audience, 'draft'),
        ),
      );
    if (!draft)
      throw new ContentError('binding-mismatch', 'The snapshot names no draft of this page');
    const heads = await headsOf(tx, page.id);
    if (input.covers < (session.snapshotCovers ?? 0)) {
      throw new ContentError('stale-head', 'A later snapshot covers more', {
        draftHead: heads.draftHead,
        publishedHead: heads.publishedHead,
      });
    }
    if (input.covers > session.lastPosition) {
      throw new ContentError('invalid-request', 'A snapshot covers only what was stored before it');
    }
    const stored = await storeMessage(tx, session, join, caller, {
      message: input.message,
      covers: input.covers,
      revisionId: input.revisionId,
      size,
    });
    if (!stored.row) {
      if (stored.position === null) throw new ContentError('duplicate', 'That snapshot is gone');
      return { position: stored.position, relay: null };
    }
    await spendStoredBytes(
      tx,
      caller.accountId,
      size + LIVE_MESSAGE_BYTES,
      input.storedBytesPerMinute,
    );
    const position = stored.row.position;
    // What it covers goes, but the first snapshot and each join's latest kept change.
    // Ranked in one pass, so it costs no more than a sort however many there are.
    await tx.execute(sql`
      delete from ${liveMessages} m
      using (
        select position from (
          select position, row_number() over (
            partition by identity_id, join_id order by position desc) as rank
          from ${liveMessages}
          where session_id = ${session.id} and position <= ${input.covers}
            and kind in ('update', 'saved')
        ) ranked
        where rank > 1
      ) covered
      where m.session_id = ${session.id} and m.position = covered.position and m.position <> 1`);
    await tx.execute(sql`
      delete from ${liveMessages}
      where session_id = ${session.id} and kind = 'snapshot' and position <> 1
        and position < ${position}`);
    // Charged once what it covers has gone, so a snapshot can free room for itself.
    await chargeLive(tx, caller.accountId, 0, input.storageBytes);
    session.snapshotPosition = position;
    session.snapshotCovers = input.covers;
    await saveCounters(tx, session, join, now, { touch: true });
    const served = servedMessage(stored.row, ignore);
    const relay: Relay = {
      sessionId: session.id,
      pageId: page.id,
      sent: served ? [{ stored: served }] : [],
      grants: [],
      joinsChanged: made,
      deleted: false,
      ended: false,
      draftHead: heads.draftHead,
      draftCount: heads.draftCount,
    };
    return { position, relay };
  });
}

/** The caller's join `joinId` leaves at once, with its further joins. */
export async function leaveLive(
  db: Database,
  input: { actor: Actor; sessionId: string; joinId: string },
) {
  return db.transaction(async (tx) => {
    const { caller, session } = await sessionFor(tx, input.actor, input.sessionId, {
      lock: true,
    });
    const left = await tx
      .update(liveJoins)
      .set({ leftAt: sql`now()`, streamOpen: false })
      .where(
        and(
          eq(liveJoins.sessionId, session.id),
          eq(liveJoins.identityId, caller.identity.id),
          or(eq(liveJoins.joinId, input.joinId), eq(liveJoins.parentJoinId, input.joinId)),
          isNull(liveJoins.leftAt),
        ),
      )
      .returning({ joinId: liveJoins.joinId });
    return { left: left.length > 0, sessionId: session.id };
  });
}

/** A participant ends the session (section 5.10, **Ending**). Ending an ended one changes nothing. */
export async function endLive(db: Database, input: { actor: Actor; sessionId: string }) {
  return db.transaction(async (tx) => {
    const { session } = await sessionFor(tx, input.actor, input.sessionId, { lock: true });
    if (session.endedReason !== null) return { ended: false };
    await tx
      .update(liveSessions)
      .set({ endedAt: sql`now()`, endedReason: 'ended' })
      .where(eq(liveSessions.id, session.id));
    return { ended: true };
  });
}

// --- The streams' view -----------------------------------------------------

/**
 * A session as its streams follow it: ended or gone, its joins, the
 * page's draft head, and the grants a newcomer would be served.
 */
export async function liveState(db: Database, sessionId: string) {
  return readSnapshot(db, async (tx) => {
    const [session] = await tx.select().from(liveSessions).where(eq(liveSessions.id, sessionId));
    if (!session) return null;
    const now = await dbNow(tx);
    const heads = await headsOf(tx, session.pageId).catch(() => null);
    const joins = await joinsOf(tx, session.id);
    return {
      ended: session.endedReason,
      pageId: session.pageId,
      lastPosition: session.lastPosition,
      snapshotCovers: session.snapshotCovers ?? 0,
      draftHead: heads?.draftHead ?? null,
      draftCount: heads?.draftCount ?? 0,
      joins: servedJoins(joins, now),
      grants: heads ? await grantsOf(tx, session, { heads, now, joins }) : [],
    };
  });
}

/** Bytes of stored messages one read for a stream holds at most, or its one first message. */
const STREAM_BATCH_BYTES = 2 * 1024 * 1024;

/**
 * Stored messages of a session after `after`, up to `upTo`, oldest first:
 * at most 200, and no more than 2 MiB of ciphertext, or one larger, so a
 * stream that isn't read holds little; with what the session's latest
 * snapshot covers as they were read, so a stream can tell when a snapshot
 * has deleted what it was about to read.
 */
export async function storedAfter(
  db: Database,
  sessionId: string,
  after: number,
  { upTo }: { upTo?: number } = {},
) {
  // What the snapshot covers comes with the rows, from the same statement,
  // so they agree, and even when there are none.
  const rows = await db.execute<{
    position: number | string | null;
    message: unknown;
    covers: number | string | null;
    revision_id: string | null;
    snapshot_covers: number | string | null;
  }>(sql`
    select s.snapshot_covers, b.position, b.message, b.covers, b.revision_id
    from ${liveSessions} s
    left join lateral (
      select position, message, covers, revision_id from (
        select position, message, covers, revision_id, size,
          sum(size) over (order by position) as running
        from ${liveMessages}
        where session_id = s.id and position > ${after}
          ${upTo === undefined ? sql`` : sql`and position <= ${upTo}`}
        order by position limit 200
      ) batch
      where running <= ${STREAM_BATCH_BYTES} or running = size
    ) b on true
    where s.id = ${sessionId}
    order by b.position`);
  const snapshotCovers = Number(rows[0]?.snapshot_covers ?? 0);
  const messages = rows.flatMap((row) => {
    if (row.position === null) return [];
    const served = readStored(
      liveRoutes.StoredMessage,
      {
        position: Number(row.position),
        message: row.message,
        covers: row.covers === null ? null : Number(row.covers),
        revisionId: row.revision_id,
      },
      { table: 'live_messages', id: `${sessionId} ${row.position}` },
      ignore,
    );
    return served ? [served] : [];
  });
  return { messages, snapshotCovers };
}

/**
 * Whether a person can still edit the page of a session, for a stream to
 * stop relaying to someone who can't (section 5.10, **Ending**).
 */
export async function canStillEdit(db: Database, actor: Actor, sessionId: string) {
  return sessionFor(db, actor, sessionId, { lock: false }).then(
    () => true,
    (error: unknown) => {
      if (error instanceof ContentError) return false;
      throw error;
    },
  );
}

// --- Deletion --------------------------------------------------------------

/**
 * The pages `nodeIds` leave their region (a move across regions, a share
 * made or ended over them): their sessions' keys count for nobody from now
 * on, even if the pages come back, in the transaction that moves them.
 */
export async function loseLiveKeys(tx: Database, nodeIds: readonly string[]) {
  if (nodeIds.length === 0) return;
  await tx
    .update(liveSessions)
    .set({ keysLost: true })
    .where(sql`${liveSessions.pageId} = any(${sql.param([...nodeIds])}::text[])`);
}

/**
 * Whether the keys a session's record is under still count: in a share,
 * the page is still in the share it started in, at the key version it
 * started under; in the owner region, the page is still there and every
 * envelope is to an owner now. After a rotation, a move to another region
 * or the ending of its share nobody's do.
 */
async function keysCount(tx: Database, session: SessionRow) {
  // Its page left its region once: nobody's count, even if it came back.
  if (session.keysLost) return false;
  const share = await shareAt(tx, session.spaceId, session.pageId);
  if (session.shareId !== null) {
    if (!share || share.id !== session.shareId) return false;
    const [current] = await tx
      .select({ keyVersion: shares.currentKeyVersion })
      .from(shares)
      .where(eq(shares.id, share.id));
    return current?.keyVersion === session.keyVersion;
  }
  if (share) return false;
  const recipients = await tx
    .select({ id: liveEnvelopes.recipientIdentityId })
    .from(liveEnvelopes)
    .where(eq(liveEnvelopes.sessionId, session.id));
  const owners = new Set(
    (
      await tx
        .select({ id: spaceOwners.identityId })
        .from(spaceOwners)
        .where(and(eq(spaceOwners.spaceId, session.spaceId), isNull(spaceOwners.removedAt)))
    ).map((o) => o.id),
  );
  return recipients.length > 0 && recipients.every((r) => owners.has(r.id));
}

/**
 * Why a session should go now, if it should (section 5.10, **Ending**). An
 * ended one goes after the draft retention from its end whoever is still
 * there; an open one, from when its last join went.
 */
async function dueToGo(tx: Database, session: SessionRow, now: Date, retentionMs: number) {
  const at = now.getTime();
  if (session.endedAt && session.endedAt.getTime() + retentionMs <= at) return 'retention';
  const joins = await joinsOf(tx, session.id);
  const present = presentSet(joins, now);
  const there = joins.filter((j) => present.has(joinKey(j.identityId, j.joinId)));
  // A catch-up join keeps only a session there is something to catch up from.
  if (
    session.endedReason !== null &&
    there.every((j) => j.catchUp) &&
    (!unsaved(session) || !(await keysCount(tx, session)))
  ) {
    return unsaved(session) ? 'keys' : 'saved';
  }
  if (there.length > 0) return null;
  if (session.endedReason === null) {
    const lastGone = Math.max(0, ...joins.map(goneAt));
    if (lastGone + retentionMs <= at) return 'retention';
    if (lastGone + EMPTY_MS > at) return null;
    return unsaved(session) ? null : 'saved';
  }
  if (!unsaved(session)) return 'saved';
  if (!(await keysCount(tx, session))) return 'keys';
  // Only a page's latest ended session is served to catch up from; an older one
  // never is, once a later one holds unsaved changes under keys that still count.
  for (const next of await laterEnded(tx, session)) {
    if (await catchable(tx, next, now)) return 'superseded';
  }
  return null;
}

/**
 * Delete sessions whose time is up (section 5.10, **Ending**): an open one
 * a minute after its last join left, if no `update` came after what its
 * latest `saved` covers; an ended one once every join has left, unless an
 * `update` came after it and its keys still count; an ended one past the
 * draft retention from its end; and an open one past it from when its
 * last join went. Each is checked again under the locks a message takes.
 * Returns how many went.
 */
export async function sweepLive(
  db: Database,
  { retentionMs }: { retentionMs: number },
): Promise<number> {
  let removed = 0;
  const retention = sql`${`${retentionMs} milliseconds`}::interval`;
  // Each session that may be due, a batch at a time: ended past the
  // retention; ended, and not chosen to keep in the last 10 minutes; or open,
  // nobody in it, and either saved or left alone past the retention. An
  // open one with unsaved changes isn't read until then.
  for (let after = ''; ;) {
    const candidates = await db.execute<{ id: string; page_id: string; space_id: string }>(sql`
      select s.id, s.page_id, s.space_id from ${liveSessions} s
      where s.id > ${after} and (
        (s.ended_at is not null and s.ended_at <= now() - ${retention})
        or (s.ended_at is not null
          and (s.kept_at is null or s.kept_at <= now() - interval '10 minutes'))
        or (s.ended_at is null and not exists (select 1 from ${liveJoins} j
          where j.session_id = s.id and j.parent_join_id is null and j.left_at is null
            and j.last_message_at > now() - interval '30 seconds'
            and (j.stream_broke_at is null or j.stream_broke_at > now() - interval '30 seconds'))
          and (s.last_update_position <= coalesce(s.saved_covers, 0)
            or not exists (select 1 from ${liveJoins} j
              where j.session_id = s.id and least(coalesce(j.left_at, 'infinity'),
                j.last_message_at + interval '30 seconds') > now() - ${retention}))))
      order by s.id limit 500`);
    const last = candidates.at(-1);
    if (!last) return removed;
    after = last.id;
    removed += await sweepSome(db, candidates, retentionMs);
  }
}

async function sweepSome(
  db: Database,
  candidates: readonly { id: string; page_id: string; space_id: string }[],
  retentionMs: number,
) {
  let removed = 0;
  for (const { id, page_id: pageId, space_id: spaceId } of candidates) {
    // Read first; only one that is due takes the locks, and is checked again under them.
    const read = await readSnapshot(db, async (tx) => {
      const [session] = await tx.select().from(liveSessions).where(eq(liveSessions.id, id));
      if (!session) return null;
      const now = await dbNow(tx);
      const due = await dueToGo(tx, session, now, retentionMs);
      if (due || session.endedReason === null) return { due, keep: null };
      // Kept: noted when nobody is in it, so the next passes leave it a while.
      const joins = await joinsOf(tx, session.id);
      const present = presentSet(joins, now);
      return {
        due,
        keep: {
          settled: !joins.some((j) => !j.catchUp && present.has(joinKey(j.identityId, j.joinId))),
        },
      };
    });
    if (!read) continue;
    if (!read.due) {
      if (read.keep) {
        await db
          .update(liveSessions)
          .set({ keptAt: read.keep.settled ? sql`now()` : null })
          .where(eq(liveSessions.id, id));
      }
      continue;
    }
    const gone = await db.transaction(async (tx) => {
      await lockSpace(tx, spaceId).catch(() => {});
      await requirePage(tx, pageId, { lock: true }).catch(() => {});
      const [session] = await tx
        .select()
        .from(liveSessions)
        .where(eq(liveSessions.id, id))
        .for('update');
      if (!session) return false;
      const why = await dueToGo(tx, session, await dbNow(tx), retentionMs);
      if (!why) return false;
      await tx.delete(liveSessions).where(eq(liveSessions.id, id));
      return true;
    });
    if (gone) removed++;
  }
  return removed;
}
