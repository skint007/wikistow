// Operator commands, run inside the container:
//   node admin.mjs bootstrap-admin --email you@example.com
// Run once for a one-time link to create the account, and again after its
// email is verified to make it the administrator. Passwords never pass
// through command arguments; the operator sets one in the browser.
import {
  AccountError,
  bootstrapAdmin,
  connect,
  DatabaseLockedError,
  INVITATION_TTL_DAYS,
  lockDatabase,
} from '@wikistow/server';
import { parseArgs } from 'node:util';
import { z } from 'zod';

const USAGE = 'Usage: node admin.mjs bootstrap-admin --email <address>\n';

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { email: { type: 'string' } },
});
const email = z.email().safeParse(values.email);
if (positionals[0] !== 'bootstrap-admin' || !email.success) {
  process.stderr.write(USAGE);
  process.exit(2);
}

const env = z.object({ DATABASE_URL: z.url(), PUBLIC_ORIGIN: z.url() }).safeParse(process.env);
if (!env.success) {
  process.stderr.write('DATABASE_URL and PUBLIC_ORIGIN must be set.\n');
  process.exit(2);
}

// Shared with the server, so this runs beside it but never under a restore.
const lock = await lockDatabase(env.data.DATABASE_URL).catch((error: unknown) => {
  if (!(error instanceof DatabaseLockedError)) throw error;
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
});
const { db, close } = connect(env.data.DATABASE_URL, { max: 1 });
try {
  const result = await bootstrapAdmin(db, email.data);
  switch (result.kind) {
    case 'invited': {
      const link = `${new URL(env.data.PUBLIC_ORIGIN).origin}/invite#token=${result.token}`;
      process.stdout.write(
        `Invitation for ${email.data}, valid for ${INVITATION_TTL_DAYS} days:\n\n  ${link}\n\n` +
          'Open it to create the account and verify its email, then run this command again\n' +
          'to make it the administrator.\n',
      );
      break;
    }
    case 'awaiting-verification':
      process.stdout.write(
        `The account for ${email.data} hasn't verified its email yet. Verify it, then run this again.\n`,
      );
      break;
    case 'promoted':
      process.stdout.write(`${email.data} is now the administrator.\n`);
      if (result.suspended > 0)
        process.stdout.write(
          `Suspended ${result.suspended} other account(s) made from earlier bootstrap links.\n` +
            'Review them in the admin dashboard.\n',
        );
      break;
    default:
      throw new Error(`Unexpected bootstrap result: ${JSON.stringify(result satisfies never)}`);
  }
} catch (error) {
  if (!(error instanceof AccountError) || error.code !== 'admin-exists') throw error;
  process.stderr.write(
    'An administrator already exists. Invite people from the admin dashboard.\n',
  );
  process.exitCode = 1;
} finally {
  await close();
  await lock.release();
}
