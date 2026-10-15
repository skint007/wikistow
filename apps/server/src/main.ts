import { serve } from '@hono/node-server';
import {
  connect,
  DatabaseLockedError,
  fileBlobStore,
  filePluginStore,
  lockDatabase,
  MIGRATIONS_DIR,
  sweepBlobs,
  sweepDrafts,
  sweepPasswordBudgets,
  sweepPlugins,
} from '@wikistow/server';
import { createApp } from './app.ts';
import { loadConfig } from './config.ts';
import { stdoutLog } from './http/logger.ts';
import { scheduleSweep } from './sweep.ts';
import { smtpDeliver } from './mail/mailer.ts';

/** How long a connection may go without sending or taking a byte. */
const IDLE_TIMEOUT_MS = 60_000;

const config = loadConfig();
// Held for as long as the server runs, before anything touches the database,
// so a restore can't start under it, nor it under a restore. Losing it means
// a restore may have begun, so stop rather than serve on: whatever restarts
// the server takes it again first (see docs/operations.md). Migrations run
// under it too, as a restore between them and serving would bring back the
// backup's older schema.
const lock = await lockDatabase(config.databaseUrl, {
  onLost: () => {
    stdoutLog({ level: 'error', event: 'database-lock-lost' });
    process.exit(1);
  },
}).catch((error: unknown) => {
  if (!(error instanceof DatabaseLockedError)) throw error;
  stdoutLog({ level: 'error', event: 'database-locked', message: error.message });
  process.exit(1);
});
await lock.migrate(config.migrationsDir ?? MIGRATIONS_DIR);
stdoutLog({ level: 'info', event: 'migrated' });
const { db, close } = connect(config.databaseUrl);
const blobs = fileBlobStore(config.blobDir);
const { app } = createApp({ db, config, log: stdoutLog, deliver: smtpDeliver(config.smtp), blobs });

// Each sweep on its own, so one failing doesn't stop the others: attachment
// data nothing uses, and publications into another space nobody finished
// (see sweepBlobs); library plugin files no version lists (see
// sweepPlugins); old draft checkpoints nothing needs (see sweepDrafts);
// and password allowances that are full again (see sweepPasswordBudgets).
const sweeps = [
  scheduleSweep(stdoutLog, 'blob-sweep', () => sweepBlobs(db, blobs)),
  scheduleSweep(stdoutLog, 'plugin-sweep', async () => ({
    versions: await sweepPlugins(db, filePluginStore(config.blobDir)),
  })),
  scheduleSweep(stdoutLog, 'draft-sweep', async () => ({
    drafts: await sweepDrafts(db, { retentionMs: config.draftRetentionMs }),
  })),
  scheduleSweep(stdoutLog, 'password-budget-sweep', async () => ({
    deleted: await sweepPasswordBudgets(db),
  })),
];

const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  stdoutLog({ level: 'info', event: 'listening', port: info.port });
});
// Close a connection that has sent and taken nothing for a minute, such as
// a client that stopped reading a large file, which would otherwise hold its
// socket forever. A quiet AI reply sends blank lines to stay inside it (see
// `routes.stream`).
server.setTimeout(IDLE_TIMEOUT_MS);

// Stop taking connections, let in-flight requests finish, then close the pool.
const shutdown = () => {
  for (const sweep of sweeps) clearInterval(sweep);
  server.close(() => {
    void close()
      .then(() => lock.release())
      .then(() => process.exit(0));
  });
};
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
