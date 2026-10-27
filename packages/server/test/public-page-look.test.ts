// A public page looks as the app shows a page (ADR 0005, decision 7): it
// keeps its own copy of the app's palettes, as its one stylesheet is named
// by hash, and draws the app's icons from its own copy of the icon set.
// Nothing else notices when either falls out of step with the app's.
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vite-plus/test';
import { symbolNode } from '../src/public-links/cover.ts';
import { BANNERS, LIGHT, SLATE } from '../src/public-links/page.ts';

const theme = readFileSync(new URL('../../ui/src/styles/theme.css', import.meta.url), 'utf8');

/** The custom properties of the block in `theme.css` that opens with `opening`. */
function block(opening: string): Map<string, string> {
  const start = theme.indexOf(`${opening} {`);
  expect(start, opening).toBeGreaterThanOrEqual(0);
  const body = theme
    .slice(start + opening.length + 2, theme.indexOf('\n}', start))
    .replace(/\/\*[\s\S]*?\*\//g, '');
  return new Map(
    body.split(';').flatMap((declaration) => {
      const match = /^\s*--([\w-]+):\s*([\s\S]+?)\s*$/.exec(declaration);
      return match ? [[match[1]!, match[2]!.replace(/\s+/g, ' ')] as const] : [];
    }),
  );
}

describe('a public page', () => {
  it('has the app’s light and slate palettes and its banners', () => {
    const light = block(':root,\n[data-theme="light"]');
    const slate = block('[data-theme="slate"]');
    for (const [name, value] of Object.entries(LIGHT)) expect(value, name).toBe(light.get(name));
    for (const [name, value] of Object.entries(SLATE)) expect(value, name).toBe(slate.get(name));
    const banners = block(':root');
    for (const [name, value] of Object.entries(BANNERS)) {
      expect(value, name).toBe(banners.get(`banner-${name}`));
    }
  });

  it('draws every icon of the app’s icon set, by the name the app stores', () => {
    const lucide = new URL('../', import.meta.resolve('lucide'));
    const { version } = JSON.parse(readFileSync(new URL('../package.json', lucide), 'utf8'));
    const ui = JSON.parse(readFileSync(new URL('../../ui/package.json', import.meta.url), 'utf8'));
    expect(version).toBe(ui.dependencies['lucide-react']);
    const names = readdirSync(new URL('esm/icons/', lucide))
      .filter((file) => file.endsWith('.mjs') && file !== 'index.mjs')
      .map((file) => file.slice(0, -'.mjs'.length));
    expect(names.length).toBeGreaterThan(1000);
    expect(names.filter((name) => !symbolNode(name))).toEqual([]);
  });
});
