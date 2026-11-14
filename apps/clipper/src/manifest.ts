// The extension's manifest for each browser (ADR 0017, decision 8): one
// Manifest V3 extension, a service worker in Chrome and a background
// script in Firefox, asking only for what clipping needs and no host
// permissions. scripts/assemble.ts writes it into each build.

/** What every build asks for, and nothing more (ADR 0017, decision 8). */
export const PERMISSIONS = [
  'nativeMessaging',
  'activeTab',
  'scripting',
  'contextMenus',
  'storage',
] as const;

export type Target = 'chrome' | 'firefox';

export type ManifestOptions = {
  version: string;
  /** Firefox's add-on ID, which its listing fixes (step 7). A build setting, never written here. */
  firefoxId?: string;
  /**
   * For the tests alone: Chrome's public key, which fixes an unpacked
   * build's ID, and host permissions to clip, and take screenshots, from
   * the tests' site without the toolbar's click, which grants `activeTab`
   * only by hand.
   */
  test?: { key?: string; hosts: string[] };
};

export function manifest(target: Target, options: ManifestOptions) {
  const icons = {
    16: 'icons/icon-16.png',
    32: 'icons/icon-32.png',
    48: 'icons/icon-48.png',
    128: 'icons/icon-128.png',
  };
  return {
    manifest_version: 3,
    name: 'WikiStow Web Clipper',
    short_name: 'WikiStow',
    description:
      'Save links, selections, articles, whole pages and screenshots to your WikiStow desktop app, as drafts.',
    version: options.version,
    homepage_url: 'https://github.com/skint007/wikistow',
    icons,
    action: { default_title: 'Clip to WikiStow', default_popup: 'popup.html', default_icon: icons },
    background:
      target === 'chrome' ? { service_worker: 'background.js' } : { scripts: ['background.js'] },
    permissions: [...PERMISSIONS],
    ...(options.test ? { host_permissions: options.test.hosts } : {}),
    commands: {
      _execute_action: {
        suggested_key: { default: 'Alt+Shift+W' },
        description: 'Open the clipper',
      },
      send: {
        suggested_key: { default: 'Alt+Shift+S' },
        description: 'Send the selection, or else the link, to WikiStow',
      },
    },
    ...(target === 'chrome'
      ? {
          // `action.openPopup`, which the context menu and the shortcut use
          // before there's a folder to send to.
          minimum_chrome_version: '127',
          ...(options.test?.key ? { key: options.test.key } : {}),
        }
      : {
          browser_specific_settings: {
            gecko: {
              ...(options.firefoxId ? { id: options.firefoxId } : {}),
              // The first Firefox with built-in data consent.
              strict_min_version: '140.0',
              // Sending to the desktop app leaves the browser, so it counts
              // as transmission (Mozilla's built-in data consent).
              data_collection_permissions: { required: ['websiteContent', 'browsingActivity'] },
            },
            // Firefox for Android can't clip, having no native messaging,
            // and only says so; its first version with data consent.
            gecko_android: { strict_min_version: '142.0' },
          },
        }),
  };
}
