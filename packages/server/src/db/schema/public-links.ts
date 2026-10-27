import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import type { PublicCover } from '../../public-links/cover.ts';
import type { Outline, Segment } from '../../public-links/segments.ts';
import { bytea, timestamptz } from './helpers.ts';
import { nodes } from './spaces.ts';
import { users } from './users.ts';

// Public links (ADR 0005): the one place the server keeps page content
// readable. Everything here goes with the link, by cascade, and every
// ending deletes it in its own transaction. Accounts cascade too, so
// deleting one leaves nothing readable of what it shared or uploaded.
// `backup.sh` leaves these tables' rows out of its dumps.

/**
 * A page's public link: its id, 16 random bytes in base64url, new each time
 * the link is turned on, and who turned it on. One per page.
 */
export const publicLinks = pgTable(
  'public_links',
  {
    pageId: text()
      .primaryKey()
      .references(() => nodes.id, { onDelete: 'cascade' }),
    id: text().notNull().unique(),
    sharedBy: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: timestamptz().notNull().defaultNow(),
  },
  (table) => [
    check('public_links_id_shape', sql`${table.id} ~ '^[A-Za-z0-9_-]{22}$'`),
    index('public_links_shared_by_idx').on(table.sharedBy),
  ],
);

/**
 * A readable copy of a page's published version, staged until its files
 * arrive and then live. At most one is live per page. It hangs off the
 * page's link, which hangs off the page, so it never outlives either.
 * `rendering` is the body as the server's reader rendered it, at
 * `readerVersion`, and `outline` its headings and words; `cover` is what
 * its banner and badge show, null for none; `touchedAt` is its last
 * request, for the sweep.
 */
export const publicCopies = pgTable(
  'public_copies',
  {
    id: uuid().primaryKey().defaultRandom(),
    pageId: text()
      .notNull()
      .references(() => publicLinks.pageId, { onDelete: 'cascade' }),
    revisionId: text().notNull(),
    title: text().notNull(),
    markdown: text().notNull(),
    rendering: jsonb().$type<Segment[]>().notNull(),
    outline: jsonb().$type<Outline>(),
    readerVersion: integer().notNull(),
    cover: jsonb().$type<PublicCover>(),
    uploadedBy: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    live: boolean().notNull().default(false),
    createdAt: timestamptz().notNull().defaultNow(),
    touchedAt: timestamptz().notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('public_copies_one_live')
      .on(table.pageId)
      .where(sql`${table.live}`),
    index('public_copies_page_idx').on(table.pageId),
    index('public_copies_uploaded_by_idx').on(table.uploadedBy),
  ],
);

/**
 * A copy's attachments: those its body shows or links to. `bytes` is null
 * until uploaded, and stays null for one left out for its size.
 */
export const publicFiles = pgTable(
  'public_files',
  {
    copyId: uuid()
      .notNull()
      .references(() => publicCopies.id, { onDelete: 'cascade' }),
    attachmentId: text().notNull(),
    name: text().notNull(),
    mediaType: text().notNull(),
    /** As the app declared it; the bytes may be no longer. */
    size: bigint({ mode: 'number' }).notNull(),
    bytes: bytea(),
    leftOut: boolean().notNull().default(false),
  },
  (table) => [
    primaryKey({ columns: [table.copyId, table.attachmentId] }),
    check(
      'public_files_size',
      sql`${table.bytes} is null or octet_length(${table.bytes}) <= ${table.size}`,
    ),
    check('public_files_left_out', sql`not ${table.leftOut} or ${table.bytes} is null`),
  ],
);

/**
 * A copy's links to other public pages (ADR 0005, decision 6): a gap in its
 * rendering, by key, and the page whose link it leads to. A row goes with
 * that page's link, so none names a page whose link is off.
 */
export const publicTargets = pgTable(
  'public_targets',
  {
    copyId: uuid()
      .notNull()
      .references(() => publicCopies.id, { onDelete: 'cascade' }),
    key: text().notNull(),
    targetPageId: text()
      .notNull()
      .references(() => publicLinks.pageId, { onDelete: 'cascade' }),
  },
  (table) => [
    primaryKey({ columns: [table.copyId, table.key] }),
    index('public_targets_target_idx').on(table.targetPageId),
  ],
);
