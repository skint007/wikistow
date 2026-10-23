// The HTML a public page is served as (ADR 0005, decision 7): a whole
// document with one inline stylesheet, named in its policy by hash, and no
// script at all.
import { createHash } from 'node:crypto';

const CSS = `
:root { color-scheme: light dark; --fg: #1d1d1f; --muted: #5f6368; --bg: #fff; --panel: #f3f3f1; --line: #dcdcd8; --link: #2b5fb4; }
@media (prefers-color-scheme: dark) { :root { --fg: #ececea; --muted: #a3a3a0; --bg: #161616; --panel: #232323; --line: #3a3a3a; --link: #8ab4f8; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 15.5px/1.65 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 46rem; margin: 0 auto; padding: 2.5rem 1.25rem 1rem; overflow-wrap: break-word; }
footer { max-width: 46rem; margin: 0 auto; padding: 1rem 1.25rem 2.5rem; color: var(--muted); font-size: 0.85rem; border-top: 1px solid var(--line); }
.page-title { font-size: 2rem; font-weight: 800; line-height: 1.25; margin: 0 0 1.5rem; }
.page-body > * + * { margin-top: 1rem; }
.page-body > :first-child { margin-top: 0; }
.page-body h1 { font-size: 1.5rem; font-weight: 800; }
.page-body h2 { font-size: 1.25rem; font-weight: 800; margin-top: 2rem; }
.page-body h3 { font-size: 1.125rem; font-weight: 800; margin-top: 1.5rem; }
.page-body :is(h1, h2, h3, h4, h5, h6, p, ul, ol, blockquote, pre, table) { margin-bottom: 0; }
.page-body :is(ul, ol) { padding-left: 1.5rem; }
.page-body a { color: var(--link); }
.page-body img { max-width: 100%; border-radius: 6px; }
.page-body :is(blockquote, .markdown-alert) { margin-left: 0; margin-right: 0; padding: 0.5rem 1rem; border-left: 4px solid var(--line); border-radius: 6px; background: var(--panel); }
.page-body .markdown-alert-title { margin: 0 0 0.25rem; font-weight: 700; }
.page-body .markdown-alert-note { border-color: #2b5fb4; }
.page-body .markdown-alert-tip { border-color: #2e7d4f; }
.page-body .markdown-alert-important { border-color: #6d3fc0; }
.page-body .markdown-alert-warning { border-color: #a86a00; }
.page-body .markdown-alert-caution { border-color: #b02525; }
.page-body code { font: 0.9em ui-monospace, SFMono-Regular, Menlo, monospace; background: var(--panel); border-radius: 4px; padding: 0.1em 0.35em; }
.page-body pre { overflow-x: auto; background: var(--panel); border-radius: 6px; padding: 1rem; }
.page-body pre code { background: none; padding: 0; }
.page-body .code-block { background: var(--panel); border-radius: 6px; overflow: hidden; }
.page-body .code-block > pre { margin: 0; padding-top: 0.25rem; border-radius: 0; }
.page-body .code-language { padding: 0.5rem 1rem 0; font: 0.75rem ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--muted); }
.page-body :is(.hljs-comment, .hljs-quote, .hljs-meta) { color: var(--muted); }
.page-body :is(.hljs-comment, .hljs-quote, .hljs-emphasis) { font-style: italic; }
.page-body :is(.hljs-keyword, .hljs-selector-tag, .hljs-literal, .hljs-doctag) { color: #8a3ffc; }
.page-body :is(.hljs-string, .hljs-regexp, .hljs-symbol, .hljs-addition) { color: #2e7d4f; }
.page-body :is(.hljs-number, .hljs-variable, .hljs-template-variable, .hljs-attr, .hljs-attribute) { color: #a86a00; }
.page-body :is(.hljs-title, .hljs-section, .hljs-name, .hljs-type, .hljs-built_in, .hljs-selector-class) { color: var(--link); }
.page-body .hljs-deletion { color: #b02525; }
.page-body .hljs-strong { font-weight: 700; }
.page-body .table-scroll { overflow-x: auto; }
.page-body table { width: 100%; border-collapse: collapse; font-size: 0.875rem; }
.page-body :is(th, td) { border: 1px solid var(--line); padding: 0.5rem 0.75rem; text-align: left; }
.page-body th { background: var(--panel); }
.page-body :is(.not-loaded, .not-available) { color: var(--muted); background: var(--panel); border-radius: 4px; padding: 0.1em 0.4em; font-size: 0.875rem; }
.note { background: var(--panel); border-radius: 6px; padding: 0.75rem; font-size: 0.875rem; }
.as-written { white-space: pre-wrap; overflow-wrap: anywhere; font: 0.875rem ui-monospace, SFMono-Regular, Menlo, monospace; }
`;

/**
 * A public page's policy: nothing loads but its images from this server
 * and its one stylesheet, named by hash, and nothing in it can run.
 */
export const PAGE_CSP = [
  "default-src 'none'",
  "img-src 'self'",
  `style-src 'sha256-${createHash('sha256').update(CSS).digest('base64')}'`,
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

/** A public page's file: nothing in it can load or run, should it be opened on its own. */
export const FILE_CSP = "default-src 'none'; sandbox";

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** `text` as HTML text or an attribute's value. */
export const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);

/** What a body that couldn't be rendered shows: `note`, then the body as written. */
export const writtenHtml = (markdown: string, note: string) =>
  `<p class="note" role="note">${escapeHtml(note)}</p>\n<pre class="as-written">${escapeHtml(markdown)}</pre>`;

function document(title: string, main: string) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(title)}</title>
<style>${CSS}</style>
</head>
<body>
<main>
${main}
</main>
<footer>Shared from WikiStow with a public link.</footer>
</body>
</html>
`;
}

/** A public page: its title, and its body as rendered, its gaps filled in. */
export const publicPageHtml = (title: string, body: string) =>
  document(
    title,
    `<h1 class="page-title">${escapeHtml(title)}</h1>\n<article class="page-body">\n${body}\n</article>`,
  );

/** A public page with no copy to show yet. */
export const updatingPageHtml = () =>
  document(
    'Being updated',
    '<h1 class="page-title">This page is being updated</h1>\n<p>Try again in a little while.</p>',
  );

/** Every unknown id, link turned off and missing file gets this. */
export const notFoundHtml = () =>
  document(
    'Not found',
    `<h1 class="page-title">Page not found</h1>\n<p>This link doesn't lead to a page. It may have been turned off.</p>`,
  );
