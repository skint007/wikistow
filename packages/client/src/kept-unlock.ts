// What a device keeps to unlock with no answer from the server (ADR 0009,
// decision 5): the last `/api/me` answer, the vault wrapper with its version,
// and the installation ID. Kept unsealed beside the sealed items, as they are
// read before any vault opens; they hold no page content. The wrapper is
// what the server keeps: with it, someone who has the device can guess the
// passphrase offline, as someone with the server's database can.
import { accountRoutes, InstallationId, PublicIdentity, vaultRoutes } from '@wikistow/contracts';
import { z } from 'zod';
import { decodeUtf8, utf8 } from './encoding.ts';
import type { KeptStore } from './kept-store.ts';

/** The signed-in account, as `GET /api/me` answers. */
export type MeAnswer = z.infer<typeof accountRoutes.me.response>;

/** The vault wrapper as the server last served it to this device, and when. */
export const KeptVault = vaultRoutes.getVault.response.extend({ keptAt: z.iso.datetime() });
export type KeptVault = z.infer<typeof KeptVault>;

const Installation = z.strictObject({ installationId: InstallationId });

/**
 * The public key of the identity this device last unlocked with, its
 * anchor (section 4.6, **When someone else rotated**), and the key the
 * directory showed it was replaced by, once a valid chain from the anchor
 * said so: until the device unlocks at that key or after it, it opens
 * nothing (`replacedElsewhere`).
 */
export const KeptAnchor = z.strictObject({
  anchor: PublicIdentity,
  successor: PublicIdentity.nullable(),
});
export type KeptAnchor = z.infer<typeof KeptAnchor>;

/**
 * The hash of the rotation statement this device is sending, kept from
 * just before it sends until it has a definite answer (section 4.6), so a
 * reload in the middle knows the statement as its own (`rotationHash`).
 */
export const SentRotation = z.strictObject({ statementHash: z.string().min(1).max(100) });
export type SentRotation = z.infer<typeof SentRotation>;

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
  anchor: () => read(store, 'anchor', KeptAnchor),
  keepAnchor: (anchor: KeptAnchor) => write(store, 'anchor', anchor),
  sentRotation: () => read(store, 'sent-rotation', SentRotation),
  keepSentRotation: (sent: SentRotation) => write(store, 'sent-rotation', sent),
  forgetSentRotation: () => store.unlock.remove('sent-rotation'),
});
