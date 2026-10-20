// The server the browser tests run against: the real app on a fresh,
// migrated database, serving the built web app. Mail arrives over loopback SMTP,
// and a separate control port lets tests look behind the server.
import { serve } from '@hono/node-server';
import { createApp } from '@wikistow/server-app/app';
import type { Mail } from '@wikistow/server-app/mail';
import { connect, fileBlobStore, listenForTreeChanges, MIN_VAULT_KDF } from '@wikistow/server';
import { sql } from 'drizzle-orm';
import { createMigratedDatabase } from '@wikistow/server/testing/postgres';
import { simpleParser } from 'mailparser';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SMTPServer } from 'smtp-server';

// E2E_PORT sets the app port; control uses +1 and loopback SMTP uses +2.
// Another run (or another checkout) can use other ports with E2E_PORT.
const APP_PORT = Number(process.env['E2E_PORT'] ?? 3100);
const CONTROL_PORT = APP_PORT + 1;
const SMTP_PORT = APP_PORT + 2;
const origin = `http://localhost:${APP_PORT}`;

const mails: Mail[] = [];
const logs: unknown[] = [];
// The production transport keeps its timeouts and message encoding. Only the
// relay address changes; loopback needs neither credentials nor TLS.
const smtpConfig = {
  url: `smtp://127.0.0.1:${SMTP_PORT}?ignoreTLS=true`,
  from: 'WikiStow <wiki@example.test>',
};
const smtp = new SMTPServer({
  disabledCommands: ['AUTH', 'STARTTLS'],
  disableReverseLookup: true,
  onData(stream, _session, callback) {
    void simpleParser(stream)
      .then((mail) => {
        if (!mail.to || mail.subject === undefined || mail.text === undefined) {
          throw new Error('SMTP message is missing its recipient, subject or text');
        }
        const recipients = Array.isArray(mail.to) ? mail.to : [mail.to];
        for (const { address } of recipients.flatMap((recipient) => recipient.value)) {
          if (!address) throw new Error('SMTP message has no recipient address');
          mails.push({ to: address, subject: mail.subject, text: mail.text });
        }
        // Acknowledge delivery only after the decoded message is in the mailbox.
        callback();
      })
      .catch((error: unknown) => {
        callback(error instanceof Error ? error : new Error('SMTP parsing failed'));
      });
  },
});
await new Promise<void>((resolve, reject) => {
  smtp.once('error', reject);
  smtp.listen(SMTP_PORT, '127.0.0.1', () => {
    smtp.off('error', reject);
    resolve();
  });
});
// A client socket that fails mid-message emits 'error' on the server. Without
// a listener Node would throw and take the whole test server down with it.
smtp.on('error', (error) => logs.push({ smtp: error.message }));

const database = await createMigratedDatabase('wikistow_e2e');
const blobDir = await mkdtemp(join(tmpdir(), 'wikistow-e2e-blobs-'));
const { db, close } = connect(database.url);

const { app, treeChanges } = createApp({
  db,
  config: {
    databaseUrl: database.url,
    publicOrigin: origin,
    port: APP_PORT,
    webDist: fileURLToPath(new URL('../dist', import.meta.url)),
    migrationsDir: undefined,
    authSecret: 'e2e-secret-that-is-comfortably-longer-than-32-characters',
    smtp: smtpConfig,
    trustProxy: false,
    rateLimit: false,
    blobDir,
    // The browser derives vault keys at the real default cost, so the real floor applies.
    minKdf: MIN_VAULT_KDF,
    limits: { uploadBytes: 25 * 1024 * 1024, storageBytes: 1024 * 1024 * 1024 },
    bodyDeadlineMs: 60_000,
  },
  log: (entry) => {
    logs.push(entry);
  },
  blobs: fileBlobStore(blobDir),
});
// Sidebars load again as trees change, as with the real server.
const treeListener = await listenForTreeChanges(database.url, treeChanges.changed);
// Loopback only: the control port can reset accounts and dump the database.
const server = serve({ fetch: app.fetch, port: APP_PORT, hostname: '127.0.0.1' });

// Test-only: read decoded SMTP mail, the database and the blob folder, and change keys.
const control = createServer((req, res) => {
  void (async () => {
    const url = new URL(req.url ?? '/', `http://localhost:${CONTROL_PORT}`);
    if (req.method === 'GET' && url.pathname === '/mails') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(mails));
    } else if (req.method === 'GET' && url.pathname === '/blob-dir') {
      // Where blobs and library plugins' files are, for tests that change one behind the server.
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ blobDir }));
    } else if (req.method === 'GET' && url.pathname === '/owner') {
      // The first administrator, so a restarted test worker can reuse it.
      const [first] = await db.execute<{ email: string }>(
        sql`select email from users order by created_at limit 1`,
      );
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ email: first?.email ?? null }));
    } else if (req.method === 'GET' && url.pathname === '/snapshot') {
      // Everything the server holds: every table, every blob file, its log, and its mail.
      const tables = await db.execute<{ name: string }>(
        sql`select tablename as name from pg_tables where schemaname = 'public'`,
      );
      const rows: Record<string, unknown> = {};
      for (const { name } of tables) {
        const [result] = await db.execute<{ rows: unknown }>(
          sql`select coalesce(json_agg(t), '[]'::json) as rows from ${sql.identifier(name)} t`,
        );
        rows[name] = result?.rows;
      }
      const files = await readdir(blobDir, { recursive: true, withFileTypes: true });
      const blobs = await Promise.all(
        files
          .filter((f) => f.isFile())
          .map(async (f) => (await readFile(join(f.parentPath, f.name))).toString('base64url')),
      );
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ rows, blobs, logs, mails }));
    } else if (req.method === 'POST' && url.pathname === '/swap-key') {
      // What a recovery, or a server substituting its own key, looks like to
      // everyone else: the account's identity at the next key version, with
      // fresh public keys nobody holds the secrets of.
      const email = url.searchParams.get('email') ?? '';
      // JWK's `x` is the raw public key in unpadded base64url, as identities store it.
      const box = generateKeyPairSync('x25519').publicKey.export({ format: 'jwk' }).x;
      const sign = generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' }).x;
      await db.transaction(async (tx) => {
        const [old] = await tx.execute<{ id: string; key_version: number; account_id: string }>(sql`
          update identities set revoked_at = now()
          where account_id = (select id from users where email = ${email})
            and kind = 'human' and revoked_at is null
          returning id, key_version, account_id`);
        if (!old) throw new Error(`No identity for ${email}`);
        await tx.execute(sql`
          insert into identities (id, key_version, account_id, kind, box_public_key, sign_public_key)
          values (${old.id}, ${old.key_version + 1}, ${old.account_id}, 'human',
                  ${box}, ${sign})`);
      });
      res.end();
    } else {
      res.statusCode = 404;
      res.end();
    }
  })().catch((error: unknown) => {
    res.statusCode = 500;
    res.end(String(error));
  });
});
control.listen(CONTROL_PORT, '127.0.0.1');

const shutdown = () => {
  smtp.close();
  control.close();
  server.close(() => {
    void Promise.all([close(), treeListener.close()])
      .then(() => database.drop())
      .then(() => rm(blobDir, { recursive: true, force: true }))
      .then(() => process.exit(0));
  });
  treeChanges.close();
};
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
