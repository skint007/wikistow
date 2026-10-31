// The HTML a public page is served as (ADR 0005, decision 7): a
// whole document with one inline stylesheet, named in its policy by hash,
// and no script at all. It looks as the app shows a page: its palette (light,
// or slate where the reader's system is dark), its font, the page in a card
// under its cover, and the reader's styles for the body.
import { BANNER_PRESETS, type BannerPreset } from '@wikistow/client';
import { createHash } from 'node:crypto';
import { NO_COVER, symbolNode, type PublicCover } from './cover.ts';
import { PAGE_FONTS } from './fonts.ts';
import type { PublicPage } from './links.ts';
import type { Outline } from './segments.ts';

// The app's palettes, from `packages/ui/src/styles/theme.css`, only the
// tokens a public page uses. A test holds them to the app's.
export const LIGHT = {
  background: '#f4f1ec',
  foreground: '#2d2a26',
  card: '#ffffff',
  border: '#ece6dc',
  muted: '#f4f1ec',
  'muted-foreground': '#71695f',
  'subtle-foreground': '#6b645a',
  primary: '#c8461a',
  'primary-2': '#d4552a',
  'primary-soft': '#fff0ea',
  'primary-ink': '#c2410c',
  destructive: '#c92a2a',
  'status-published': '#e3f6e9',
  'status-published-foreground': '#1f7a45',
  'status-draft': '#fff3d6',
  'status-draft-foreground': '#9a6200',
  table: '#faf8f4',
  'table-head': '#f1ece4',
  'folder-blue': '#e4eeff',
  'folder-purple': '#efe8ff',
  'card-shadow': '0 1px 2px rgba(60, 40, 20, 0.06), 0 4px 16px rgba(60, 40, 20, 0.05)',
  cover:
    'radial-gradient(circle at 20% 30%, #ffd8a8 0, transparent 55%), radial-gradient(circle at 80% 20%, #ffc9c9 0, transparent 50%), linear-gradient(120deg, #ffe8cc, #fff4e6)',
} as const;

export const SLATE: Record<keyof typeof LIGHT, string> = {
  background: '#0a0f1c',
  foreground: '#e2e8f0',
  card: '#111a2b',
  border: '#1f2a3d',
  muted: '#1a2436',
  'muted-foreground': '#8a98b0',
  'subtle-foreground': '#a3b0c6',
  primary: '#2dd4bf',
  'primary-2': '#5eead4',
  'primary-soft': 'rgba(45, 212, 191, 0.13)',
  'primary-ink': '#5eead4',
  destructive: '#f87171',
  'status-published': 'rgba(74, 222, 128, 0.12)',
  'status-published-foreground': '#86efac',
  'status-draft': 'rgba(251, 191, 36, 0.12)',
  'status-draft-foreground': '#fcd34d',
  table: '#0f1727',
  'table-head': '#1a2436',
  'folder-blue': 'rgba(96, 165, 250, 0.17)',
  'folder-purple': 'rgba(167, 139, 250, 0.18)',
  'card-shadow': 'inset 0 1px 0 rgba(255, 255, 255, 0.03), 0 8px 24px rgba(0, 0, 0, 0.4)',
  cover:
    'radial-gradient(circle at 20% 35%, rgba(45, 212, 191, 0.35) 0, transparent 55%), radial-gradient(circle at 80% 15%, rgba(99, 102, 241, 0.35) 0, transparent 50%), linear-gradient(120deg, #10213a, #0f1a2c)',
};

/** The banner presets, which look the same in every palette. */
export const BANNERS: Record<BannerPreset, string> = {
  sunrise: 'linear-gradient(120deg, #ff9a8b, #ff6a88 45%, #ffd36e)',
  ocean: 'linear-gradient(120deg, #0f4c75, #1b9aaa 55%, #8fd3c7)',
  meadow: 'linear-gradient(120deg, #3a7d44, #8bbf5b 55%, #e9e4a6)',
  lavender: 'linear-gradient(120deg, #6d5bd0, #a78bfa 50%, #f0c4e4)',
  dusk: 'linear-gradient(120deg, #1e1b4b, #7c3aed 55%, #f472b6)',
  stone: 'linear-gradient(120deg, #334155, #64748b 55%, #cbd5e1)',
};

/**
 * A banner image's focal point, height and fade as the page shows them, in
 * steps of 5: a class each, as the policy allows no style attribute.
 */
const STEP = 5;
const step = (value: number) => Math.round(value / STEP) * STEP;
const STEPS = Array.from({ length: 100 / STEP + 1 }, (_, i) => i * STEP);
/** The class for a banner image's height or fade, none at 0: the usual band, with a hard edge. */
const stepClass = (name: 'height' | 'fade', value: number | undefined) =>
  step(value ?? 0) > 0 ? [`${name}-${step(value ?? 0)}`] : [];

/** The band's height in pixels at `height` 0 to 100, as the app's `CoverBand`: up to three times `base`. */
const coverHeight = (base: number, height: number) => base + (base * 2 * height) / 100;

const tokens = (palette: Record<string, string>) =>
  Object.entries(palette)
    .map(([name, value]) => `--${name}: ${value};`)
    .join(' ');

const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace';

const CSS = `
${PAGE_FONTS.map(
  ({ file, unicodeRange }) =>
    `@font-face { font-family: "Nunito Variable"; font-style: normal; font-display: swap; font-weight: 200 1000; src: url(/fonts/${file}) format("woff2-variations"); unicode-range: ${unicodeRange}; }`,
).join('\n')}
:root { color-scheme: light dark; ${tokens(LIGHT)} --link-blue: #2b5fb4; --alert-important: #6d3fc0; --alert-caution: #b02525; }
@media (prefers-color-scheme: dark) { :root { ${tokens(SLATE)} --link-blue: #8ab4f8; --alert-important: #c4b5fd; --alert-caution: var(--destructive); } }
${BANNER_PRESETS.map((name) => `.banner-${name} { --cover: ${BANNERS[name]}; }`).join('\n')}
${STEPS.map((n) => `.focal-${n} { object-position: 50% ${n}%; }`).join('\n')}
${STEPS.slice(1)
  .map(
    (n) =>
      `.cover.fade-${n} { background: none; } .fade-${n} > .banner-img { mask-image: linear-gradient(#000 ${100 - n}%, transparent); }`,
  )
  .join('\n')}
* { box-sizing: border-box; }
html { scroll-behavior: smooth; }
@media (prefers-reduced-motion: reduce) { html { scroll-behavior: auto; } }
body { margin: 0; background: var(--background); color: var(--foreground); font: 15.5px/1.65 ui-rounded, "SF Pro Rounded", "Nunito Variable", "Nunito", "Segoe UI", system-ui, sans-serif; }
.layout { max-width: 46rem; margin: 0 auto; padding: 2.25rem 1.5rem 0; }
.contents { display: none; }
@media (min-width: 960px) {
  .layout.with-contents { max-width: 61.5rem; display: grid; grid-template-columns: 14rem minmax(0, 46rem); gap: 1.5rem; }
  .contents { display: grid; align-content: start; gap: 2px; position: sticky; top: 1rem; align-self: start; margin-top: 9rem; font-size: 0.85rem; line-height: 1.4; }
}
.contents p { margin: 0 0 0.4rem 0.6rem; font-size: 0.72rem; font-weight: 800; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted-foreground); }
.contents a { color: var(--subtle-foreground); text-decoration: none; padding: 0.3rem 0.6rem; border-radius: 10px; overflow-wrap: anywhere; }
.contents a.sub { padding-left: 1.4rem; }
.contents a:hover, .contents a:focus-visible { background: var(--primary-soft); color: var(--primary-ink); }
.contents a:focus-visible { outline: 2px solid var(--primary); outline-offset: 1px; }
.column { min-width: 0; }
.card { background: var(--card); border-radius: 18px; box-shadow: var(--card-shadow); }
.cover { position: relative; height: 120px; border-radius: 18px 18px 0 0; background: var(--cover); background-size: cover; }
.banner-img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; border-radius: inherit; }
${STEPS.slice(1)
  .map((n) => `.cover.height-${n} { height: ${coverHeight(120, n)}px; }`)
  .join('\n')}
.badge { position: absolute; left: 44px; bottom: -26px; width: 72px; height: 72px; display: grid; place-items: center; overflow: hidden; border-radius: 18px; background: var(--card); font-size: 48px; line-height: 1; box-shadow: 0 4px 14px rgba(0, 0, 0, 0.18); }
.badge img { width: 100%; height: 100%; object-fit: cover; }
.badge svg { width: 58%; height: 58%; color: var(--primary); }
.head { padding: 4.25rem 2.75rem 0; }
.no-badge .head { padding-top: 2.25rem; }
.page-title { margin: 0; font-size: 2rem; font-weight: 800; line-height: 1.2; letter-spacing: -0.01em; overflow-wrap: break-word; }
.meta { display: flex; flex-wrap: wrap; align-items: center; gap: 0.6rem; margin: 0.6rem 0 0; font-size: 0.8rem; color: var(--muted-foreground); }
.pill { padding: 0.1rem 0.65rem; border-radius: 999px; background: var(--status-published); color: var(--status-published-foreground); font-weight: 700; }
.page-body { padding: 1.6rem 2.75rem 2.75rem; overflow-wrap: break-word; }
.page-body > * { margin-bottom: 0; }
.page-body > * + * { margin-top: 1rem; }
.page-body > :first-child { margin-top: 0; }
.page-body :is(h1, h2, h3, h4, h5, h6) { scroll-margin-top: 1rem; }
.page-body h1 { font-size: 1.5rem; font-weight: 800; }
.page-body h2 { font-size: 1.25rem; font-weight: 800; margin-top: 2rem; }
.page-body h3 { font-size: 1.125rem; font-weight: 800; margin-top: 1.5rem; }
.page-body :is(ul, ol) { padding-left: 1.5rem; }
.page-body a { color: var(--primary); text-underline-offset: 2px; }
.page-body img { max-width: 100%; border-radius: 12px; }
.page-body hr { border: 0; border-top: 1px solid var(--border); }
.page-body :is(blockquote, .markdown-alert) { margin-left: 0; margin-right: 0; padding: 0.5rem 1rem; border-left: 4px solid var(--border); border-radius: 12px; background: var(--muted); color: var(--subtle-foreground); }
.page-body :is(blockquote, .markdown-alert) > * { margin: 0; }
.page-body :is(blockquote, .markdown-alert) > * + * { margin-top: 0.5rem; }
.page-body .markdown-alert { border-color: var(--alert); color: var(--foreground); }
.page-body .markdown-alert-title { margin-bottom: 0.25rem; font-weight: 700; color: var(--alert); }
.page-body .markdown-alert-title + * { margin-top: 0; }
.page-body .markdown-alert-note { background: var(--folder-blue); --alert: var(--link-blue); }
.page-body .markdown-alert-tip { background: var(--status-published); --alert: var(--status-published-foreground); }
.page-body .markdown-alert-important { background: var(--folder-purple); --alert: var(--alert-important); }
.page-body .markdown-alert-warning { background: var(--status-draft); --alert: var(--status-draft-foreground); }
.page-body .markdown-alert-caution { background: color-mix(in srgb, var(--destructive) 10%, transparent); --alert: var(--alert-caution); }
.page-body code { font: 0.9em ${MONO}; background: var(--muted); border-radius: 10px; padding: 0.125rem 0.375rem; }
.page-body pre { overflow-x: auto; background: var(--muted); border-radius: 12px; padding: 1rem; }
.page-body pre code { background: none; padding: 0; }
.page-body .code-block { background: var(--muted); border-radius: 12px; overflow: hidden; }
.page-body .code-block > pre { margin: 0; padding-top: 0.25rem; border-radius: 0; }
.page-body .code-language { padding: 0.5rem 1rem 0; font: 0.75rem ${MONO}; color: var(--subtle-foreground); }
.page-body :is(.hljs-comment, .hljs-quote, .hljs-meta) { color: var(--subtle-foreground); }
.page-body :is(.hljs-comment, .hljs-quote, .hljs-emphasis) { font-style: italic; }
.page-body :is(.hljs-keyword, .hljs-selector-tag, .hljs-literal, .hljs-doctag) { color: var(--primary-ink); }
.page-body :is(.hljs-string, .hljs-regexp, .hljs-symbol, .hljs-addition) { color: var(--status-published-foreground); }
.page-body :is(.hljs-number, .hljs-variable, .hljs-template-variable, .hljs-attr, .hljs-attribute) { color: var(--status-draft-foreground); }
.page-body :is(.hljs-title, .hljs-section, .hljs-name, .hljs-type, .hljs-built_in, .hljs-selector-class) { color: var(--link-blue); }
.page-body .hljs-deletion { color: var(--destructive); }
.page-body .hljs-strong { font-weight: 700; }
.page-body .table-scroll { overflow-x: auto; }
.page-body table { width: 100%; border-collapse: separate; border-spacing: 0; overflow: hidden; border-radius: 12px; background: var(--table); font-size: 0.875rem; }
.page-body th { background: var(--table-head); padding: 0.5rem 0.75rem; text-align: left; font-weight: 700; }
.page-body td { border-top: 1px solid var(--border); padding: 0.5rem 0.75rem; }
.page-body kbd { font: 0.85em ${MONO}; border: 1px solid var(--border); border-bottom-width: 2px; border-radius: 6px; background: var(--card); padding: 0.125rem 0.375rem; }
.page-body summary { cursor: pointer; font-weight: 700; }
.page-body details > * + * { margin-top: 0.5rem; }
.page-body :is(.not-loaded, .not-available) { color: var(--muted-foreground); background: var(--muted); border-radius: 10px; padding: 0.1em 0.45em; font-size: 0.875rem; }
.note { margin: 0; background: var(--muted); border-radius: 12px; padding: 0.75rem 1rem; font-size: 0.875rem; }
.as-written { white-space: pre-wrap; overflow-wrap: anywhere; font: 0.875rem ${MONO}; }
footer { display: flex; align-items: center; justify-content: center; gap: 0.5rem; padding: 1.5rem 1rem 2rem; font-size: 0.8rem; color: var(--muted-foreground); }
footer svg { width: 18px; height: 18px; flex: none; }
@media (max-width: 559px) {
  .layout { padding: 0; }
  .card { border-radius: 0; box-shadow: none; }
  .cover { height: 104px; border-radius: 0; }
${STEPS.slice(1)
  .map((n) => `  .cover.height-${n} { height: ${coverHeight(104, n)}px; }`)
  .join('\n')}
  .badge { left: 18px; bottom: -20px; width: 56px; height: 56px; border-radius: 16px; font-size: 36px; }
  .head { padding: 3.25rem 1.125rem 0; }
  .no-badge .head { padding-top: 1.75rem; }
  .page-title { font-size: 1.6rem; }
  .page-body { padding: 1.25rem 1.125rem 2rem; }
}
`;

/**
 * A public page's policy: nothing loads but its images and fonts from this
 * server and its one stylesheet, named by hash, and nothing in it can run.
 */
export const PAGE_CSP = [
  "default-src 'none'",
  "img-src 'self'",
  "font-src 'self'",
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

/** WikiStow's mark, as its favicon draws it. */
const MARK = `<svg viewBox="0 0 256 256" aria-hidden="true"><rect width="256" height="256" rx="56" fill="#c8461a"/><path d="M60 84 92 176 128 108 164 176 196 84" fill="none" stroke="#fff" stroke-width="24" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

const fileUrl = (id: string, attachmentId: string) =>
  `/p/${encodeURIComponent(id)}/files/${encodeURIComponent(attachmentId)}`;

/** An icon of the icon set, drawn as Lucide draws it, in the badge's colour. */
function symbolSvg(name: string): string | null {
  const node = symbolNode(name);
  if (!node) return null;
  const shapes = node
    .map(
      ([tag, attrs]) =>
        `<${tag}${Object.entries(attrs)
          .flatMap(([key, value]) =>
            value === undefined ? [] : [` ${key}="${escapeHtml(String(value))}"`],
          )
          .join('')}/>`,
    )
    .join('');
  const label = `Page icon ${name.replaceAll('-', ' ')}`;
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" role="img" aria-label="${escapeHtml(label)}">${shapes}</svg>`;
}

/** The badge, as the app's `PageBadge`: the image, else the icon, else the emoji, else none. */
function badgeHtml(id: string, cover: PublicCover): string | null {
  if (cover.icon) return `<img src="${fileUrl(id, cover.icon)}" alt="Page image">`;
  const symbol = cover.symbol && symbolSvg(cover.symbol);
  if (symbol) return symbol;
  if (cover.emoji) {
    const emoji = escapeHtml(cover.emoji);
    return `<span role="img" aria-label="Page emoji ${emoji}">${emoji}</span>`;
  }
  return null;
}

/** The card's top: its banner, with the badge over its edge, if any. */
function coverHtml(id: string, cover: PublicCover) {
  const { banner } = cover;
  // A banner image's height and fade, where it has them, beside a preset's name.
  const classes =
    banner.kind === 'preset'
      ? [`banner-${banner.name}`]
      : banner.kind === 'image'
        ? [...stepClass('height', banner.height), ...stepClass('fade', banner.fade)]
        : [];
  const image =
    banner.kind === 'image'
      ? `<img class="banner-img focal-${step(banner.focal)}" src="${fileUrl(id, banner.attachmentId)}" alt="">`
      : '';
  const badge = badgeHtml(id, cover);
  return {
    html: `<div class="${['cover', ...classes].join(' ')}">${image}${badge ? `<div class="badge">${badge}</div>` : ''}</div>`,
    badge: badge !== null,
  };
}

/** "On this page", for a page with at least two headings. */
function contentsHtml({ headings }: Outline) {
  if (headings.length < 2) return '';
  const links = headings
    .map(
      (heading) =>
        `<a href="#${escapeHtml(heading.id)}"${heading.sub ? ' class="sub"' : ''}>${escapeHtml(heading.text)}</a>`,
    )
    .join('\n');
  return `<nav class="contents" aria-label="On this page">\n<p aria-hidden="true">On this page</p>\n${links}\n</nav>\n`;
}

const DAY = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});

/** How long a body takes to read, at 200 words a minute. */
const minutes = (words: number) => Math.max(1, Math.round(words / 200));

type Card = {
  /** The link's id, which the cover's files are served under. */
  id: string;
  title: string;
  cover: PublicCover;
  meta: string;
  body: string;
  contents: string;
};

function document(title: string, card: Card) {
  const top = coverHtml(card.id, card.cover);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(title)}</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<style>${CSS}</style>
</head>
<body>
<div class="layout${card.contents ? ' with-contents' : ''}">
${card.contents}<div class="column">
<main class="card${top.badge ? '' : ' no-badge'}">
${top.html}
<header class="head">
<h1 class="page-title">${escapeHtml(card.title)}</h1>
${card.meta}</header>
<article class="page-body">
${card.body}
</article>
</main>
<footer>${MARK}<span>Shared from WikiStow with a public link</span></footer>
</div>
</div>
</body>
</html>
`;
}

/** A public page: its cover, title and body as rendered, its gaps filled in, beside its headings. */
export function publicPageHtml(page: Extract<PublicPage, { kind: 'page' }>) {
  const updated = page.updated.toISOString().slice(0, 10);
  const meta = `<p class="meta"><span class="pill">Updated <time datetime="${updated}">${DAY.format(page.updated)}</time></span><span>${minutes(page.outline.words)} min read</span></p>\n`;
  return document(page.title, {
    id: page.id,
    title: page.title,
    cover: page.cover,
    meta,
    body: page.body,
    contents: contentsHtml(page.outline),
  });
}

const notice = (title: string, heading: string, text: string) =>
  document(title, {
    id: '',
    title: heading,
    cover: NO_COVER,
    meta: '',
    body: `<p>${escapeHtml(text)}</p>`,
    contents: '',
  });

/** A public page with no copy to show yet. */
export const updatingPageHtml = () =>
  notice('Being updated', 'This page is being updated', 'Try again in a little while.');

/** Every unknown id, link turned off and missing file gets this. */
export const notFoundHtml = () =>
  notice(
    'Not found',
    'Page not found',
    "This link doesn't lead to a page. It may have been turned off.",
  );
