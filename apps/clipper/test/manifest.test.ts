// The store builds ask for exactly what ADR 0017 (decision 8) lists, and
// nothing a store review would weigh against them: no host permissions,
// no content script on every page, nothing a page or another extension
// can reach. Only the tests' build has a key or host permissions.
import { describe, expect, test } from 'vite-plus/test';
import { manifest } from '../src/manifest.ts';

const PERMISSIONS = ['nativeMessaging', 'activeTab', 'scripting', 'contextMenus', 'storage'];

describe('the store manifests', () => {
  for (const target of ['chrome', 'firefox'] as const) {
    test(`${target} asks only for what clipping needs`, () => {
      const built: Record<string, unknown> = manifest(target, {
        version: '1.2.3',
        firefoxId: 'clipper@example.test',
      });
      expect(built['manifest_version']).toBe(3);
      expect(built['version']).toBe('1.2.3');
      expect(built['permissions']).toEqual(PERMISSIONS);
      for (const key of [
        'host_permissions',
        'optional_permissions',
        'optional_host_permissions',
        'content_scripts',
        'externally_connectable',
        'web_accessible_resources',
        'key',
      ]) {
        expect(built, key).not.toHaveProperty(key);
      }
    });
  }

  test('Firefox takes its ID from the build, with built-in data consent', () => {
    expect(manifest('firefox', { version: '1.0.0', firefoxId: 'a@b.test' })).toMatchObject({
      background: { scripts: ['background.js'] },
      browser_specific_settings: {
        gecko: {
          id: 'a@b.test',
          strict_min_version: '140.0',
          data_collection_permissions: { required: ['websiteContent', 'browsingActivity'] },
        },
      },
    });
    expect(manifest('chrome', { version: '1.0.0' })).toMatchObject({
      background: { service_worker: 'background.js' },
    });
  });
});
