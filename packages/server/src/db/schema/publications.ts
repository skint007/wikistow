import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { timestamptz } from './helpers.ts';
import { nodes, spaces } from './spaces.ts';
import { users } from './users.ts';

/**
 * Pages published into another space (protocol section 13): the
 * destination page, and the source page and space it copies chosen
 * versions of. This is visible metadata (A7), as is the source version each
 * send names (`revisions.sourceRevisionId`); the source's names, and which
 * version each copy came from as the publisher signed it, live only in the
 * destination's encrypted payloads. A source page has at most one live
 * publication in each other space. Detaching ends it, and the row stays
 * with `detachedAt` set. The source isn't a foreign key: deleting the
 * source page ends its publications, and leaves its copies as they are.
 *
 * Until its first version arrives, the destination page has no heads row,
 * so nobody sees it: it exists only so its attachments can be uploaded.
 */
export const publications = pgTable(
  'publications',
  {
    destinationPageId: text()
      .primaryKey()
      .references(() => nodes.id, { onDelete: 'cascade' }),
    destinationSpaceId: text()
      .notNull()
      .references(() => spaces.id, { onDelete: 'cascade' }),
    sourceSpaceId: text().notNull(),
    sourcePageId: text().notNull(),
    /** The source version the latest copy was made from; null until the first arrives. */
    lastSourceRevisionId: text(),
    createdBy: uuid().references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamptz().notNull().defaultNow(),
    detachedAt: timestamptz(),
  },
  (table) => [
    check('publications_other_space', sql`${table.sourceSpaceId} <> ${table.destinationSpaceId}`),
    uniqueIndex('publications_one_live')
      .on(table.sourcePageId, table.destinationSpaceId)
      .where(sql`${table.detachedAt} is null`),
    index('publications_destination_space_idx').on(table.destinationSpaceId),
    index('publications_source_page_idx').on(table.sourcePageId),
  ],
);
