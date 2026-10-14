import { createSetupToken, type Database } from '@wikistow/server';
import { setPasswordMail } from '../mail/templates.ts';

/**
 * The mail that lets the owner of an address finish an account nobody can
 * sign in to yet. Sent wherever a confirmation or reset would be, since a
 * plain confirmation would verify the account without a password.
 */
export async function accountSetupMail(
  db: Database,
  publicOrigin: string,
  account: { id: string; email: string },
) {
  const token = await createSetupToken(db, account.id);
  return setPasswordMail(account.email, `${publicOrigin}/reset-password?token=${token}&setup=1`);
}
