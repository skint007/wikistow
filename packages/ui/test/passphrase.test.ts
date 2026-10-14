import { describe, expect, it } from 'vite-plus/test';
import { checkPassphrase, confirmPassphrase } from '../src/vault/passphrase.ts';

const passphrase = 'correct horse battery staple';
const check = (changes: Partial<Parameters<typeof checkPassphrase>[0]>) =>
  checkPassphrase({
    passphrase,
    repeat: passphrase,
    accountPassword: 'a long account password',
    ...changes,
  });

describe('a new vault passphrase', () => {
  it.each([
    ['the account password', { accountPassword: passphrase }, 'not your account password'],
    [
      'the account password in other capitals or spacing',
      { accountPassword: ` ${passphrase.toUpperCase()} ` },
      'not your account password',
    ],
  ])('is refused when %s', (_, changes, message) => {
    const result = check(changes);
    expect('error' in result && result.error).toContain(message);
  });
});

describe('confirming a new passphrase with the server', () => {
  const fields = { passphrase, repeat: passphrase, accountPassword: 'a long account password' };
  const answering = (answer: () => Promise<unknown>) => {
    const sent: string[] = [];
    const verify = (password: string) => {
      sent.push(password);
      return answer();
    };
    return { sent, verify };
  };

  it('sends nothing when the passphrase is the account password', async () => {
    const server = answering(() => Promise.resolve({ status: 'confirmed' }));
    const result = await confirmPassphrase(
      { ...fields, accountPassword: passphrase },
      server.verify,
    );
    expect('error' in result && result.error).toContain('not your account password');
    expect(server.sent).toEqual([]);
  });
});
