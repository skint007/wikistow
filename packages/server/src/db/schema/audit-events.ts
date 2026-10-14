import { sql } from 'drizzle-orm';
import { check, index, jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { primaryId, timestamptz } from './helpers.ts';
import { users } from './users.ts';

/**
 * Administrative actions: who did what to which record, and when. `details`
 * holds only IDs and enum values, validated per action, never names or content.
 */
export const auditEvents = pgTable(
  'audit_events',
  {
    id: primaryId(),
    occurredAt: timestamptz().notNull().defaultNow(),
    /** Null for operator commands, or once the acting account is deleted. */
    actorKind: text({ enum: ['account', 'operator'] }).notNull(),
    actorAccountId: uuid().references(() => users.id, { onDelete: 'set null' }),
    action: text().notNull(),
    targetKind: text().notNull(),
    targetId: text().notNull(),
    details: jsonb().notNull().default({}),
  },
  (table) => [
    check('audit_events_actor_kind', sql`${table.actorKind} in ('account', 'operator')`),
    index('audit_events_occurred_at_idx').on(table.occurredAt),
  ],
);
