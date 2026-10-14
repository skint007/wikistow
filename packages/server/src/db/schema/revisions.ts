import { sql } from 'drizzle-orm';
import { check, index, integer, jsonb, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';
import { timestamptz } from './helpers.ts';
import { nodes } from './spaces.ts';
import { users } from './users.ts';

/**
 * Immutable page versions, stored exactly as signed. Drafts and published
 * versions are numbered separately per page; a published version's `basedOn`
 * is the exact draft it was made from.
 */
export const revisions = pgTable(
  'revisions',
  {
    id: text().primaryKey(),
    pageId: text()
      .notNull()
      .references(() => nodes.id, { onDelete: 'cascade' }),
    spaceId: text().notNull(),
    audience: text({ enum: ['draft', 'published'] }).notNull(),
    basedOn: text(),
    authorIdentityId: text().notNull(),
    authorKeyVersion: integer().notNull(),
    /** The person responsible: the author, or an agent's owner. */
    authorAccountId: uuid().references(() => users.id, { onDelete: 'set null' }),
    sealed: jsonb().notNull(),
    payloadSize: integer().notNull(),
    draftSeq: integer(),
    publishedSeq: integer(),
    /** Server-side provenance when a draft restores an earlier published version. */
    restoredFrom: text(),
    /**
     * For a copy of another page (section 13), the source version its
     * sender named. Not a foreign key: the source may be deleted.
     */
    sourceRevisionId: text(),
    createdAt: timestamptz().notNull().defaultNow(),
  },
  (table) => [
    check('revisions_id_shape', sql`${table.id} ~ '^[A-Za-z0-9_-]{1,64}$'`),
    check(
      'revisions_one_sequence',
      sql`(${table.audience} = 'draft' and ${table.draftSeq} is not null and ${table.publishedSeq} is null)
       or (${table.audience} = 'published' and ${table.publishedSeq} is not null and ${table.draftSeq} is null)`,
    ),
    unique('revisions_draft_seq').on(table.pageId, table.draftSeq),
    unique('revisions_published_seq').on(table.pageId, table.publishedSeq),
    index('revisions_page_idx').on(table.pageId),
    // For draft retention: old checkpoints, those a published version names,
    // and when each was saved over.
    index('revisions_published_based_on_idx')
      .on(table.basedOn)
      .where(sql`${table.audience} = 'published'`),
    index('revisions_draft_based_on_idx')
      .on(table.basedOn, table.createdAt)
      .where(sql`${table.audience} = 'draft'`),
    index('revisions_draft_page_created_idx')
      .on(table.pageId, table.createdAt)
      .where(sql`${table.audience} = 'draft'`),
    // Sources copies name, and copies sent before they were recorded.
    index('revisions_source_revision_idx')
      .on(table.sourceRevisionId)
      .where(sql`${table.sourceRevisionId} is not null`),
    index('revisions_unnamed_copy_idx')
      .on(table.pageId)
      .where(
        sql`${table.audience} = 'published' and ${table.basedOn} is null and ${table.sourceRevisionId} is null`,
      ),
    // For the author's storage total.
    index('revisions_author_account_idx').on(table.authorAccountId),
    // For the directory: who wrote in a space.
    index('revisions_space_author_idx').on(table.spaceId, table.authorIdentityId),
  ],
);

/**
 * One row per page: its current draft and published versions. An
 * unpublished page has no published head. Its current reader history is
 * the published versions numbered from `readerHistoryFrom` on: those stored
 * after its latest unpublish (protocol section 11).
 */
export const pageHeads = pgTable('page_heads', {
  pageId: text()
    .primaryKey()
    .references(() => nodes.id, { onDelete: 'cascade' }),
  draftHead: text(),
  publishedHead: text(),
  draftCount: integer().notNull().default(0),
  publishedCount: integer().notNull().default(0),
  readerHistoryFrom: integer().notNull().default(1),
  updatedAt: timestamptz().notNull().defaultNow(),
});
