import { chmod, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { KeychainStore, SecretToolStore } from '../src/secret-store.ts';
import { privateDir } from './support/fake-io.ts';

/** A store's tool that keeps one secret in a file and logs how it was called. */
async function fakeTool(script: (kept: string) => string) {
  const { home } = await privateDir();
  const tool = join(home, 'tool');
  const kept = join(home, 'kept');
  const log = join(home, 'log');
  await writeFile(
    tool,
    `#!/bin/sh
{ printf 'ARGS:'; printf ' %s' "$@"; printf '\\n'; } >> '${log}'
${script(kept)}
`,
  );
  await chmod(tool, 0o700);
  return { tool, kept, log };
}

const secretTool = (kept: string) => `case "$1" in
  store) cat > '${kept}' ;;
  lookup) [ -f '${kept}' ] || exit 1; cat '${kept}' ;;
  clear) rm -f '${kept}' ;;
esac`;

// macOS's security: -i reads one add-generic-password command from stdin.
const security = (kept: string) => `case "$1" in
  -i) sed -n 's/.* -w \\([^ ]*\\).*/\\1/p' > '${kept}' ;;
  find-generic-password) [ -f '${kept}' ] || exit 44; cat '${kept}' ;;
esac`;

const ENV = {
  DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1/bus',
  XDG_RUNTIME_DIR: '/run/user/1',
  HOME: '/home/a',
};

describe('the secret-tool store', () => {
  // These run a stand-in the user wrote, as the CLI's own test build may.
  beforeEach(() => void vi.stubEnv('WIKISTOW_TEST_TRUST_ANY_SECRET_TOOL', 'yes'));
  afterEach(() => void vi.unstubAllEnvs());

  it('passes the secret only through standard input and output', async () => {
    const { tool, kept, log } = await fakeTool(secretTool);
    const store = new SecretToolStore(tool, ENV);
    const secret = new Uint8Array(32).fill(7);
    store.store('agent-x', secret);
    expect(store.lookup('agent-x')).toEqual(secret);
    const logged = await readFile(log, 'utf8');
    const encoded = Buffer.from(secret).toString('base64url');
    expect(await readFile(kept, 'utf8')).toBe(encoded);
    expect(logged).not.toContain(encoded);
    expect(logged).toContain(
      'ARGS: store --label=WikiStow agent key file service wikistow account agent-x',
    );
  });
});

describe('the macOS Keychain store', () => {
  beforeEach(() => void vi.stubEnv('WIKISTOW_TEST_TRUST_ANY_SECRET_TOOL', 'yes'));
  afterEach(() => void vi.unstubAllEnvs());

  it('passes the secret only through standard input and output', async () => {
    const { tool, kept, log } = await fakeTool(security);
    const store = new KeychainStore(tool);
    const secret = new Uint8Array(32).fill(7);
    store.store('agent-x', secret);
    expect(store.lookup('agent-x')).toEqual(secret);
    const encoded = Buffer.from(secret).toString('base64url');
    expect(await readFile(kept, 'utf8')).toBe(`${encoded}\n`);
    const logged = await readFile(log, 'utf8');
    expect(logged).not.toContain(encoded);
    expect(logged).toContain('ARGS: -i\n');
  });
});
