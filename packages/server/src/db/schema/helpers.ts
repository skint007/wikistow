import { timestamp, uuid } from 'drizzle-orm/pg-core';

/** A Postgres-generated UUID primary key. Better Auth runs with `generateId: false`. */
export const primaryId = () => uuid().primaryKey().defaultRandom();

export const timestamptz = () => timestamp({ withTimezone: true, mode: 'date' });

export const timestamps = {
  createdAt: timestamptz().notNull().defaultNow(),
  updatedAt: timestamptz()
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
};
