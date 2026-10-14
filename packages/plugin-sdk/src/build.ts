#!/usr/bin/env node
// `wikistow-plugin build [folder]`: build a plugin folder into `dist/`,
// which the desktop app installs. The folder holds `wikistow-plugin.json`;
// its `ui` and `script` files come from `src/<name>.tsx` or `src/<name>.ts`,
// each bundled into one self-contained ES module; `public/` (styles, themes,
// fonts, images) is copied as it is.
import { existsSync } from 'node:fs';
import { cp, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';
import { build } from 'vite-plus';
import { Manifest, MANIFEST_FILE, manifestFiles } from './manifest.ts';

async function buildPlugin(folder: string) {
  const manifest = Manifest.parse(JSON.parse(await readFile(join(folder, MANIFEST_FILE), 'utf8')));
  const out = join(folder, 'dist');
  await rm(out, { recursive: true, force: true });
  for (const file of [manifest.ui, manifest.script]) {
    if (!file) continue;
    const name = basename(file, extname(file));
    const entry = ['.tsx', '.ts'].map((ext) => join(folder, 'src', name + ext)).find(existsSync);
    if (!entry) throw new Error(`No src/${name}.tsx or src/${name}.ts for ${file}`);
    await build({
      root: folder,
      configFile: false,
      logLevel: 'warn',
      publicDir: false,
      define: { 'process.env.NODE_ENV': JSON.stringify('production') },
      build: {
        outDir: out,
        emptyOutDir: false,
        // Readable, for whoever approves it.
        minify: false,
        target: 'es2024',
        lib: { entry, formats: ['es'], fileName: () => file },
        rolldownOptions: { output: { codeSplitting: false } },
      },
    });
  }
  if (existsSync(join(folder, 'public')))
    await cp(join(folder, 'public'), out, { recursive: true });
  await writeFile(join(out, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
  const missing = manifestFiles(manifest).filter((file) => !existsSync(join(out, file)));
  if (missing.length > 0)
    throw new Error(`The manifest names files dist/ lacks: ${missing.join(', ')}`);
  return out;
}

const [command, folder = '.'] = process.argv.slice(2);
if (command !== 'build') {
  process.stderr.write('Usage: wikistow-plugin build [folder]\n');
  process.exit(2);
}
buildPlugin(resolve(folder)).then(
  (out) => process.stdout.write(`Built ${out}\n`),
  (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  },
);
