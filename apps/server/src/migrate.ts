import { DatabaseLockedError, MIGRATIONS_DIR, migrateDatabase } from '@wikistow/server';
import { z } from 'zod';
import { stdoutLog } from './http/logger.ts';

// For operators and CI. The server applies pending migrations itself as it
// starts, so this is never needed first. Running both is harmless, even at
// once, as migrations take turns (MIGRATION_LOCK_KEY).
const env = z
  .object({ DATABASE_URL: z.url(), MIGRATIONS_DIR: z.string().min(1).optional() })
  .safeParse(process.env);
if (!env.success) throw new Error('DATABASE_URL must be set to run migrations');

try {
  await migrateDatabase(env.data.DATABASE_URL, env.data.MIGRATIONS_DIR ?? MIGRATIONS_DIR);
} catch (error) {
  if (!(error instanceof DatabaseLockedError)) throw error;
  stdoutLog({ level: 'error', event: 'database-locked', message: error.message });
  process.exit(1);
}
stdoutLog({ level: 'info', event: 'migrated' });
