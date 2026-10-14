// People with vaults and open sessions, for tests of encrypted content.
import { AccountId, createApiClient, inlineVaultCrypto, openSession } from '@wikistow/client';
import { FAST_KDF, setUpVault } from '@wikistow/client/testing';
import { signedInPerson } from './accounts.ts';
import type { TestApp } from './harness.ts';

export const PASSPHRASE = 'a separate vault passphrase';

/** A signed-in person with a vault and an open session, as the web app would have. */
export async function personWithVault(
  t: TestApp,
  role: 'user' | 'admin' = 'user',
  { password, passphrase = PASSPHRASE }: { password?: string; passphrase?: string } = {},
) {
  const person = await signedInPerson(t, role, password);
  const api = createApiClient({ fetch: person.browser.fetch });
  const { vault, recoveryKey } = await setUpVault({
    api,
    crypto: inlineVaultCrypto,
    accountId: AccountId.parse(person.id),
    passphrase,
    kdf: FAST_KDF,
  });
  return { ...person, api, vault, recoveryKey, ctx: await openSession(api, vault) };
}

/** The error code a call fails with, or 'no error'. */
export const rejection = (promise: Promise<unknown>) =>
  promise.then(
    () => 'no error',
    (error: { code?: string }) => error.code,
  );
