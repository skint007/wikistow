import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vite-plus/test';
import { Manifest, platformWarnings } from '../src/manifest.ts';

// Most app plugins' bundles carry the SDK's region table, which names
// `app.titlebar` too: only a plugin registering a view there may warn.
const sdk = readFileSync(new URL('../src/host.ts', import.meta.url));
const titlebar = readFileSync(
  new URL('../../../examples/plugins/reading-room/src/ui.tsx', import.meta.url),
);

const claiming = (platforms: Manifest['platforms']) =>
  Manifest.parse({ id: 'clock', name: 'Clock', version: '1.0.0', api: 1, ui: 'ui.js', platforms });
const everywhere = claiming({ desktop: 'full', browser: 'full', phone: 'full' });

describe('platformWarnings', () => {
  it('warns only when the code registers a titlebar view', () => {
    expect(platformWarnings(everywhere, new Map([['ui.js', sdk]]))).toEqual([]);
    expect(platformWarnings(everywhere, new Map([['ui.js', titlebar]]))).toEqual([
      expect.stringContaining('can’t work fully in a computer’s browser or on a phone'),
    ]);
  });

  it('takes partial elsewhere, and says nothing without a claim', () => {
    const files = new Map([['ui.js', titlebar]]);
    const partial = claiming({ desktop: 'full', browser: 'partial', phone: 'none' });
    expect(platformWarnings(partial, files)).toEqual([]);
    expect(platformWarnings({ ...partial, platforms: undefined }, files)).toEqual([]);
  });
});
