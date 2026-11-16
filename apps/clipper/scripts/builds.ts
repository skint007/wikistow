// Which builds scripts/assemble.ts lays out, and each one's manifest
// (src/manifest.ts), from the build's settings:
//
// - CLIPPER_FIREFOX_ID names Firefox's add-on ID. CI takes it from the
//   repository variable of that name. Without it, a build names a
//   placeholder no app trusts.
// - CLIPPER_CHROME_KEY, the Chrome Web Store's public key for the
//   extension, adds dist/chrome-keyed: the store build with that `key`, so
//   an unpacked copy has the store's ID, for checks by hand. It isn't
//   zipped, and the store's zip never has a `key`: the store keeps its own.
import { createHash, createPublicKey } from 'node:crypto';
import { TEST_KEY } from '../e2e/test-key.ts';
import { manifest, type Target } from '../src/manifest.ts';

export type Build = {
  name: string;
  target: Target;
  manifest: ReturnType<typeof manifest> & { key?: string };
  /** Zipped beside it, as the store takes it. */
  zip: boolean;
};

export const FIREFOX_PLACEHOLDER = 'web-clipper-dev@wikistow.invalid';

/** The ID Chrome gives an extension with this public key: its SHA-256's first 32 hex digits, as `a` to `p`. */
export function chromeId(key: string): string {
  const der = Buffer.from(key, 'base64');
  // Throws unless it's a public key, as the dashboard shows it.
  createPublicKey({ key: der, format: 'der', type: 'spki' });
  return createHash('sha256')
    .update(der)
    .digest('hex')
    .slice(0, 32)
    .replace(/[0-9a-f]/g, (digit) => String.fromCharCode(97 + Number.parseInt(digit, 16)));
}

export function builds(version: string, env: Record<string, string | undefined>): Build[] {
  const firefoxId = env['CLIPPER_FIREFOX_ID'] || FIREFOX_PLACEHOLDER;
  // The dashboard shows the key with PEM's lines; the manifest takes its base64 alone.
  const chromeKey = (env['CLIPPER_CHROME_KEY'] ?? '')
    .replace(/-+(BEGIN|END) PUBLIC KEY-+/g, '')
    .replace(/\s+/g, '');
  const list: Build[] = [
    { name: 'chrome', target: 'chrome', manifest: manifest('chrome', { version }), zip: true },
    {
      name: 'firefox',
      target: 'firefox',
      manifest: manifest('firefox', { version, firefoxId }),
      zip: true,
    },
    {
      name: 'chrome-test',
      target: 'chrome',
      // `<all_urls>`, not the tests' site alone: the browser's screenshot
      // takes it or `activeTab`, which only the toolbar's click grants.
      manifest: manifest('chrome', { version, test: { key: TEST_KEY, hosts: ['<all_urls>'] } }),
      zip: false,
    },
  ];
  if (chromeKey) {
    chromeId(chromeKey);
    list.push({
      name: 'chrome-keyed',
      target: 'chrome',
      manifest: { ...manifest('chrome', { version }), key: chromeKey },
      zip: false,
    });
  }
  return list;
}
