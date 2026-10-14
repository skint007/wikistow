import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vite-plus/test';
import { sealedByKeyring, secretFile, type Cipher } from '../src/secrets.ts';

// Stands in for the keyring: reversible, and plainly not the text it sealed.
const cipher: Cipher = {
  encrypt: async (text) => Buffer.from(text).reverse(),
  decrypt: async (sealed) => Buffer.from(sealed).reverse().toString(),
};

const COOKIE = 'better-auth.session_token=secret-token.signature';
const KEY = new Uint8Array(32).fill(9);

const newPath = async () =>
  join(await mkdtemp(join(tmpdir(), 'wikistow-secrets-')), 'secrets.json');

describe('secretFile', () => {
  it('keeps the session and the vault key sealed, readable only by the owner', async () => {
    const path = await newPath();
    const file = secretFile(path, cipher);
    await file.write({
      origin: 'https://wiki.example.com',
      cookie: COOKIE,
      vault: { accountId: 'account-1', key: KEY },
    });

    const raw = await readFile(path, 'utf8');
    expect(raw).not.toContain('secret-token');
    expect(raw).not.toContain(Buffer.from(KEY).toString('base64'));
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await file.read()).toEqual({
      origin: 'https://wiki.example.com',
      cookie: COOKIE,
      vault: { accountId: 'account-1', key: KEY },
    });
  });

  it('keeps nothing without a trusted store, and removes what an older run left', async () => {
    const path = await newPath();
    await writeFile(path, '{"cookie":"left over"}');
    const file = secretFile(path, null);
    expect(file.secure).toBe(false);
    await file.write({ origin: null, cookie: COOKIE, vault: null });
    await expect(stat(path)).rejects.toThrow();
    expect(await file.read()).toEqual({ origin: null, cookie: null, vault: null });
  });

  it('removes the file once there is nothing left to keep', async () => {
    const path = await newPath();
    const file = secretFile(path, cipher);
    await file.write({ origin: null, cookie: COOKIE, vault: null });
    await file.write({ origin: null, cookie: null, vault: null });
    await expect(stat(path)).rejects.toThrow();
  });

  it('reads nothing from a file the store can’t open, and removes it', async () => {
    const path = await newPath();
    await writeFile(path, '{"version":2,"cookie":"not sealed by this store"}');
    const broken: Cipher = {
      ...cipher,
      decrypt: () => Promise.reject(new Error('locked')),
    };
    expect(await secretFile(path, broken).read()).toEqual({
      origin: null,
      cookie: null,
      vault: null,
    });
    await expect(stat(path)).rejects.toThrow();
  });
});

it('trusts only the keyring’s key, never Electron’s fallback', () => {
  expect(sealedByKeyring(Buffer.from('v11sealed'))).toBe(true);
  expect(sealedByKeyring(Buffer.from('v10sealed'))).toBe(false);
  expect(sealedByKeyring(Buffer.from('v12sealed'))).toBe(false);
  expect(sealedByKeyring(Buffer.from('v1'))).toBe(false);
  expect(sealedByKeyring(Buffer.alloc(0))).toBe(false);
});
