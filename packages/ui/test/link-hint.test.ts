import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

// `desktop` is read once, as the module loads, so each test loads it afresh.
const load = async (bridge: object | undefined) => {
  vi.resetModules();
  if (bridge) vi.stubGlobal('window', { wikistowDesktop: bridge });
  return import('../src/desktop.ts');
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('a link hint', () => {
  it('shows above the link in the desktop app, where below the pointer covers it', async () => {
    const { linkHint } = await load({});
    expect(linkHint('https://example.com/a/b')).toEqual({
      'data-hint': 'https://\u200Bexample.com/\u200Ba/\u200Bb',
      'data-hint-side': 'top',
    });
  });

  it('is left out in a browser, which shows the address itself', async () => {
    const { linkHint } = await load(undefined);
    expect(linkHint('https://example.com/a/b')).toEqual({});
  });
});
