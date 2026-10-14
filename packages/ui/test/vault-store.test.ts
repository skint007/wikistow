import {
  AccountId,
  aiDispatcher,
  aiTool,
  FolderKeyring,
  RevisionCache,
  generateIdentity,
  ShareId,
  SpaceId,
  IdentityId,
  newId,
  type ClientContext,
  type UnlockedVault,
} from '@wikistow/client';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { z } from 'zod';
import { openAiSession } from '../src/ai/session.ts';
import { vaultStore } from '../src/vault/store.ts';

const filled = (length: number) => new Uint8Array(length).fill(7);

const newVault = (): UnlockedVault => ({
  accountId: AccountId.parse('account-1'),
  identity: generateIdentity({ kind: 'human', id: newId(IdentityId) }),
  vaultKey: filled(32),
});

// The store keeps the context, and locking closes it: only its folder keys
// and the revision and per-space caches are read.
const contextFor = (vault: UnlockedVault) =>
  ({
    identity: vault.identity,
    keyring: new FolderKeyring(),
    revisions: new RevisionCache(),
    spaces: new Map(),
  }) as unknown as ClientContext;

function openVault(vault = newVault()): UnlockedVault {
  vaultStore.unlock(contextFor(vault), vault);
  return vault;
}

const zeroed = (vault: UnlockedVault) =>
  [vault.vaultKey, vault.identity.boxSecretKey, vault.identity.signSecretKey].every((key) =>
    key.every((byte) => byte === 0),
  );

describe('the vault store', () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
    vaultStore.lock();
  });

  it('runs every guard, with the keys still usable, before a requested lock', async () => {
    const vault = openVault();
    const seen: boolean[] = [];
    cleanups.push(
      vaultStore.guardLock(async () => {
        seen.push(zeroed(vault));
        return true;
      }),
    );
    expect(await vaultStore.requestLock()).toBe(true);
    expect(seen).toEqual([false]);
    expect(vaultStore.get().status).toBe('locked');
    expect(zeroed(vault)).toBe(true);
  });

  it('wipes the folder keys the session opened when it locks', () => {
    const vault = newVault();
    const ctx = contextFor(vault);
    vaultStore.unlock(ctx, vault);
    const keys = { draftKey: filled(32), publishedKey: filled(32) };
    const [spaceId, shareId] = [newId(SpaceId), newId(ShareId)];
    ctx.keyring.add({ spaceId, shareId, keyVersion: 1, ...keys, sealer: vault.identity.public });
    vaultStore.lock();
    expect(ctx.keyring.versions(spaceId, shareId)).toEqual([]);
    expect([keys.draftKey, keys.publishedKey].every((key) => key.every((b) => b === 0))).toBe(true);
  });

  it('stays open when a guard says so', async () => {
    const vault = openVault();
    cleanups.push(vaultStore.guardLock(async () => false));
    expect(await vaultStore.requestLock()).toBe(false);
    expect(vaultStore.get().status).toBe('unlocked');
    expect(zeroed(vault)).toBe(false);
  });

  // Lock (and sign-out, which locks first) must end AI work: a tool that
  // finishes afterwards can't send its result or start another step.
  it('closes AI conversations, so nothing answered after the lock is sent on', async () => {
    openVault();
    const sent: unknown[] = [];
    const fetch = async (_url: string, init: RequestInit) => {
      sent.push(init.body);
      const events = [
        { type: 'tool-call', call: { id: 'call-1', name: 'read', input: {} } },
        { type: 'finish', reason: 'tool-calls' },
      ];
      return new Response(events.map((event) => `${JSON.stringify(event)}\n`).join(''));
    };
    const running: AbortSignal[] = [];
    let answer = (_text: string) => {};
    const read = aiTool({
      name: 'read',
      description: 'Read the open page',
      input: z.object({}),
      run: (_input, signal) => {
        running.push(signal);
        return new Promise<string>((resolve) => (answer = resolve));
      },
    });
    const session = openAiSession({ fetch, dispatcher: aiDispatcher([read]) });
    const reply = session.send('What does this page say?');
    await vi.waitFor(() => expect(running).toHaveLength(1));
    vaultStore.lock();
    answer('the decrypted page');
    await reply;
    expect(running[0]?.aborted).toBe(true);
    expect(sent).toHaveLength(1);
    expect(session.state()).toMatchObject({ status: 'closed', messages: [] });
  });

  it('makes no object URL for bytes decrypted before a lock', () => {
    openVault();
    const before = vaultStore.epoch();
    const url = vaultStore.objectUrl(new Uint8Array([1]), 'image/png', before);
    expect(url).toMatch(/^blob:/);
    vaultStore.lock();
    expect(() => vaultStore.objectUrl(new Uint8Array([1]), 'image/png', before)).toThrow('locked');
  });
});
