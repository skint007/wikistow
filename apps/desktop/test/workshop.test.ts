import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import { readPluginFolder } from '../src/plugins/folder.ts';
import { pluginAddress } from '../src/plugins/plugins.ts';
import { desktopWorkshop } from '../src/workshop/workshop.ts';

const text = (value: string) => new TextEncoder().encode(value);

const MANIFEST = JSON.stringify({
  id: 'probe',
  name: 'Probe',
  version: '0.1.0',
  api: 1,
  script: 'script.js',
});

/** A build as the page hands it over. */
const BUILD = [
  { path: 'wikistow-plugin.json', data: text(MANIFEST) },
  { path: 'script.js', data: text('export {};') },
  { path: 'source/src/script.ts', data: text('export {};') },
];

let data = '';
afterEach(() => rm(data, { recursive: true, force: true }));

async function workshopWithPreview() {
  data = await mkdtemp(join(tmpdir(), 'workshop-'));
  const workshop = desktopWorkshop(data);
  const hash = await workshop.preview(BUILD);
  return { workshop, hash };
}

describe('desktopWorkshop', () => {
  // App code runs in the page that hands these over: no path may reach past the build.
  it('keeps every file inside a previewed build', async () => {
    const { workshop, hash } = await workshopWithPreview();
    await writeFile(join(data, 'secret.json'), '{"key":"x"}');
    for (const path of ['../secret.json', '../../secret.json', '/etc/passwd', 'a/../../x.js']) {
      const files = [...BUILD, { path, data: text('x') }];
      await expect(workshop.preview(files), path).rejects.toThrow(/isn’t a plain path/);
      await expect(
        workshop.exportTo(files, hash, async () => data),
        path,
      ).rejects.toThrow(/isn’t a plain path/);
    }
    expect(await readFile(join(data, 'secret.json'), 'utf8')).toBe('{"key":"x"}');
    const served = (path: string) => {
      const address = pluginAddress(`/plugins/probe/draft-${hash}/${path}`);
      return address && workshop.file(address);
    };
    expect(served('script.js')?.path).toBe(join(data, 'workshop', hash, 'script.js'));
    expect(served('..%2f..%2fsecret.json')).toBeNull();
    expect(served('..%2fstaging%2fscript.js')).toBeNull();
    // Only under the ID it was built for, and only once handed over.
    const elsewhere = pluginAddress(`/plugins/other/draft-${hash}/script.js`);
    expect(elsewhere && workshop.file(elsewhere)).toBeNull();
    await workshop.clear();
    expect(served('script.js')).toBeNull();
  });

  // Export binds to the hash the person reviewed, never to other files.
  it('exports only the version reviewed', async () => {
    const { workshop, hash } = await workshopWithPreview();
    const out = await mkdtemp(join(data, 'out-'));
    const changed = BUILD.map((file) =>
      file.path === 'script.js' ? { ...file, data: text('self.postMessage("changed");') } : file,
    );
    await expect(workshop.exportTo(changed, hash, async () => out)).rejects.toThrow(/reviewed/);
    const exported = await workshop.exportTo(BUILD, hash, async () => out);
    expect(exported).toBe(join(out, `probe-${hash.slice(0, 8)}`));
    expect((await readPluginFolder(exported ?? '')).hash).toBe(hash);
  });
});
