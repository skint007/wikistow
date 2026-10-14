import { eq } from 'drizzle-orm';
import type { Database } from '../db/client.ts';
import { THEMES, users } from '../db/schema/index.ts';

export type Theme = (typeof THEMES)[number];

/** The theme is an account setting, not content, so it syncs as plain data. */
export async function setTheme(db: Database, accountId: string, theme: Theme): Promise<void> {
  await db.update(users).set({ theme }).where(eq(users.id, accountId));
}
