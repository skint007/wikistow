import { sql } from 'drizzle-orm';
import { check, index, integer, jsonb, pgTable, text, unique } from 'drizzle-orm/pg-core';
import { timestamptz } from './helpers.ts';
import { spaces } from './spaces.ts';

/**
 * Immutable versions of encrypted space and folder metadata, stored exactly
 * as signed. Two renames can't both build on the same version: the unique
 * (subject, basedOn) pair turns the loser into a conflict.
 */
export const metadataRevisions = pgTable(
  'metadata_revisions',
  {
    id: text().primaryKey(),
    spaceId: text()
      .notNull()
      .references(() => spaces.id, { onDelete: 'cascade' }),
    subjectKind: text({ enum: ['space', 'folder'] }).notNull(),
    subjectId: text().notNull(),
    basedOn: text(),
    authorIdentityId: text().notNull(),
    authorKeyVersion: integer().notNull(),
    /** The SealedMetadata (record, signature, payload) as the client signed it. */
    sealed: jsonb().notNull(),
    /** The ciphertext's length, which counts toward its author's storage. */
    payloadSize: integer()
      .notNull()
      .generatedAlwaysAs(sql`length(sealed -> 'payload' ->> 'ciphertext')`),
    createdAt: timestamptz().notNull().defaultNow(),
  },
  (table) => [
    check('metadata_revisions_id_shape', sql`${table.id} ~ '^[A-Za-z0-9_-]{1,64}$'`),
    unique('metadata_revisions_one_successor')
      .on(table.subjectKind, table.subjectId, table.basedOn)
      .nullsNotDistinct(),
    index('metadata_revisions_space_idx').on(table.spaceId),
    // For the author's storage total.
    index('metadata_revisions_author_idx').on(table.authorIdentityId, table.authorKeyVersion),
  ],
);
