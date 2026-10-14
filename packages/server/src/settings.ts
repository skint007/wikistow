import { eq } from 'drizzle-orm';
import type { Database } from './db/client.ts';
import { settings } from './db/schema/index.ts';

export async function readSettings(db: Database) {
  const [row] = await db.select().from(settings).where(eq(settings.id, 1));
  if (!row) throw new Error('settings row missing; were migrations applied?');
  return row;
}
