import { describe, expect, it } from 'vite-plus/test';
import { FAST_KDF } from './support/testing.ts';
import {
  AccountId,
  commands,
  createApiClient,
  inlineVaultCrypto,
  newId,
  runCommand,
  type CommandContexts,
} from '../src/index.ts';

describe('commands', () => {
  it('set up a vault in two steps, so a lost answer is retried with the same keys', async () => {
    const sent: unknown[] = [];
    let answered = false;
    const account: CommandContexts['account'] = {
      accountId: newId(AccountId),
      crypto: {
        ...inlineVaultCrypto,
        create: (input) => inlineVaultCrypto.create({ ...input, kdf: FAST_KDF }),
      },
      api: createApiClient({
        fetch: async (_url, init) => {
          sent.push(JSON.parse(init.body as string));
          // The first registration is stored, but its answer never arrives.
          if (!answered) {
            answered = true;
            throw new TypeError('network error');
          }
          return new Response(JSON.stringify({ version: 1 }), { status: 201 });
        },
      }),
    };
    const prepared = await runCommand(
      commands['vault.prepare'],
      { account },
      { passphrase: 'a passphrase for tests' },
    );
    expect(prepared.recoveryKey).toMatch(/\S/);
    const register = () => runCommand(commands['vault.register'], { account }, { prepared });
    await expect(register()).rejects.toThrow();
    await register();
    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual(sent[0]);
  });
});
