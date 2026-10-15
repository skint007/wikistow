/**
 * The Content Security Policy, sent unchanged with every response by the
 * server and by the desktop app's `app://` protocol, except that the server
 * sends the plugin host page with its own (`securityHeadersFor`). It is
 * static so built files stay cacheable.
 *
 * One recorded exception: `'wasm-unsafe-eval'` lets libsodium compile its
 * WebAssembly. It does not permit JavaScript `eval` or `new Function`.
 * `frame-src 'self'` admits the plugin host frame (ADR 0002), which is
 * served with a stricter policy of its own.
 */
export const CSP = [
  "default-src 'none'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self'",
  "img-src 'self' blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "worker-src 'self'",
  "manifest-src 'self'",
  "frame-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ');

/** Headers on every response of the app, wherever it is served from. */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'Content-Security-Policy': CSP,
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
};

/**
 * The sandboxed frame that holds plugin scripts' workers (ADR 0002), and
 * its one script. Both are files of the web build.
 */
export const PLUGIN_HOST_PAGE = '/plugin-host.html';
export const PLUGIN_HOST_SCRIPT = '/plugin-host.js';

/**
 * The host frame's policy, for the app served from `origin`. It runs only
 * the host script, named exactly: its workers inherit this policy, and with
 * `'self'` their `import()` and nested workers' `importScripts` would still
 * reach the server. `sandbox` gives it an opaque origin even when it is
 * opened on its own, and only the app may frame it.
 */
export const pluginHostCsp = (origin: string) =>
  [
    "default-src 'none'",
    `script-src ${origin}${PLUGIN_HOST_SCRIPT}`,
    'worker-src data:',
    "frame-ancestors 'self'",
    'sandbox allow-scripts',
  ].join('; ');

/**
 * The security headers for the file at `path` of the app served from
 * `origin`: `SECURITY_HEADERS`, except that the host page has its own
 * policy and may be framed, and the host script loads from the frame's
 * opaque origin, which the usual `same-origin` resource policy refuses.
 */
export function securityHeadersFor(path: string, origin: string): Record<string, string> {
  if (path === PLUGIN_HOST_PAGE) {
    const { 'X-Frame-Options': _, ...headers } = SECURITY_HEADERS;
    return { ...headers, 'Content-Security-Policy': pluginHostCsp(origin) };
  }
  if (path === PLUGIN_HOST_SCRIPT) {
    return { ...SECURITY_HEADERS, 'Cross-Origin-Resource-Policy': 'cross-origin' };
  }
  return { ...SECURITY_HEADERS };
}
