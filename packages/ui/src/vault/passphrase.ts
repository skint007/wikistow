import { MIN_PASSPHRASE } from '@wikistow/client';
import { ApiError } from '@wikistow/client/api';

type Fields = { passphrase: string; repeat: string; accountPassword: string };

/**
 * Check a new vault passphrase. It must differ from the account password,
 * which the server sees at every sign-in: the comparison happens here, on
 * this device, and neither value is sent anywhere for it.
 */
export function checkPassphrase({
  passphrase,
  repeat,
  accountPassword,
}: Fields): { value: string } | { error: string } {
  if (passphrase.length < MIN_PASSPHRASE)
    return { error: `Use at least ${MIN_PASSPHRASE} characters.` };
  if (passphrase !== repeat) return { error: 'The passphrases don’t match.' };
  if (!accountPassword) return { error: 'Enter your account password, to check they differ.' };
  // Spacing and capitals aside, it's still the same secret.
  const normal = (secret: string) => secret.trim().toLowerCase();
  if (normal(passphrase) === normal(accountPassword))
    return { error: 'Choose a passphrase that is not your account password.' };
  return { value: passphrase };
}

/**
 * `checkPassphrase`, then the account password typed is checked with the
 * server, so a typo in it can't let the real one through as the passphrase.
 * `verifyPassword` sends the account password alone (the server knows it
 * already) and throws `wrong-password` if it is wrong. It runs only once the
 * two are known to differ, so the passphrase is never what gets sent.
 */
export async function confirmPassphrase(
  fields: Fields,
  verifyPassword: (accountPassword: string) => Promise<unknown>,
): Promise<{ value: string } | { error: string }> {
  const checked = checkPassphrase(fields);
  if ('error' in checked) return checked;
  try {
    await verifyPassword(fields.accountPassword);
  } catch (error) {
    if (error instanceof ApiError && error.code === 'wrong-password')
      return { error: 'That isn’t your account password. Check it and try again.' };
    throw error;
  }
  return checked;
}
