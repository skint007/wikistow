// The CLI after its person replaced their keys (protocol section 4.6, #327):
// it follows the chain from the key it pinned, keeps the new key in its key
// file, and says so once on standard error.
import { inlineVaultCrypto, replaceKeysOperations as replaceKeys } from '@wikistow/client';
import { FAST_KDF } from '@wikistow/client/testing';
import { personWithVault } from '@wikistow/server-app/testing/content';
import { createTestApp, type TestApp } from '@wikistow/server-app/testing/harness';
import { invite, library, shareFolder } from '@wikistow/server-app/testing/sharing';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import {
  buildCli,
  cleanUp,
  cli,
  cliHome,
  enroll,
  listen,
  PASSPHRASE,
  type Listening,
} from './support/cli.ts';

let t: TestApp;
let server: Listening;
beforeAll(async () => {
  [t] = await Promise.all([createTestApp({ identityRotation: true }), buildCli()]);
  server = await listen(t);
}, 180_000);
afterAll(async () => {
  await server.close();
  await Promise.all([t.drop(), cleanUp()]);
});

describe('after its person replaced their keys', () => {
  it('follows them, keeps the new key, and says so once', async () => {
    const alice = await personWithVault(t);
    const bob = await personWithVault(t);
    const lib = await library(alice);
    await shareFolder(alice.ctx, {
      spaceId: lib.spaceId,
      rootId: lib.shared,
      people: [await invite(alice, bob, 'editor')],
    });
    const home = await cliHome();
    const { agentId } = await enroll(server, home, bob, {
      picks: [{ spaceId: lib.spaceId, folderId: lib.shared, role: 'editor', canPublish: false }],
    });
    const run = (args: readonly string[]) =>
      cli(home, [...args, '--json'], { passphrase: PASSPHRASE });
    expect((await run(['spaces', 'list'])).code).toBe(0);
    const keyFile = () => readFile(join(home.dir, 'agent.key'), 'utf8');
    const before = await keyFile();

    const prepared = await replaceKeys.prepareRotation(bob.ctx, {
      vault: bob.vault,
      crypto: inlineVaultCrypto,
      passphrase: 'a brand new vault passphrase',
      kdf: FAST_KDF,
      keep: [agentId],
    });
    await replaceKeys.sendRotation(bob.api, prepared);

    const first = await run(['spaces', 'list']);
    expect(first.code, first.stderr).toBe(0);
    expect(first.stderr).toContain('Your person replaced their keys');
    expect(await keyFile()).not.toBe(before);
    const second = await run(['spaces', 'list']);
    expect(second.code, second.stderr).toBe(0);
    expect(second.stderr).not.toContain('replaced their keys');
    expect(second.json()).toEqual(first.json());
  });
});
