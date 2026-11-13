import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { timestamptz } from './helpers.ts';
import { identities } from './identities.ts';
import { shares } from './shares.ts';
import { nodes, spaces } from './spaces.ts';
import { users } from './users.ts';

const position = () => bigint({ mode: 'number' });

/**
 * Live sessions on pages (protocol section 5.10), as the server keeps them:
 * the record as signed, which nothing edits, the draft it started from,
 * and what the server decides alone: positions, who is there, and when
 * it ends. A session isn't a retained record: it goes once everyone has
 * left and everything in it is saved, or after the draft retention. The
 * database ends a page's open session in the transaction that moves the
 * page's permission version (the `nodes_live_end` trigger).
 */
export const liveSessions = pgTable(
  'live_sessions',
  {
    id: text().primaryKey(),
    spaceId: text().notNull(),
    pageId: text()
      .notNull()
      .references(() => nodes.id, { onDelete: 'cascade' }),
    /** The record's `metadataRevisionId`, in the one set of metadata and comment version IDs. */
    versionId: text().notNull().unique(),
    /** The draft it started from, which draft retention keeps while the session is kept. */
    revisionId: text().notNull(),
    /** The SealedLive (record, signature, payload) as its starter signed it. */
    sealed: jsonb().notNull(),
    /** The ciphertext's length, which counts toward its starter's storage. */
    payloadSize: integer()
      .notNull()
      .generatedAlwaysAs(sql`length(sealed -> 'payload' ->> 'ciphertext')`),
    /**
     * Its region when it started: the share its wrap is under and the wrap's
     * key version, or null for the owner region. Kept here, not only by the
     * wrap, which goes with its share when the share ends.
     */
    shareId: text(),
    keyVersion: integer(),
    starterIdentityId: text().notNull(),
    starterAccountId: uuid().references(() => users.id, { onDelete: 'set null' }),
    /** Joins made so far, which numbers them in the order they were made. */
    joinsMade: integer().notNull().default(0),
    /** The last position given to a stored message. */
    lastPosition: position().notNull().default(0),
    /** The position of the latest stored `update`, 0 for none. */
    lastUpdatePosition: position().notNull().default(0),
    /** What the latest `saved` covers, as its sender named it, or null for none yet. */
    savedCovers: position(),
    /** The latest later snapshot's position and what it covers, or null for none. */
    snapshotPosition: position(),
    snapshotCovers: position(),
    createdAt: timestamptz().notNull().defaultNow(),
    endedAt: timestamptz(),
    endedReason: text({ enum: ['access', 'ended'] }),
  },
  (table) => [
    check('live_sessions_id_shape', sql`${table.id} ~ '^[A-Za-z0-9_-]{1,64}$'`),
    check('live_sessions_version_id_shape', sql`${table.versionId} ~ '^[A-Za-z0-9_-]{1,64}$'`),
    check('live_sessions_ended', sql`(${table.endedAt} is null) = (${table.endedReason} is null)`),
    check('live_sessions_region', sql`(${table.shareId} is null) = (${table.keyVersion} is null)`),
    // A page has at most one open session.
    uniqueIndex('live_sessions_open_page_idx')
      .on(table.pageId)
      .where(sql`${table.endedAt} is null`),
    index('live_sessions_page_idx').on(table.pageId),
    index('live_sessions_revision_idx').on(table.revisionId),
    index('live_sessions_starter_account_idx').on(table.starterAccountId),
  ],
);

/**
 * Every session ID and record version ID taken, kept when the session goes,
 * so the server keeps session IDs unique across the installation and no
 * later metadata, comment or session version takes a session's version ID
 * (protocol section 5.10). It goes with its space or its starter's account,
 * and counts toward the starter's storage (`LIVE_ID_BYTES` a row).
 */
export const liveSessionIds = pgTable(
  'live_session_ids',
  {
    id: text().primaryKey(),
    versionId: text().notNull().unique(),
    spaceId: text()
      .notNull()
      .references(() => spaces.id, { onDelete: 'cascade' }),
    starterAccountId: uuid().references(() => users.id, { onDelete: 'cascade' }),
    createdAt: timestamptz().notNull().defaultNow(),
  },
  (table) => [
    index('live_session_ids_space_idx').on(table.spaceId),
    index('live_session_ids_starter_account_idx').on(table.starterAccountId),
  ],
);

/**
 * What live rows count toward their account's storage besides their
 * ciphertext, about what each takes on disk with its indexes: a used
 * session ID, a stored message and a join. The `live_usage` triggers
 * keep the sums (migration 0050).
 */
export const LIVE_ID_BYTES = 256;
export const LIVE_MESSAGE_BYTES = 1024;
export const LIVE_JOIN_BYTES = 512;

/**
 * Each account's live sessions' storage, kept by triggers as rows come and
 * go: records it signed and used session IDs it took, as starter; stored
 * messages and joins, as sender. So a quota check reads one row rather than
 * summing every message.
 */
export const liveUsage = pgTable('live_usage', {
  accountId: uuid()
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  bytes: bigint({ mode: 'number' }).notNull().default(0),
});

/**
 * A session's key wrap in a share (section 5.10, **The session record**),
 * under the share's draft key, kept apart from other wraps: no scan lists
 * it, and no operation wraps it again.
 */
export const liveWraps = pgTable(
  'live_wraps',
  {
    sessionId: text()
      .primaryKey()
      .references(() => liveSessions.id, { onDelete: 'cascade' }),
    shareId: text()
      .notNull()
      .references(() => shares.id, { onDelete: 'cascade' }),
    keyVersion: integer().notNull(),
    wrap: jsonb().notNull(),
  },
  (table) => [index('live_wraps_share_idx').on(table.shareId)],
);

/** A session's key sealed to one owner outside shares, as a v2 metadata envelope stored as sent. */
export const liveEnvelopes = pgTable(
  'live_envelopes',
  {
    sessionId: text()
      .notNull()
      .references(() => liveSessions.id, { onDelete: 'cascade' }),
    recipientIdentityId: text().notNull(),
    recipientKeyVersion: integer().notNull(),
    envelope: jsonb().notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.sessionId, table.recipientIdentityId, table.recipientKeyVersion],
    }),
    foreignKey({
      columns: [table.recipientIdentityId, table.recipientKeyVersion],
      foreignColumns: [identities.id, identities.keyVersion],
    }),
  ],
);

/**
 * The joins of a session, past and present: `(identityId, joinId)`, as
 * section 5.10 names a join, with the key version it sends under. A join
 * is present until it leaves, or 30 s after its last message or after its
 * stream broke, whichever is sooner; a further join (`parentJoinId`) also
 * goes when its parent goes. A catch-up join is one made in an ended
 * session to catch up from it, which sends nothing but its `saved`.
 */
export const liveJoins = pgTable(
  'live_joins',
  {
    sessionId: text()
      .notNull()
      .references(() => liveSessions.id, { onDelete: 'cascade' }),
    identityId: text().notNull(),
    joinId: text().notNull(),
    keyVersion: integer().notNull(),
    accountId: uuid().references(() => users.id, { onDelete: 'set null' }),
    ordinal: integer().notNull(),
    parentJoinId: text(),
    catchUp: boolean().notNull().default(false),
    /** The `seq` of its last stored message, 0 for none. */
    lastSeq: bigint({ mode: 'number' }).notNull().default(0),
    lastMessageAt: timestamptz().notNull().defaultNow(),
    /** Whether a stream of this server's is open for it now, and which one. */
    streamOpen: boolean().notNull().default(false),
    streamToken: text(),
    streamBrokeAt: timestamptz(),
    leftAt: timestamptz(),
    createdAt: timestamptz().notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.sessionId, table.identityId, table.joinId] }),
    check('live_joins_join_id_shape', sql`${table.joinId} ~ '^[A-Za-z0-9_-]{1,64}$'`),
    index('live_joins_account_idx').on(table.accountId),
  ],
);

/**
 * The stored messages of a session (`update`, `snapshot`, `saved`), as
 * signed and sealed, numbered by position; never presence, which the
 * server keeps only in memory. A snapshot deletes what it covers but the
 * first snapshot and each join's latest `update` or `saved`. Each counts
 * toward its sender's storage until the session goes.
 */
export const liveMessages = pgTable(
  'live_messages',
  {
    sessionId: text()
      .notNull()
      .references(() => liveSessions.id, { onDelete: 'cascade' }),
    position: position().notNull(),
    kind: text({ enum: ['update', 'snapshot', 'saved'] }).notNull(),
    identityId: text().notNull(),
    joinId: text().notNull(),
    seq: bigint({ mode: 'number' }).notNull(),
    /** The sender's account, charged for it. */
    accountId: uuid().references(() => users.id, { onDelete: 'set null' }),
    /** The LiveMessage as sent. */
    message: jsonb().notNull(),
    /** Bytes of ciphertext, decoded. */
    size: integer().notNull(),
    covers: position(),
    /** The draft a snapshot names in the clear, which draft retention keeps. */
    revisionId: text(),
    createdAt: timestamptz().notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.sessionId, table.position] }),
    uniqueIndex('live_messages_seq_idx').on(
      table.sessionId,
      table.identityId,
      table.joinId,
      table.seq,
    ),
    index('live_messages_account_idx').on(table.accountId),
    index('live_messages_revision_idx')
      .on(table.revisionId)
      .where(sql`${table.revisionId} is not null`),
  ],
);

/**
 * Fold grants (section 5.10, **Saving**): one join at a time folds an
 * outsider's draft, `subject` its revision ID, or catches up from an ended
 * session, `subject` that session's ID. A grant lapses when its join goes,
 * or 30 s after it was given unplaced while its revision is the draft
 * head; `lapsedAt` records it once the server sees it.
 */
export const liveGrants = pgTable(
  'live_grants',
  {
    id: bigint({ mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    sessionId: text()
      .notNull()
      .references(() => liveSessions.id, { onDelete: 'cascade' }),
    subject: text().notNull(),
    identityId: text().notNull(),
    joinId: text().notNull(),
    /** The position after which it was given, so a newcomer lists those since its snapshot. */
    givenAfter: position().notNull(),
    grantedAt: timestamptz().notNull().defaultNow(),
    /** Its `update`'s position once placed, or for a catch-up its `saved`'s. */
    position: position(),
    lapsedAt: timestamptz(),
  },
  (table) => [index('live_grants_session_idx').on(table.sessionId, table.subject)],
);
