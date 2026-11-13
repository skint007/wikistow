import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import { clipHelper, desktopClipping } from '../src/clip/clipping.ts';
import { clipListener, privateFolder } from '../src/clip/listener.ts';
import {
  manifestTargets,
  manifestText,
  syncManifests,
  withExtension,
  type Registry,
} from '../src/clip/manifests.ts';
import { frame, FrameTooLarge, frameReader, MAX_MESSAGE, proof } from '../src/clip/protocol.ts';

const unix = process.platform !== 'win32';
const CALLER = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/';
const newFolder = () => mkdtemp(join(tmpdir(), 'wikistow-clip-'));
const stops: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
});

describe('frames', () => {
  it('splits a stream into messages however its chunks fall', () => {
    const stream = Buffer.concat([
      frame({ a: 1 }),
      frame({ b: 'é'.repeat(1000) }),
      frame({ c: 3 }),
    ]);
    const read = frameReader(() => MAX_MESSAGE);
    const bodies = [];
    for (let at = 0; at < stream.length; at += 7) {
      read.push(stream.subarray(at, at + 7));
      for (let body = read.next(); body; body = read.next()) bodies.push(body);
    }
    expect(bodies.map((body) => JSON.parse(body.toString()))).toEqual([
      { a: 1 },
      { b: 'é'.repeat(1000) },
      { c: 3 },
    ]);
  });

  it('refuses a message larger than allowed from its header, before holding it', () => {
    const read = frameReader(() => 100);
    const header = Buffer.alloc(4);
    header.writeUInt32LE(101);
    read.push(header);
    expect(() => read.next()).toThrow(FrameTooLarge);
  });
});

/** The helper's side of the socket, as clip-host/connect.go speaks it. */
async function helper(socketPath: string) {
  const socket = connect(socketPath);
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  const read = frameReader(() => MAX_MESSAGE);
  const bodies: unknown[] = [];
  let waiting: (() => void) | null = null;
  let closed = false;
  socket.on('data', (chunk: Buffer) => {
    read.push(chunk);
    for (let body = read.next(); body; body = read.next()) bodies.push(JSON.parse(body.toString()));
    waiting?.();
  });
  socket.on('close', () => {
    closed = true;
    waiting?.();
  });
  return {
    socket,
    send: (message: unknown) => socket.write(frame(message)),
    raw: (bytes: Buffer) => socket.write(bytes),
    /** The next message, or null once the app closed the connection. */
    async next(): Promise<Record<string, unknown> | null> {
      while (bodies.length === 0 && !closed) {
        await new Promise<void>((resolve) => (waiting = resolve));
      }
      return (bodies.shift() as Record<string, unknown> | undefined) ?? null;
    },
    get closed() {
      return closed;
    },
  };
}
type Helper = Awaited<ReturnType<typeof helper>>;

/** Run the token's challenge as the helper does; answers the app's nonce. */
async function prove(client: Helper, token: Buffer, caller = CALLER, holdsToken = true) {
  const ours = randomBytes(32);
  client.send({ v: 1, type: 'challenge', nonce: ours.toString('base64') });
  const answer = await client.next();
  expect(answer?.['type']).toBe('proof');
  const theirs = Buffer.from(String(answer?.['nonce']), 'base64');
  if (holdsToken) {
    expect(answer?.['mac']).toBe(proof(token, 'app', ours, theirs).toString('base64'));
  }
  client.send({
    type: 'proof',
    mac: proof(token, 'helper', theirs, ours).toString('base64'),
    caller,
  });
  return { ours, theirs };
}

async function listening(
  answer = (message: { id: string }, reply: (m: object) => void) =>
    reply({ id: message.id, type: 'status', app: 'ready' }),
) {
  const folder = await newFolder();
  const hostFile = join(folder, 'data', 'clip-host.json');
  const listener = clipListener({
    endpoint: { kind: 'unix', folder: join(folder, 'run'), name: 's.sock' },
    hostFile,
    allowed: (caller) => caller === CALLER,
    answer: (message, connection) =>
      answer(message, (m) => connection.reply(m as Record<string, unknown>)),
  });
  await listener.start();
  stops.push(() => listener.stop());
  const written = JSON.parse(await readFile(hostFile, 'utf8')) as { socket: string; token: string };
  return {
    folder,
    hostFile,
    listener,
    socket: written.socket,
    token: Buffer.from(written.token, 'base64'),
  };
}

describe.runIf(unix)('the clip listener', () => {
  it('writes clip-host.json for the person alone, naming a socket in a folder only they can open', async () => {
    const { hostFile, socket, token, folder } = await listening();
    expect((await stat(hostFile)).mode & 0o777).toBe(0o600);
    expect((await stat(join(folder, 'run'))).mode & 0o777).toBe(0o700);
    expect((await stat(socket)).mode & 0o777).toBe(0o600);
    expect(token).toHaveLength(32);
    expect(JSON.parse(await readFile(hostFile, 'utf8'))).toEqual({
      v: 1,
      socket: join(folder, 'run', 's.sock'),
      token: token.toString('base64'),
    });
  });

  it('answers a helper that proves it holds the token', async () => {
    const { socket, token } = await listening();
    const client = await helper(socket);
    await prove(client, token);
    client.send({ v: 1, id: 'a', type: 'hello', extension: '0.1.0', browser: 'chrome' });
    expect(await client.next()).toEqual({ v: 1, id: 'a', type: 'status', app: 'ready' });
  });

  it('sends nothing first, and drops a helper that never proves itself', async () => {
    const { socket } = await listening();
    const client = await helper(socket);
    const start = Date.now();
    expect(await client.next()).toBeNull();
    expect(Date.now() - start).toBeGreaterThanOrEqual(900);
  });

  it('drops a helper without the token, after its challenge', async () => {
    const { socket } = await listening(() => {
      throw new Error('answered');
    });
    const client = await helper(socket);
    await prove(client, randomBytes(32), CALLER, false);
    client.send({ v: 1, id: 'a', type: 'hello' });
    expect(await client.next()).toBeNull();
  });

  it('never takes its own MAC back as the helper’s', async () => {
    const { socket, token } = await listening(() => {
      throw new Error('answered');
    });
    const client = await helper(socket);
    const ours = randomBytes(32);
    client.send({ v: 1, type: 'challenge', nonce: ours.toString('base64') });
    const answer = await client.next();
    // Reflected: the app's own MAC, returned as the proof.
    client.send({ type: 'proof', mac: answer?.['mac'], caller: CALLER });
    client.send({ v: 1, id: 'a', type: 'hello' });
    expect(await client.next()).toBeNull();
    // And a second challenge on one connection isn't answered either.
    const again = await helper(socket);
    await prove(again, token);
    again.send({ v: 1, type: 'challenge', nonce: ours.toString('base64') });
    expect(await again.next()).toEqual({ v: 1, type: 'error', code: 'invalid' });
    expect(await again.next()).toBeNull();
  });

  it('lets the person’s helper in past connections that never prove themselves', async () => {
    const { socket, token } = await listening();
    // As other accounts on Windows can open the pipe to read, and wait.
    const idle = await Promise.all(Array.from({ length: 20 }, () => helper(socket)));
    // Partway through a challenge, which a silent one never pushes out.
    const started = await helper(socket);
    started.send({ v: 1, type: 'challenge', nonce: randomBytes(32).toString('base64') });
    expect((await started.next())?.['type']).toBe('proof');
    for (const more of await Promise.all(Array.from({ length: 20 }, () => helper(socket)))) {
      idle.push(more);
    }
    expect(started.closed).toBe(false);
    const client = await helper(socket);
    await prove(client, token);
    client.send({ v: 1, id: 'a', type: 'hello' });
    expect(await client.next()).toMatchObject({ id: 'a', type: 'status' });
    expect(idle.filter((other) => other.closed).length).toBeGreaterThanOrEqual(5);
  });

  it('drops a helper naming an extension it doesn’t answer', async () => {
    const { socket, token } = await listening();
    const client = await helper(socket);
    await prove(client, token, 'chrome-extension://pppppppppppppppppppppppppppppppp/');
    client.send({ v: 1, id: 'a', type: 'hello' });
    expect(await client.next()).toEqual({ v: 1, type: 'error', code: 'not-allowed' });
    expect(await client.next()).toBeNull();
  });

  it('says which versions it takes, and refuses what it can’t read', async () => {
    const { socket, token } = await listening();
    const client = await helper(socket);
    await prove(client, token);
    client.send({ v: 2, id: 'a', type: 'hello' });
    expect(await client.next()).toEqual({
      v: 1,
      id: 'a',
      type: 'error',
      code: 'version',
      min: 1,
      max: 1,
    });
    client.send({ v: 1, id: 'b', type: 'hello', unknown: true });
    expect(await client.next()).toEqual({ v: 1, id: 'b', type: 'error', code: 'invalid' });
    expect(await client.next()).toBeNull();
  });

  it('refuses a message over 48 MiB from its header alone', async () => {
    const { socket, token } = await listening();
    const client = await helper(socket);
    await prove(client, token);
    const header = Buffer.alloc(4);
    header.writeUInt32LE(MAX_MESSAGE + 1);
    client.raw(header);
    expect(await client.next()).toEqual({ v: 1, type: 'error', code: 'too-large' });
    expect(await client.next()).toBeNull();
  });

  it('deletes clip-host.json and the socket when it stops', async () => {
    const { hostFile, socket, listener } = await listening();
    await listener.stop();
    expect(existsSync(hostFile)).toBe(false);
    expect(existsSync(socket)).toBe(false);
  });

  it('refuses a socket folder others can open, once it can’t close it', async () => {
    const folder = await newFolder();
    await mkdir(join(folder, 'open'), { mode: 0o777 });
    await privateFolder(join(folder, 'open'));
    expect((await stat(join(folder, 'open'))).mode & 0o777).toBe(0o700);
  });
});

describe('host manifests', () => {
  const places = (platform: NodeJS.Platform) => ({
    platform,
    home: '/home/x',
    configHome: '/home/x/.config',
    userData: '/data',
    hostName: 'io.github.skint007.wikistow',
  });

  it('go where each browser looks, per user', () => {
    expect(manifestTargets(places('linux')).map((target) => target.file)).toEqual([
      '/home/x/.config/google-chrome/NativeMessagingHosts/io.github.skint007.wikistow.json',
      '/home/x/.config/chromium/NativeMessagingHosts/io.github.skint007.wikistow.json',
      '/home/x/.config/microsoft-edge/NativeMessagingHosts/io.github.skint007.wikistow.json',
      '/home/x/.config/BraveSoftware/Brave-Browser/NativeMessagingHosts/io.github.skint007.wikistow.json',
      '/home/x/.mozilla/native-messaging-hosts/io.github.skint007.wikistow.json',
    ]);
    const mac = manifestTargets(places('darwin'));
    expect(mac.find((target) => target.browser === 'firefox')).toMatchObject({
      profiles: ['/home/x/Library/Application Support/Firefox'],
      file: '/home/x/Library/Application Support/Mozilla/NativeMessagingHosts/io.github.skint007.wikistow.json',
    });
    expect(manifestTargets(places('win32')).map((target) => target.registryKey)).toEqual([
      'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\io.github.skint007.wikistow',
      'HKCU\\Software\\Chromium\\NativeMessagingHosts\\io.github.skint007.wikistow',
      'HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\io.github.skint007.wikistow',
      'HKCU\\Software\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts\\io.github.skint007.wikistow',
      'HKCU\\Software\\Mozilla\\NativeMessagingHosts\\io.github.skint007.wikistow',
    ]);
  });

  it('name the helper and only the extensions allowed, by exact origin or ID', () => {
    const allowed = { chromium: [CALLER], firefox: ['web-clipper@wikistow.skint007.github.io'] };
    expect(
      JSON.parse(
        manifestText(
          'chromium',
          'io.github.skint007.wikistow',
          '/usr/lib/wikistow-desktop/wikistow-clip-host',
          allowed,
        ),
      ),
    ).toEqual({
      name: 'io.github.skint007.wikistow',
      description: 'WikiStow web clipper',
      path: '/usr/lib/wikistow-desktop/wikistow-clip-host',
      type: 'stdio',
      allowed_origins: [CALLER],
    });
    expect(JSON.parse(manifestText('firefox', 'h', '/p', allowed))).toMatchObject({
      allowed_extensions: ['web-clipper@wikistow.skint007.github.io'],
    });
  });

  it('take an extension for the launch only if it is an origin or an ID', () => {
    const none = { chromium: [], firefox: [] };
    expect(withExtension(none, CALLER).chromium).toEqual([CALLER]);
    expect(withExtension(none, 'test@example.org').firefox).toEqual(['test@example.org']);
    for (const bad of [
      'chrome-extension://*/',
      'https://example.com/',
      'chrome-extension://abc/',
      '',
    ]) {
      expect(withExtension(none, bad)).toEqual(none);
    }
  });

  it('are written for the browsers found, only when changed, and deleted when off', async () => {
    const home = await newFolder();
    const targets = manifestTargets({
      ...places('linux'),
      home,
      configHome: join(home, '.config'),
    });
    await mkdir(join(home, '.config', 'chromium'), { recursive: true });
    await mkdir(join(home, '.config', 'mozilla'), { recursive: true });
    const registry: Registry = { set: async () => {}, remove: async () => {} };
    const allowed = { chromium: [CALLER], firefox: ['web-clipper@wikistow.skint007.github.io'] };
    const name = 'io.github.skint007.wikistow';
    expect(await syncManifests(targets, '/helper', allowed, registry, name)).toEqual([
      'chromium',
      'firefox',
    ]);
    const chromium = join(home, '.config', 'chromium', 'NativeMessagingHosts', `${name}.json`);
    const firefox = join(home, '.mozilla', 'native-messaging-hosts', `${name}.json`);
    expect(existsSync(join(home, '.config', 'google-chrome'))).toBe(false);
    const before = (await stat(chromium)).mtimeMs;
    await new Promise((resolve) => setTimeout(resolve, 20));
    await syncManifests(targets, '/helper', allowed, registry, name);
    expect((await stat(chromium)).mtimeMs).toBe(before);
    // No Chrome ID: no Chromium browser gets one.
    expect(
      await syncManifests(targets, '/helper', { ...allowed, chromium: [] }, registry, name),
    ).toEqual(['firefox']);
    expect(existsSync(chromium)).toBe(false);
    expect(await syncManifests(targets, null, allowed, registry, name)).toEqual([]);
    expect(existsSync(firefox)).toBe(false);
  });

  it('on Windows name one file per family from every key, and delete the keys when off', async () => {
    const userData = await newFolder();
    const calls: string[] = [];
    const registry: Registry = {
      set: async (key, value) =>
        void calls.push(
          `set ${key.split('\\')[2]} ${value.endsWith('chromium.json') ? 'chromium' : 'firefox'}`,
        ),
      remove: async (key) => void calls.push(`remove ${key.split('\\')[2]}`),
    };
    // Paths are joined the host's way; only the keys and their order matter here.
    const targets = manifestTargets({ ...places('win32'), userData });
    const allowed = { chromium: [CALLER], firefox: ['web-clipper@wikistow.skint007.github.io'] };
    expect(await syncManifests(targets, 'C:\\helper.exe', allowed, registry, 'h')).toHaveLength(5);
    expect(calls.splice(0)).toEqual([
      'set Google chromium',
      'set Chromium chromium',
      'set Microsoft chromium',
      'set BraveSoftware chromium',
      'set Mozilla firefox',
    ]);
    await syncManifests(targets, null, allowed, registry, 'h');
    expect(calls).toEqual([
      'remove Google',
      'remove Chromium',
      'remove Microsoft',
      'remove BraveSoftware',
      'remove Mozilla',
    ]);
  });
});

describe('the helper this copy ships', () => {
  const has = (path: string) => (found: string) => found === path;
  it('is beside the app in each package', () => {
    expect(
      clipHelper(
        {
          platform: 'linux',
          arch: 'x64',
          appPath: '/usr/lib/wikistow-desktop/resources/app.asar',
          execPath: '/usr/lib/wikistow-desktop/wikistow-desktop',
        },
        has('/usr/lib/wikistow-desktop/wikistow-clip-host'),
      ),
    ).toEqual({ path: '/usr/lib/wikistow-desktop/wikistow-clip-host', installed: true });
    expect(
      clipHelper(
        {
          platform: 'linux',
          arch: 'x64',
          appPath: '/usr/lib/wikistow-desktop-beta/app.asar',
          execPath: '/usr/lib/electron44/electron',
        },
        has('/usr/lib/wikistow-desktop-beta/wikistow-clip-host'),
      ),
    ).toEqual({ path: '/usr/lib/wikistow-desktop-beta/wikistow-clip-host', installed: true });
    expect(
      clipHelper(
        {
          platform: 'darwin',
          arch: 'arm64',
          appPath: '/Applications/WikiStow.app/Contents/Resources/app.asar',
          execPath: '/Applications/WikiStow.app/Contents/MacOS/WikiStow',
        },
        has('/Applications/WikiStow.app/Contents/MacOS/wikistow-clip-host'),
      ),
    ).toEqual({
      path: '/Applications/WikiStow.app/Contents/MacOS/wikistow-clip-host',
      installed: true,
    });
  });

  it('is scripts/clip-host.sh’s build in development, and none without one', () => {
    const options = {
      platform: 'linux' as const,
      arch: 'x64',
      appPath: '/src/apps/desktop',
      execPath: '/src/node_modules/electron/dist/electron',
    };
    expect(
      clipHelper(options, has('/src/apps/desktop/out/clip-host/linux-amd64/wikistow-clip-host')),
    ).toEqual({
      path: '/src/apps/desktop/out/clip-host/linux-amd64/wikistow-clip-host',
      installed: false,
    });
    expect(clipHelper(options, () => false)).toBeNull();
  });
});

describe.runIf(process.platform === 'linux')('browser clipping', () => {
  async function app(
    argv: string[] = ['--clip-manifests', `--clip-extension=${CALLER}`],
    built = true,
  ) {
    const root = await newFolder();
    const home = join(root, 'home');
    const userData = join(root, 'data');
    const appPath = join(root, 'app');
    const helperPath = join(appPath, 'out', 'clip-host', 'linux-amd64', 'wikistow-clip-host');
    await mkdir(join(home, '.config', 'chromium'), { recursive: true });
    await mkdir(join(appPath, 'out', 'clip-host', 'linux-amd64'), { recursive: true });
    if (built) await writeFile(helperPath, '');
    const clipping = desktopClipping({
      which: 'stable',
      platform: 'linux',
      arch: 'x64',
      env: { XDG_RUNTIME_DIR: join(root, 'run') },
      home,
      userData,
      ownDataFolder: true,
      appPath,
      execPath: '/electron',
      version: '1.2.3',
      argv,
      state: () => 'signed-out',
      show: () => {},
    });
    await clipping.start();
    stops.push(async () => void (await clipping.set(false)));
    const hash = createHash('sha256').update(userData).digest('hex').slice(0, 12);
    return {
      clipping,
      hostFile: join(userData, 'clip-host.json'),
      socket: join(root, 'run', 'wikistow', `clip-${hash}.sock`),
      manifest: join(
        home,
        '.config',
        'chromium',
        'NativeMessagingHosts',
        'io.github.skint007.wikistow.json',
      ),
    };
  }

  it('starts on, listens in the runtime folder, and answers hello with the app’s state', async () => {
    const { clipping, hostFile, socket, manifest } = await app();
    expect(await clipping.state()).toEqual({ on: true, problem: null, browsers: ['chromium'] });
    expect(JSON.parse(await readFile(hostFile, 'utf8')).socket).toBe(socket);
    expect(JSON.parse(await readFile(manifest, 'utf8')).allowed_origins).toEqual([CALLER]);
    const written = JSON.parse(await readFile(hostFile, 'utf8')) as { token: string };
    const client = await helper(socket);
    await prove(client, Buffer.from(written.token, 'base64'));
    client.send({ v: 1, id: 'a', type: 'hello' });
    expect(await client.next()).toEqual({
      v: 1,
      id: 'a',
      type: 'status',
      app: 'signed-out',
      offline: false,
      appVersion: '1.2.3',
      protocols: { min: 1, max: 1 },
    });
    client.send({ v: 1, id: 'b', type: 'clip' });
    expect(await client.next()).toMatchObject({ id: 'b', type: 'error', code: 'failed' });
  });

  it('turned off, closes the socket and deletes the manifests, and stays off', async () => {
    const { clipping, hostFile, socket, manifest } = await app();
    expect(await clipping.set(false)).toEqual({ on: false, problem: null, browsers: [] });
    expect(existsSync(hostFile) || existsSync(socket) || existsSync(manifest)).toBe(false);
    expect(await clipping.set(true)).toMatchObject({ on: true, browsers: ['chromium'] });
    expect(existsSync(hostFile) && existsSync(manifest)).toBe(true);
  });

  it('in development writes no manifests unless asked, and leaves the installed app’s alone', async () => {
    const { clipping, manifest } = await app([]);
    expect(await clipping.state()).toEqual({ on: true, problem: 'development', browsers: [] });
    expect(existsSync(manifest)).toBe(false);
    // As the installed app wrote it.
    await mkdir(join(manifest, '..'), { recursive: true });
    await writeFile(manifest, '{}');
    await clipping.set(false);
    await clipping.set(true);
    expect(await readFile(manifest, 'utf8')).toBe('{}');
  });

  it('with no helper built, leaves the installed app’s manifests alone even when asked', async () => {
    const { clipping, manifest } = await app(undefined, false);
    expect(await clipping.state()).toMatchObject({ problem: 'development' });
    await mkdir(join(manifest, '..'), { recursive: true });
    await writeFile(manifest, '{}');
    await clipping.set(false);
    expect(await readFile(manifest, 'utf8')).toBe('{}');
  });
});
