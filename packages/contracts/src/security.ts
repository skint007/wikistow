/**
 * The Content Security Policy, sent unchanged with every response by the
 * server and by the desktop app's `app://` protocol, except that both send
 * the plugin host page with its own (`securityHeadersFor`). It is static so
 * built files stay cacheable.
 *
 * One recorded exception: `'wasm-unsafe-eval'` lets libsodium compile its
 * WebAssembly. It does not permit JavaScript `eval` or `new Function`.
 * `frame-src 'self'` admits the plugin host frame (ADR 0002) and the
 * diagram host frame (ADR 0010), each served with a policy of its own.
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
 * The folder of the web build holding the sandboxed frame that draws
 * Mermaid diagrams (ADR 0010), and nothing else: its page, its script and
 * Mermaid's own build, each named by its hash. Cached for good like the
 * rest of `/assets`, so the frame loads offline from the browser's cache
 * (#333), as its requests never go through the service worker.
 */
export const DIAGRAM_FILES = '/assets/diagram/';

/** Whether `path` is the diagram frame's page. */
const diagramHostPage = (path: string) => path.startsWith(DIAGRAM_FILES) && path.endsWith('.html');

/**
 * The diagram frame's policy: only the scripts in its folder, and no
 * requests. Mermaid writes `<style>` elements and style attributes to
 * measure text, which only this frame's opaque origin may do.
 */
export const diagramHostCsp = (origin: string) =>
  [
    "default-src 'none'",
    `script-src ${origin}${DIAGRAM_FILES}`,
    "style-src 'unsafe-inline'",
    "frame-ancestors 'self'",
    'sandbox allow-scripts',
  ].join('; ');

/**
 * The security headers for the file at `path` of the app served from
 * `origin`: `SECURITY_HEADERS`, except that the host pages have their own
 * policies and may be framed, and their scripts load from the frames'
 * opaque origins, which the usual `same-origin` resource policy refuses.
 */
export function securityHeadersFor(path: string, origin: string): Record<string, string> {
  if (path === PLUGIN_HOST_PAGE || diagramHostPage(path)) {
    const { 'X-Frame-Options': _, ...headers } = SECURITY_HEADERS;
    const csp = path === PLUGIN_HOST_PAGE ? pluginHostCsp(origin) : diagramHostCsp(origin);
    return { ...headers, 'Content-Security-Policy': csp };
  }
  if (path === PLUGIN_HOST_SCRIPT || path.startsWith(DIAGRAM_FILES)) {
    return { ...SECURITY_HEADERS, 'Cross-Origin-Resource-Policy': 'cross-origin' };
  }
  return { ...SECURITY_HEADERS };
}
