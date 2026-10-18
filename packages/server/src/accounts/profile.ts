import { eq } from 'drizzle-orm';
import type { Database } from '../db/client.ts';
import { isUniqueViolation } from '../db/errors.ts';
import { THEMES, USERS_NAME_UNIQUE, users } from '../db/schema/index.ts';
import { AccountError } from './errors.ts';

export type Theme = (typeof THEMES)[number];

/** The theme is an account setting, not content, so it syncs as plain data. */
export async function setTheme(db: Database, accountId: string, theme: Theme): Promise<void> {
  await db.update(users).set({ theme }).where(eq(users.id, accountId));
}

/**
 * An account name in its stored form: trimmed, with each run of whitespace
 * inside it one space. Names are unique ignoring case (`USERS_NAME_UNIQUE`).
 */
export const normalizeName = (name: string): string => name.trim().replace(/\s+/g, ' ');

/**
 * Run a write that sets an account's name, turning the unique index refusing
 * it into `name-taken`. Two requests for one name at once both reach the
 * index, so exactly one wins.
 */
export const withUniqueName = <T>(write: Promise<T>): Promise<T> =>
  write.catch((error: unknown) => {
    if (isUniqueViolation(error, USERS_NAME_UNIQUE)) throw new AccountError('name-taken');
    throw error;
  });
