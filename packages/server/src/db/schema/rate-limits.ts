import { bigint, doublePrecision, index, integer, pgTable, text } from 'drizzle-orm/pg-core';
import { primaryId } from './helpers.ts';

/** Better Auth's rate-limit counters, kept in Postgres so restarts don't reset them. */
export const rateLimits = pgTable('rate_limits', {
  id: primaryId(),
  key: text().notNull().unique(),
  count: integer().notNull(),
  lastRequest: bigint({ mode: 'number' }).notNull(),
});

/** Counters for the app's own public routes, which Better Auth's limiter doesn't see. */
export const appRateLimits = pgTable('app_rate_limits', {
  key: text().primaryKey(),
  windowStart: bigint({ mode: 'number' }).notNull(),
  count: integer().notNull(),
});

/**
 * Wrong-password allowances, refilled steadily: one per submitted address and
 * one per signed-in device. The hourly sweep deletes rows whose allowance is
 * full again (`sweepPasswordBudgets`).
 */
export const passwordBudgets = pgTable(
  'password_budgets',
  {
    key: text().primaryKey(),
    tokens: doublePrecision().notNull(),
    refilledAt: bigint({ mode: 'number' }).notNull(),
  },
  (table) => [index('password_budgets_refilled_at_idx').on(table.refilledAt)],
);
