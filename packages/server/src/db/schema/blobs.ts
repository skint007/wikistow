import { bigint, index, pgTable, primaryKey, text, uuid } from 'drizzle-orm/pg-core';
import { timestamptz } from './helpers.ts';
import { revisions } from './revisions.ts';
import { nodes } from './spaces.ts';
import { users } from './users.ts';

/**
 * Encrypted attachment bytes, stored as files and named by their BLAKE2b
 * hash. A blob keeps the page and audience it was uploaded for, so a draft
 * attachment can never be relabelled as published. Uploads stay staged until
 * a committed revision lists them.
 */
export const blobs = pgTable(
  'blobs',
  {
    hash: text().primaryKey(),
    spaceId: text().notNull(),
    pageId: text()
      .notNull()
      .references(() => nodes.id, { onDelete: 'cascade' }),
    audience: text({ enum: ['draft', 'published'] }).notNull(),
    size: bigint({ mode: 'number' }).notNull(),
    state: text({ enum: ['staged', 'committed'] })
      .notNull()
      .default('staged'),
    uploadedBy: uuid().references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamptz().notNull().defaultNow(),
    committedAt: timestamptz(),
  },
  (table) => [
    index('blobs_page_idx').on(table.pageId),
    // For the uploader's storage total.
    index('blobs_uploaded_by_idx').on(table.uploadedBy),
  ],
);

/** Which blobs each revision's attachments use, as declared at commit. */
export const revisionBlobs = pgTable(
  'revision_blobs',
  {
    revisionId: text()
      .notNull()
      .references(() => revisions.id, { onDelete: 'cascade' }),
    blobHash: text()
      .notNull()
      .references(() => blobs.hash, { onDelete: 'cascade' }),
  },
  (table) => [
    primaryKey({ columns: [table.revisionId, table.blobHash] }),
    index('revision_blobs_blob_idx').on(table.blobHash),
  ],
);
