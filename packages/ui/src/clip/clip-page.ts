// What a clip from the browser becomes as a page (ADR 0017, decision 5):
// its title, its properties, the HTML to turn into Markdown, and where its
// images go. Pure, so it is table-tested; `save-clip.ts` puts it together.
import { linkSpans, setProperty, type LinkSpans, type PropertyValue } from '@wikistow/client';
import { pageRoutes, type DesktopClip } from '@wikistow/contracts';

/** A clip has at most this many images fetched (ADR 0017, decision 3). */
export const MAX_CLIP_IMAGES = 50;
/** An attachment's address, as the page writes it: `attachment:` and a 22-character ID. */
const ATTACHMENT_URL_CHARS = 'attachment:'.length + 22;

const linkable = (url: string) => /^https?:\/\//i.test(url);

/** The page's title: the one the person gave, on one line, or the address's site, or "Clip". */
export function clipTitle(clip: Pick<DesktopClip, 'title' | 'url'>): string {
  const title = clip.title.replace(/\s+/g, ' ').trim();
  if (title) return title;
  try {
    const host = new URL(clip.url).hostname;
    if (host) return host;
  } catch {
    // Not an address: the fallback.
  }
  return 'Clip';
}

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

/** Plain text as HTML that shows it: paragraphs at blank lines, line breaks kept. */
export function textHtml(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .map((paragraph) => `<p>${escapeHtml(paragraph).replaceAll('\n', '<br>')}</p>`)
    .join('');
}

/** One piece of a clip to turn into Markdown, as a paste of that HTML and text would. */
export type ClipPart = { html: string; text: string };

/**
 * A clip's pieces, in the page's order. A link is the note, the selection
 * as a quote, and the link, written here as HTML so the paste path escapes
 * them as it would anything pasted. Every other mode is the note, then the
 * clip's own HTML, apart: a site's styles can't hide the note.
 */
export function clipParts(clip: DesktopClip): ClipPart[] {
  const note = clip.note.trim() ? [{ html: textHtml(clip.note), text: '' }] : [];
  if (clip.mode !== 'link') return [...note, { html: clip.html, text: clip.text }];
  const quote = clip.text.trim() ? `<blockquote>${textHtml(clip.text)}</blockquote>` : '';
  const shown = escapeHtml(clipTitle(clip));
  const link = linkable(clip.url)
    ? `<p><a href="${escapeHtml(clip.url)}">${shown}</a></p>`
    : `<p>${escapeHtml(clip.url)}</p>`;
  return [{ html: `${textHtml(clip.note)}${quote}${link}`, text: '' }];
}

/**
 * The clip's properties, as its page's frontmatter (ADR 0017, decision 5):
 * `source`, its address, as import writes it; `clipped`, the day it was
 * saved; its `tags`; and an article's byline as `author`. Only these: a
 * clip never takes properties from frontmatter-like text in what it
 * clipped, which is the page's body, as a website shouldn't set them.
 */
export function clipFrontmatter(clip: DesktopClip, today: string): string {
  const tags = [...new Set(clip.tags.map((tag) => tag.trim()).filter(Boolean))];
  const byline = clip.byline?.trim();
  const properties: [string, PropertyValue][] = [
    ['source', clip.url],
    ['clipped', today],
    ...(tags.length > 0 ? [['tags', tags] as [string, PropertyValue]] : []),
    ...(byline ? [['author', byline] as [string, PropertyValue]] : []),
  ];
  let frontmatter: string | null = null;
  for (const [key, value] of properties) {
    const edit = setProperty(frontmatter, key, value);
    if (!edit.ok) throw new Error(`The clip’s ${key} can’t be written: ${edit.reason}`);
    frontmatter = edit.frontmatter;
  }
  return frontmatter!;
}

/** Today as `YYYY-MM-DD`, on this computer's calendar. */
export function localDay(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** The bytes of `text` as UTF-8. */
export const byteLength = (text: string) => new TextEncoder().encode(text).length;

/** Whether a page's Markdown fits one version (`MAX_MARKDOWN_BYTES`). */
export const fitsPage = (markdown: string) => byteLength(markdown) <= pageRoutes.MAX_MARKDOWN_BYTES;

/**
 * Whether `markdown` could fit a page once its images are written as the
 * page shows them: without its `data:` addresses, which become
 * attachments or text, it must already. Cheap, so a clip far too long is
 * refused before its links are read.
 */
export const mayFit = (markdown: string) => fitsPage(markdown.replace(/data:[^\s)"'>]*/gi, ''));

/**
 * Where a clip's images go. `fetch` is each address to fetch, once, at
 * most 50: `http:`, `https:` or `data:`. `written` is the page with the
 * images given attachments (by address) shown from them, and the rest as
 * the page can show them: an `http:` or `https:` image as a link to it, as
 * the app never loads one from a site, and any other, such as `blob:` or
 * a `data:` image that wasn't saved, as its alt text. An image in a link's
 * text, which can't hold a link, is its alt text too.
 */
export type ImagePlan = {
  fetch: string[];
  written(attached: ReadonlyMap<string, string>): string;
  /** Whether the page fits, with every image fetched attached. */
  fitsAttached: boolean;
  /** How many images it names, each address once. */
  count: number;
};

export function planImages(
  markdown: string,
  spans: LinkSpans = linkSpans(markdown),
  max = MAX_CLIP_IMAGES,
): ImagePlan {
  const images = spans.urls.filter(
    (url): url is typeof url & { imageSpan: { start: number; end: number } } =>
      url.image === true && url.imageSpan !== undefined && url.destination !== null,
  );
  const fetch: string[] = [];
  for (const { url } of images) {
    if (fetch.length >= max) break;
    if ((linkable(url) || /^data:/i.test(url)) && !fetch.includes(url)) fetch.push(url);
  }
  // In one pass, in order: what's between the images, and each as written.
  const written = (attached: ReadonlyMap<string, string>) => {
    const parts: string[] = [];
    let at = 0;
    for (const image of images) {
      const { start, end } = image.imageSpan;
      const destination = image.destination!;
      const id = attached.get(image.url);
      parts.push(markdown.slice(at, start));
      if (id !== undefined) {
        parts.push(
          markdown.slice(start, destination.start),
          `attachment:${id}`,
          markdown.slice(destination.end, end),
        );
      } else if (linkable(image.url) && !image.inLink) {
        // `[`… as the link it becomes, dropping the image's `!`.
        parts.push(markdown.slice(start + 1, end));
      } else {
        parts.push(markdown.slice(start + 2, image.at - 1));
      }
      at = end;
    }
    parts.push(markdown.slice(at));
    return parts.join('');
  };
  const placeholder = 'x'.repeat(ATTACHMENT_URL_CHARS - 'attachment:'.length);
  const fitsAttached = fitsPage(written(new Map(fetch.map((url) => [url, placeholder]))));
  return { fetch, written, fitsAttached, count: new Set(images.map((image) => image.url)).size };
}

/** A file name for an image fetched from `url`, of `mediaType`. */
export function imageName(url: string, mediaType: string): string {
  const extension =
    {
      'image/png': 'png',
      'image/jpeg': 'jpg',
      'image/gif': 'gif',
      'image/webp': 'webp',
      'image/avif': 'avif',
      'image/bmp': 'bmp',
      'image/x-icon': 'ico',
    }[mediaType] ?? 'img';
  let base = '';
  if (linkable(url)) {
    try {
      const last = new URL(url).pathname.split('/').filter(Boolean).at(-1) ?? '';
      base = decodeURIComponent(last);
    } catch {
      base = '';
    }
  }
  base = base
    .replace(/\.[^.]*$/, '')
    .replace(/[\p{Cc}\\/:*?"<>|[\]]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100);
  return `${base || 'image'}.${extension}`;
}
