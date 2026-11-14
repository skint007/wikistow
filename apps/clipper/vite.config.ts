import { defineConfig } from 'vite-plus';
import type { PackUserConfig } from 'vite-plus/pack';

// `vp pack` builds each of the extension's scripts on its own, as one
// classic script with everything it imports: the background (Chrome's
// service worker, Firefox's background script), the content scripts the
// background injects (the capture, and the overlay for a screenshot's
// area), and the popup's. Unminified, so a store's reviewer
// can read what runs (ADR 0017, decision 8). scripts/assemble.ts then
// lays out each browser's build around them.
const script = (name: string, entry: string): PackUserConfig => ({
  entry: { [name]: entry },
  format: 'iife',
  platform: 'browser',
  target: ['chrome127', 'firefox140'],
  outDir: 'dist/scripts',
  // The three builds write here at once, so none clears it.
  clean: false,
  minify: false,
  dts: false,
  deps: { alwaysBundle: [/.*/], onlyBundle: false },
});

export default defineConfig({
  pack: [
    script('background', 'src/background.ts'),
    script('capture', 'src/capture.ts'),
    script('area', 'src/area.ts'),
    script('popup', 'src/popup/popup.ts'),
  ],
});
