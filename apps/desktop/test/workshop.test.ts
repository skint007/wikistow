import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import { readPluginFolder } from '../src/plugins/folder.ts';
import { pluginAddress } from '../src/plugins/plugins.ts';
import { desktopWorkshop, type Bundler } from '../src/workshop/workshop.ts';

// Each entry's text as its output: what is built doesn't matter here, where it goes does.
const bundler: Bundler = {
  build: async ({ files, entries }) => {
    const texts = new Map(files);
    return {
      outputs: Object.fromEntries(
        entries.map(({ output, entry }) => [output, texts.get(entry) ?? '']),
      ),
      diagnostics: [],
    };
  },
};

const MANIFEST = JSON.stringify({
  id: 'probe',
  name: 'Probe',
  version: '0.1.0',
  api: 1,
  script: 'script.js',
});

let data = '';
afterEach(() => rm(data, { recursive: true, force: true }));

async function workshopWithVersion() {
  data = await mkdtemp(join(tmpdir(), 'workshop-'));
  const workshop = desktopWorkshop(data, bundler);
  const session = await workshop.start();
  await workshop.write(session, 'wikistow-plugin.json', MANIFEST);
  await workshop.write(session, 'src/script.ts', 'export {};');
  const version = await workshop.build(session);
  if (!version?.hash) throw new Error('It didn’t build');
  return { workshop, session, version, folder: join(data, 'workshop', session, 'versions', '1') };
}

describe('desktopWorkshop', () => {
  // The assistant names these paths: none may reach past its workspace.
  it('keeps every file inside the workspace', async () => {
    const { workshop, session, version } = await workshopWithVersion();
    await writeFile(join(data, 'secret.json'), '{"key":"x"}');
    for (const path of [
      '../secret.json',
      '../../secret.json',
      '/etc/passwd.txt',
      'src/../../x.ts',
      '.npmrc',
      'src/run.sh',
    ]) {
      await expect(workshop.write(session, path, 'x'), path).rejects.toThrow(
        /isn’t a workspace file/,
      );
      await expect(workshop.read(session, path), path).rejects.toThrow(/isn’t a workspace file/);
    }
    expect(await readFile(join(data, 'secret.json'), 'utf8')).toBe('{"key":"x"}');
    const key = version.plugin?.key ?? '';
    const served = (path: string) => {
      const address = pluginAddress(`/plugins/probe/${key}/${path}`);
      return address && workshop.file(address);
    };
    expect(served('script.js')?.path).toBe(
      join(data, 'workshop', session, 'versions', '1', 'script.js'),
    );
    expect(served('..%2fworkspace%2fsrc%2fscript.ts')).toBeNull();
    expect(served('..%2f..%2f..%2fsecret.json')).toBeNull();
  });

  // Export and install bind to the hash the person reviewed, never to files changed since.
  it('exports and installs only the version reviewed', async () => {
    const { workshop, session, version, folder } = await workshopWithVersion();
    const hash = version.hash ?? '';
    await expect(workshop.installFolder(session, 1, 'not-the-hash')).rejects.toThrow(/reviewed/);
    const out = await mkdtemp(join(data, 'out-'));
    const exported = await workshop.exportTo(session, 1, hash, out);
    expect((await readPluginFolder(exported)).hash).toBe(hash);
    expect(await workshop.installFolder(session, 1, hash)).toBe(folder);
    await writeFile(join(folder, 'script.js'), 'self.postMessage("changed");');
    await expect(workshop.installFolder(session, 1, hash)).rejects.toThrow(/reviewed/);
    await expect(workshop.exportTo(session, 1, hash, out)).rejects.toThrow(/reviewed/);
  });
});
