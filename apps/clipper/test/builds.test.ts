// Which builds scripts/assemble.ts lays out: the store builds never carry
// a key, and the keyed build, for checks by hand, only when asked.
import { describe, expect, test } from 'vite-plus/test';
import { TEST_ID, TEST_KEY } from '../e2e/test-key.ts';
import { builds, chromeId, FIREFOX_PLACEHOLDER } from '../scripts/builds.ts';

const pem = (key: string) =>
  `-----BEGIN PUBLIC KEY-----\n${key.match(/.{1,64}/g)!.join('\n')}\n-----END PUBLIC KEY-----\n`;

describe('the builds', () => {
  test('the stores’ zips have no key, and Firefox names the ID set', () => {
    const list = builds('1.2.3', { CLIPPER_FIREFOX_ID: 'a@b.test', CLIPPER_CHROME_KEY: TEST_KEY });
    const zipped = list.filter((build) => build.zip);
    expect(zipped.map((build) => build.name)).toEqual(['chrome', 'firefox']);
    for (const build of zipped) expect(build.manifest).not.toHaveProperty('key');
    expect(list.find((build) => build.name === 'firefox')?.manifest).toMatchObject({
      browser_specific_settings: { gecko: { id: 'a@b.test' } },
    });
  });

  test('without settings: a placeholder Firefox ID, and no keyed build', () => {
    const list = builds('1.2.3', {});
    expect(list.map((build) => build.name)).toEqual(['chrome', 'firefox', 'chrome-test']);
    expect(list[1]?.manifest).toMatchObject({
      browser_specific_settings: { gecko: { id: FIREFOX_PLACEHOLDER } },
    });
  });

  test('the store’s key, as the dashboard shows it, gives the keyed build its ID', () => {
    const keyed = builds('1.2.3', { CLIPPER_CHROME_KEY: pem(TEST_KEY) }).find(
      (build) => build.name === 'chrome-keyed',
    );
    expect(keyed).toMatchObject({ zip: false, manifest: { key: TEST_KEY } });
    // Only the key: the store build's manifest otherwise.
    const { key: _, ...rest } = keyed!.manifest;
    expect(rest).toEqual(builds('1.2.3', {})[0]?.manifest);
    expect(chromeId(TEST_KEY)).toBe(TEST_ID);
  });

  test('a key that isn’t a public key is refused', () => {
    expect(() => builds('1.2.3', { CLIPPER_CHROME_KEY: 'bm90IGEga2V5' })).toThrow();
  });
});
