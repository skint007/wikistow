// theme.css is the one place the app's theme tokens are set (#286). The
// plugin SDK's `ThemeToken`, its guide and the workshop's prompt name them
// for plugin authors, and nothing else notices when one falls out of step.
import { readFileSync } from 'node:fs';
import {
  BANNER_TOKENS,
  CONTENT_TOKENS,
  PALETTE_TOKENS,
  SHAPE_TOKENS,
} from '@wikistow/plugin-sdk/src/theme.ts';
import { describe, expect, it } from 'vite-plus/test';
import { workshopSystemPrompt } from '../../client/src/workshop-tools.ts';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const theme = read('../src/styles/theme.css').replace(/\/\*[\s\S]*?\*\//g, '');
const names = (text: string) => [...text.matchAll(/--[a-z][a-z0-9-]*/g)].map(([name]) => name);

/** The custom properties `css` sets. */
const declared = (css: string) =>
  new Set([...css.matchAll(/(--[a-z][a-z0-9-]*)\s*:/g)].map(([, name]) => name));

/** Those theme.css sets, but for `@theme inline`'s utility names. */
function tokens() {
  const inline = theme.indexOf('@theme inline {');
  expect(inline).toBeGreaterThanOrEqual(0);
  return declared(theme.slice(0, inline) + theme.slice(theme.indexOf('\n}', inline)));
}

/** The custom properties set in the block of theme.css that opens with `opening`. */
function block(opening: string) {
  const start = theme.indexOf(`${opening} {`);
  expect(start, opening).toBeGreaterThanOrEqual(0);
  return declared(theme.slice(start, theme.indexOf('\n}', start)));
}

const sdk: string[] = [...PALETTE_TOKENS, ...CONTENT_TOKENS, ...BANNER_TOKENS, ...SHAPE_TOKENS];

describe('the theme tokens', () => {
  it('are the ones theme.css sets, no more and no fewer', () => {
    expect(new Set(sdk)).toEqual(tokens());
    expect(new Set(sdk).size).toBe(sdk.length);
  });

  it('are each set by every built-in palette that sets any', () => {
    const light = block(':root,\n[data-theme="light"]');
    for (const palette of ['slate', 'warm', 'oled']) {
      expect(block(`[data-theme="${palette}"]`), palette).toEqual(light);
    }
  });

  it('are listed in full in the SDK’s guide', () => {
    const guide = read('../../plugin-sdk/README.md');
    const start = guide.indexOf('\n### Tokens\n');
    expect(start).toBeGreaterThanOrEqual(0);
    const listed = names(guide.slice(start, guide.indexOf('\n## ', start)));
    expect(new Set(listed)).toEqual(new Set(sdk));
  });

  it('are the only tokens the workshop’s prompt names', () => {
    const named = names(workshopSystemPrompt());
    expect(named.length).toBeGreaterThan(0);
    expect(named.filter((name) => !sdk.includes(name))).toEqual([]);
  });
});
