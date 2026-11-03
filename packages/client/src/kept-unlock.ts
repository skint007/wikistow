// What a device keeps to unlock with no answer from the server (ADR 0009,
// decision 5): the last `/api/me` answer, the vault wrapper with its version,
// and the installation ID. Kept unsealed beside the sealed items, as they are
// read before any vault opens; they hold no page content. The wrapper is
// what the server keeps: with it, someone who has the device can guess the
// passphrase offline, as someone with the server's database can.
import { accountRoutes, InstallationId, vaultRoutes } from '@wikistow/contracts';
import { z } from 'zod';
import { decodeUtf8, utf8 } from './encoding.ts';
import type { KeptStore } from './kept-store.ts';

/** The signed-in account, as `GET /api/me` answers. */
export type MeAnswer = z.infer<typeof accountRoutes.me.response>;

/** The vault wrapper as the server last served it to this device, and when. */
export const KeptVault = vaultRoutes.getVault.response.extend({ keptAt: z.iso.datetime() });
export type KeptVault = z.infer<typeof KeptVault>;

const Installation = z.strictObject({ installationId: InstallationId });

async function read<T>(store: KeptStore, name: string, schema: z.ZodType<T, unknown>) {
  const bytes = await store.unlock.read(name).catch(() => null);
  if (!bytes) return null;
  try {
    return schema.parse(JSON.parse(decodeUtf8(bytes, 'kept item')));
  } catch {
    return null;
  }
}

const write = (store: KeptStore, name: string, value: unknown) =>
  store.unlock.write(name, utf8(JSON.stringify(value)));

/** Read and keep what unlocking offline needs, in `store`. Nothing readable counts as nothing kept. */
export const keptUnlock = (store: KeptStore) => ({
  me: () => read(store, 'me', accountRoutes.me.response),
  keepMe: (me: MeAnswer) => write(store, 'me', me),
  /** After the server said the session ended: an offline start goes no further. */
  forgetMe: () => store.unlock.remove('me'),
  vault: () => read(store, 'vault', KeptVault),
  keepVault: (vault: KeptVault) => write(store, 'vault', vault),
  installationId: async () => (await read(store, 'installation', Installation))?.installationId,
  keepInstallationId: (installationId: InstallationId) =>
    write(store, 'installation', { installationId }),
});
