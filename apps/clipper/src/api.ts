// The browser's extension API: Firefox's `browser`, whose calls return
// promises, or Chrome's `chrome`, whose Manifest V3 calls do too. Both are
// used the same way here.
export const api: typeof chrome = typeof browser === 'undefined' ? chrome : browser;

/** The browser, as `hello` names it to the app. */
export const browserName = () =>
  api.runtime.getURL('').startsWith('moz-extension:') ? 'firefox' : 'chromium';
