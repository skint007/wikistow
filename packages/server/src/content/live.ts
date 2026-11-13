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
  SealedLive,
  type PublicIdentity,
} from '@wikistow/contracts';
import {
  hash,
  metadataEnvelopeV2Bytes,
  metadataRecordV2Bytes,
  sealedBytes,
  verifySignature,
} from '@wikistow/client';
import { and, asc, desc, eq, gt, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import type { Database } from '../db/client.ts';
import {
  appRateLimits,
  commentVersions,
  liveEnvelopes,
  liveGrants,
  liveJoins,
  liveMessages,
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
import { charge } from './quota.ts';
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
  if (join.lastMessageAt.getTime() + GRACE_MS <= at) return false;
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
  const times = [join.lastMessageAt.getTime() + GRACE_MS];
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

/** Whether a session's record takes `versionId`, for names' and comments' versions to refuse it. */
export async function isLiveVersion(tx: Database, versionId: string) {
  const [taken] = await tx
    .select({ id: liveSessions.id })
    .from(liveSessions)
    .where(eq(liveSessions.versionId, versionId));
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
) {
  if (limit === null || bytes === 0) return;
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

/** Charge stored messages to their sender's storage (`storage-full`) and minute (`rate-limited`). */
async function chargeStored(
  tx: Database,
  caller: Caller,
  bytes: number,
  limits: { storageBytes: number; storedBytesPerMinute: number | null },
) {
  if (bytes === 0) return;
  await spendStoredBytes(tx, caller.accountId, bytes, limits.storedBytesPerMinute);
  await charge(tx, caller.accountId, bytes, limits.storageBytes);
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
 * catch-up's grant lapses only with its join.
 */
function lapsed(
  grant: GrantRow,
  {
    present,
    now,
    heads,
    sessionId,
  }: { present: Set<string>; now: Date; heads: Heads; sessionId: string },
) {
  if (grant.lapsedAt !== null) return true;
  if (grant.position !== null) return false;
  if (!present.has(joinKey(grant.identityId, grant.joinId))) return true;
  if (grant.subject === sessionId) return false;
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
 * grant lapsed, a join of theirs gets it next only while no other person
 * has a join present, so one member can't hold the session's saves up by
 * taking it again and again.
 */
async function takeGrant(
  tx: Database,
  session: SessionRow,
  subject: string,
  holder: JoinRow,
  { joins, now, heads }: { joins: JoinRow[]; now: Date; heads: Heads },
) {
  const present = presentSet(joins, now);
  const grants = await tx
    .select()
    .from(liveGrants)
    .where(and(eq(liveGrants.sessionId, session.id), eq(liveGrants.subject, subject)))
    .orderBy(desc(liveGrants.id));
  const placed = grants.find((g) => g.position !== null);
  if (placed) return { grant: placed, lapsed: false };
  const at = { present, now, heads, sessionId: session.id };
  for (const grant of grants) {
    if (grant.lapsedAt === null && lapsed(grant, at)) {
      await tx.update(liveGrants).set({ lapsedAt: now }).where(eq(liveGrants.id, grant.id));
      grant.lapsedAt = now;
    }
  }
  const held = grants.find((g) => g.lapsedAt === null);
  if (held) return { grant: held, lapsed: false };
  // The person whose grant lapsed last waits while anyone else could ask.
  const latest = grants[0];
  const othersHere = joins.some(
    (j) => j.identityId !== holder.identityId && present.has(joinKey(j.identityId, j.joinId)),
  );
  if (latest && latest.identityId === holder.identityId && othersHere) {
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
    })
    .returning();
  if (!given) throw new Error('grant insert returned nothing');
  return { grant: given, lapsed: false, changed: true };
}

// --- Serving ---------------------------------------------------------------

/** Bytes of stored messages one fetch of a session serves at most; the stream serves the rest. */
const SERVED_MESSAGE_BYTES = 8 * 1024 * 1024;

async function servedSession(
  tx: Database,
  session: SessionRow,
  {
    identity,
    heads,
    now,
    report,
  }: { identity: PublicIdentity; heads: Heads; now: Date; report: ReportUnreadable },
): Promise<liveRoutes.ServedSession | null> {
  const row = { table: 'live_sessions', id: session.id };
  const record = readStored(SealedLive, session.sealed, row, report);
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
  const latestRows =
    latest.length === 0
      ? []
      : await tx
          .select()
          .from(liveMessages)
          .where(
            and(eq(liveMessages.sessionId, session.id), inArray(liveMessages.position, latest)),
          )
          .orderBy(asc(liveMessages.position));
  const messages: liveRoutes.StoredMessage[] = [];
  let bytes = 0;
  let position = base;
  let complete = true;
  for (let after = base; complete;) {
    const batch = await tx
      .select()
      .from(liveMessages)
      .where(and(eq(liveMessages.sessionId, session.id), gt(liveMessages.position, after)))
      .orderBy(asc(liveMessages.position))
      .limit(200);
    if (batch.length === 0) break;
    for (const message of batch) {
      after = message.position;
      if (pinned.includes(message.position)) {
        position = message.position;
        continue;
      }
      if (bytes + message.size > SERVED_MESSAGE_BYTES && messages.length > 0) {
        complete = false;
        break;
      }
      bytes += message.size;
      const served = servedMessage(message, report);
      if (served) messages.push(served);
      position = message.position;
    }
  }
  if (complete) position = session.lastPosition;
  const joins = await joinsOf(tx, session.id);
  const present = presentSet(joins, now);
  const grants = await tx
    .select()
    .from(liveGrants)
    .where(
      and(
        eq(liveGrants.sessionId, session.id),
        or(
          sql`${liveGrants.givenAfter} >= ${base}`,
          heads.draftHead === null ? sql`false` : eq(liveGrants.subject, heads.draftHead),
        ),
      ),
    )
    .orderBy(asc(liveGrants.id));
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
    grants: grants.map((g) =>
      servedGrant(g, lapsed(g, { present, now, heads, sessionId: session.id })),
    ),
  };
}

/** Whether an ended session holds an `update` after the position its latest `saved` covers. */
const unsaved = (session: SessionRow) => session.lastUpdatePosition > (session.savedCovers ?? 0);

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
    const sessions = await tx
      .select()
      .from(liveSessions)
      .where(eq(liveSessions.pageId, page.id))
      .orderBy(desc(liveSessions.createdAt));
    const at = { identity: caller.identity, heads, now, report };
    const openRow = sessions.find((s) => s.endedAt === null);
    let ended: liveRoutes.ServedSession | null = null;
    for (const session of sessions) {
      if (session.endedAt === null || !unsaved(session)) continue;
      if (presentSet(await joinsOf(tx, session.id), now).size > 0) continue;
      ended = await servedSession(tx, session, at);
      break;
    }
    return {
      open: openRow ? await servedSession(tx, openRow, at) : null,
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
  metadata: SealedLive;
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
    await chargeStored(tx, caller, size + payload.ciphertext.length, input);
    await tx.insert(liveSessions).values({
      id: input.sessionId,
      spaceId: page.spaceId,
      pageId: page.id,
      versionId: record.metadataRevisionId,
      revisionId: input.revisionId,
      sealed: input.metadata,
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
  | { ended: liveRoutes.EndReason; draftHead: string | null }
  | {
      ended: null;
      pageId: string;
      identityId: string;
      joinId: string;
      joins: liveRoutes.Join[];
      draftHead: string | null;
      lastPosition: number;
    };

/**
 * Open the stream as `joinId` (section 5.10, **Serving and relaying**): a
 * new join of the caller's, or one still present, resumed. A join of the
 * caller's that has gone is `not-found`, and so is a further join, which
 * has no stream. `after` past the last position is `invalid-request`, and
 * below what the latest later snapshot covers, whose messages are gone,
 * `stale-head`. An ended session makes no join.
 */
export async function joinLive(
  db: Database,
  input: { actor: Actor; sessionId: string; joinId: string; after: number },
): Promise<Joined> {
  return db.transaction(async (tx) => {
    const { caller, page, session } = await sessionFor(tx, input.actor, input.sessionId, {
      lock: true,
    });
    const heads = await headsOf(tx, page.id);
    if (session.endedReason !== null) {
      return { ended: session.endedReason, draftHead: heads.draftHead };
    }
    if (input.after > session.lastPosition) {
      throw new ContentError('invalid-request', 'That position is past the session’s last');
    }
    if (session.snapshotCovers !== null && input.after < session.snapshotCovers) {
      throw new ContentError('stale-head', 'A snapshot has covered what you missed; join afresh', {
        draftHead: heads.draftHead,
        publishedHead: heads.publishedHead,
      });
    }
    const now = await dbNow(tx);
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
        .set({ streamOpen: true, streamBrokeAt: null, lastMessageAt: now })
        .where(
          and(
            eq(liveJoins.sessionId, session.id),
            eq(liveJoins.identityId, mine.identityId),
            eq(liveJoins.joinId, mine.joinId),
          ),
        );
    } else {
      requireRoomForJoin(joins, present, caller.identity.id);
      await tx.insert(liveJoins).values({
        sessionId: session.id,
        identityId: caller.identity.id,
        joinId: input.joinId,
        keyVersion: caller.identity.keyVersion,
        accountId: caller.accountId,
        ordinal: session.joinsMade + 1,
        streamOpen: true,
        lastMessageAt: now,
      });
      await tx
        .update(liveSessions)
        .set({ joinsMade: session.joinsMade + 1 })
        .where(eq(liveSessions.id, session.id));
    }
    await tx.update(liveSessions).set({ activeAt: now }).where(eq(liveSessions.id, session.id));
    return {
      ended: null,
      pageId: page.id,
      identityId: caller.identity.id,
      joinId: input.joinId,
      joins: servedJoins(await joinsOf(tx, session.id), now),
      draftHead: heads.draftHead,
      lastPosition: session.lastPosition,
    };
  });
}

/** A person's ninth present join of one session is refused (`rate-limited`). */
function requireRoomForJoin(joins: readonly JoinRow[], present: Set<string>, identityId: string) {
  const mine = joins.filter(
    (j) => j.identityId === identityId && present.has(joinKey(j.identityId, j.joinId)),
  );
  if (mine.length >= liveRoutes.MAX_JOINS_PER_PERSON) {
    throw new ContentError('busy', 'You are in this session too many times at once');
  }
}

/** A stream of `joinId` broke: the join stays present for 30 s more at most. */
export async function streamClosed(
  db: Database,
  input: { sessionId: string; identityId: string; joinId: string },
) {
  await db
    .update(liveJoins)
    .set({ streamOpen: false, streamBrokeAt: sql`now()` })
    .where(
      and(
        eq(liveJoins.sessionId, input.sessionId),
        eq(liveJoins.identityId, input.identityId),
        eq(liveJoins.joinId, input.joinId),
        eq(liveJoins.streamOpen, true),
      ),
    );
}

/**
 * The join a request comes from: the caller's join `joinId` if it is
 * present (or, in an ended session, if it exists at all), or a further
 * join of the caller's present join `parent`, made now: at most two of
 * those present at once, and at most eight joins of the person's.
 */
async function joinFor(
  tx: Database,
  { caller, session }: { caller: Caller; session: SessionRow },
  { joinId, parent }: { joinId: string; parent?: string | undefined },
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
    if (session.endedReason === null && !present.has(joinKey(mine.identityId, mine.joinId))) {
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
  // Served, and so caught up from, only once every join has left (section 5.10, **Ending**).
  if (present.size > 0) throw new ContentError('not-found');
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
  stored: liveRoutes.StoredMessage[];
  presence: LiveMessage[];
  grants: liveRoutes.Grant[];
  joinsChanged: boolean;
  /** The session went with this request: a catch-up finished. */
  deleted: boolean;
  draftHead: string | null;
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

async function saveCounters(tx: Database, session: SessionRow, join: JoinRow, now: Date) {
  await tx
    .update(liveSessions)
    .set({
      lastPosition: session.lastPosition,
      lastUpdatePosition: session.lastUpdatePosition,
      savedCovers: session.savedCovers,
      snapshotPosition: session.snapshotPosition,
      snapshotCovers: session.snapshotCovers,
      activeAt: now,
    })
    .where(eq(liveSessions.id, session.id));
  await tx
    .update(liveJoins)
    .set({ lastSeq: join.lastSeq, lastMessageAt: now })
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
    const { join, joins, made } = catchingUp
      ? await catchUpJoin(tx, ctx, input.joinId, now)
      : await joinFor(tx, ctx, input, now);
    const relay: Relay = {
      sessionId: session.id,
      pageId: page.id,
      stored: [],
      presence: [],
      grants: [],
      joinsChanged: made,
      deleted: false,
      draftHead: null,
    };
    const positions: (number | null)[] = [];
    const updates: number[] = [];
    let savedAt: number | null = null;
    let bytes = 0;
    for (const { message, covers } of input.messages) {
      const size = checkMessage(message, caller, join.joinId);
      if (ended && message.kind !== 'saved') {
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
        if (message.seq !== join.lastSeq) {
          throw new ContentError('invalid-request', 'A presence carries its join’s last seq');
        }
        relay.presence.push(message);
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
      positions.push(stored.position);
      if (!stored.row) continue;
      bytes += size;
      const served = servedMessage(stored.row, ignore);
      if (served) relay.stored.push(served);
      if (message.kind === 'update') updates.push(stored.row.position);
      if (message.kind === 'saved') savedAt = stored.row.position;
    }
    await chargeStored(tx, caller, bytes, input);
    await saveCounters(tx, session, join, now);
    const heads = await headsOf(tx, page.id);
    relay.draftHead = heads.draftHead;
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
        savedAt,
        relay,
      });
    }
    return { positions, grant, relay };
  });
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
    savedAt: number | null;
    relay: Relay;
  },
): Promise<liveRoutes.Grant> {
  const present = presentSet(joins, now);
  const at = { present, now, heads, sessionId: session.id };
  if (catchingUp) {
    const taken = await takeGrant(tx, session, session.id, join, { joins, now, heads });
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
    throw new ContentError('forbidden', 'This session has ended');
  }
  if (fold === session.id) {
    throw new ContentError('invalid-request', 'An open session isn’t caught up from');
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
        eq(liveGrants.identityId, join.identityId),
        eq(liveGrants.joinId, join.parentJoinId),
        isNull(liveGrants.position),
        isNull(liveGrants.lapsedAt),
      ),
    )
    .orderBy(desc(liveGrants.id))
    .limit(1);
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
    if (session.endedReason !== null) {
      throw new ContentError('forbidden', 'This session has ended');
    }
    const now = await dbNow(tx);
    const { join, made } = await joinFor(tx, ctx, input, now);
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
    await chargeStored(tx, caller, size, input);
    const position = stored.row.position;
    // What it covers goes, but the first snapshot and each join's latest kept change.
    await tx.execute(sql`
      delete from ${liveMessages} m
      where m.session_id = ${session.id} and m.position <= ${input.covers} and m.position <> 1
        and m.kind in ('update', 'saved')
        and exists (select 1 from ${liveMessages} n
          where n.session_id = m.session_id and n.identity_id = m.identity_id
            and n.join_id = m.join_id and n.kind in ('update', 'saved')
            and n.position > m.position and n.position <= ${input.covers})`);
    await tx.execute(sql`
      delete from ${liveMessages}
      where session_id = ${session.id} and kind = 'snapshot' and position <> 1
        and position < ${position}`);
    session.snapshotPosition = position;
    session.snapshotCovers = input.covers;
    await saveCounters(tx, session, join, now);
    const served = servedMessage(stored.row, ignore);
    const relay: Relay = {
      sessionId: session.id,
      pageId: page.id,
      stored: served ? [served] : [],
      presence: [],
      grants: [],
      joinsChanged: made,
      deleted: false,
      draftHead: heads.draftHead,
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
    if (left.length > 0) {
      await tx
        .update(liveSessions)
        .set({ activeAt: sql`now()` })
        .where(eq(liveSessions.id, session.id));
    }
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
      .set({ endedAt: sql`now()`, endedReason: 'ended', activeAt: sql`now()` })
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
    const present = presentSet(joins, now);
    const grants = heads
      ? await tx
          .select()
          .from(liveGrants)
          .where(
            and(
              eq(liveGrants.sessionId, session.id),
              sql`${liveGrants.givenAfter} >= ${session.snapshotCovers ?? 0}`,
            ),
          )
          .orderBy(asc(liveGrants.id))
      : [];
    return {
      ended: session.endedReason,
      pageId: session.pageId,
      lastPosition: session.lastPosition,
      snapshotCovers: session.snapshotCovers ?? 0,
      draftHead: heads?.draftHead ?? null,
      joins: servedJoins(joins, now),
      grants: heads
        ? grants.map((g) =>
            servedGrant(g, lapsed(g, { present, now, heads, sessionId: session.id })),
          )
        : [],
    };
  });
}

/** Stored messages of a session after `after`, oldest first, at most `limit`. */
export async function storedAfter(
  db: Database,
  sessionId: string,
  after: number,
  { limit = 200, upTo }: { limit?: number; upTo?: number } = {},
) {
  const rows = await db
    .select()
    .from(liveMessages)
    .where(
      and(
        eq(liveMessages.sessionId, sessionId),
        gt(liveMessages.position, after),
        upTo === undefined ? undefined : lte(liveMessages.position, upTo),
      ),
    )
    .orderBy(asc(liveMessages.position))
    .limit(limit);
  return rows.flatMap((row) => {
    const served = servedMessage(row, ignore);
    return served ? [served] : [];
  });
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
 * Whether the keys a session's record is under still count: in a share,
 * its wrap is the page's share's at the current key version; in the owner
 * region, the page is still there and every envelope is to an owner now.
 * After a rotation or a move to another region nobody's do.
 */
async function keysCount(tx: Database, session: SessionRow) {
  const share = await shareAt(tx, session.spaceId, session.pageId);
  const [wrap] = await tx.select().from(liveWraps).where(eq(liveWraps.sessionId, session.id));
  if (wrap) {
    if (!share || share.id !== wrap.shareId) return false;
    const [current] = await tx
      .select({ keyVersion: shares.currentKeyVersion })
      .from(shares)
      .where(eq(shares.id, share.id));
    return current?.keyVersion === wrap.keyVersion;
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
  return recipients.every((r) => owners.has(r.id));
}

/** Why a session should go now, if it should (section 5.10, **Ending**). */
async function dueToGo(tx: Database, session: SessionRow, now: Date, retentionMs: number) {
  const joins = await joinsOf(tx, session.id);
  if (presentSet(joins, now).size > 0) return null;
  if (session.activeAt.getTime() + retentionMs <= now.getTime()) return 'retention';
  if (session.endedReason === null) {
    const lastGone = Math.max(0, ...joins.map(goneAt));
    if (lastGone + EMPTY_MS > now.getTime()) return null;
    return unsaved(session) ? null : 'saved';
  }
  if (!unsaved(session)) return 'saved';
  if (!(await keysCount(tx, session))) return 'keys';
  return null;
}

/**
 * Delete sessions whose time is up (section 5.10, **Ending**): an open one
 * a minute after its last join left, if no `update` came after what its
 * latest `saved` covers; an ended one once every join has left, unless an
 * `update` came after it and its keys still count; and any kept past the
 * draft retention since anything last happened in it. Each is checked
 * again under the locks a message takes. Returns how many went.
 */
export async function sweepLive(
  db: Database,
  { retentionMs }: { retentionMs: number },
): Promise<number> {
  const candidates = await db.execute<{ id: string; page_id: string; space_id: string }>(sql`
    select s.id, s.page_id, s.space_id from ${liveSessions} s
    where not exists (select 1 from ${liveJoins} j
      where j.session_id = s.id and j.parent_join_id is null and j.left_at is null
        and j.last_message_at > now() - interval '30 seconds'
        and (j.stream_broke_at is null or j.stream_broke_at > now() - interval '30 seconds'))
    order by s.id limit 1000`);
  let removed = 0;
  for (const { id, page_id: pageId, space_id: spaceId } of candidates) {
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
