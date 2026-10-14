import { rename, rm, writeFile, readFile } from 'node:fs/promises';
import { z } from 'zod';

/** Seals and opens text with the system's secret store (Electron's async `safeStorage`). */
export type Cipher = {
  encrypt(text: string): Promise<Buffer>;
  decrypt(sealed: Buffer): Promise<string>;
};

/**
 * What the app keeps between launches: the session, and the vault key when
 * the person asked it to remember the unlock. Never written in the clear.
 */
export type Secrets = {
  /** The server the cookies are for, so they never reach another. */
  origin: string | null;
  cookie: string | null;
  vault: { accountId: string; key: Uint8Array } | null;
};

export const NO_SECRETS: Secrets = { origin: null, cookie: null, vault: null };

// Chromium starts what it seals with the name of the key it used. `v11` is
// the key the keyring holds (Secret Service or KWallet); `v10` is the
// fallback every program on the computer knows, used when there is no keyring.
const KEYRING_KEY = Buffer.from('v11');

/** Whether `sealed` was sealed with the keyring's key, rather than a fallback. */
export const sealedByKeyring = (sealed: Buffer) =>
  sealed.subarray(0, KEYRING_KEY.length).equals(KEYRING_KEY);

// Files without a version were sealed by the sync API, on KWallet with the
// key every Chromium-based app shares. Under another key a value can open as
// garbage rather than fail, so they are dropped, and the person signs in again.
const Sealed = z.object({
  version: z.literal(2),
  origin: z.string().optional(),
  cookie: z.string().optional(),
  vault: z.object({ accountId: z.string(), key: z.string() }).optional(),
});

/**
 * The secrets file, each value sealed by `cipher`. Without a cipher nothing
 * is kept: `write` removes the file, so an older one can't linger.
 */
export function secretFile(path: string, cipher: Cipher | null) {
  const seal = async (text: string) => (await cipher?.encrypt(text))?.toString('base64') ?? '';
  const open = async (sealed: string) =>
    (await cipher?.decrypt(Buffer.from(sealed, 'base64'))) ?? '';
  const next = `${path}.next`;
  // A write cut short leaves its sealed copy beside the file; it goes too.
  const clear = async () => {
    await rm(path, { force: true });
    await rm(next, { force: true });
  };
  return {
    secure: cipher !== null,
    clear,
    /**
     * What was kept, or nothing if the file is missing, unreadable, or the
     * store won't open it. A file it can't use is removed.
     */
    async read(): Promise<Secrets> {
      if (!cipher) return NO_SECRETS;
      try {
        const stored = Sealed.parse(JSON.parse(await readFile(path, 'utf8')));
        return {
          origin: stored.origin ?? null,
          cookie: stored.cookie ? await open(stored.cookie) : null,
          vault: stored.vault
            ? {
                accountId: stored.vault.accountId,
                key: new Uint8Array(Buffer.from(await open(stored.vault.key), 'base64')),
              }
            : null,
        };
      } catch {
        await clear().catch(() => {});
        return NO_SECRETS;
      }
    },
    async write(secrets: Secrets): Promise<void> {
      if (!cipher || (!secrets.cookie && !secrets.vault)) return clear();
      const sealed: z.input<typeof Sealed> = {
        version: 2,
        ...(secrets.origin && { origin: secrets.origin }),
        ...(secrets.cookie && { cookie: await seal(secrets.cookie) }),
        ...(secrets.vault && {
          vault: {
            accountId: secrets.vault.accountId,
            key: await seal(Buffer.from(secrets.vault.key).toString('base64')),
          },
        }),
      };
      // Written whole, then moved into place, so a crash never leaves half a
      // file. Callers write one at a time (`persist` in main.ts).
      await writeFile(next, JSON.stringify(sealed), { mode: 0o600 });
      await rename(next, path);
    },
  };
}
