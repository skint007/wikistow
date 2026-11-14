// The content script (ADR 0017, decision 5). The background injects it
// into the tab only when the person clips, through `activeTab` and
// `scripting`, then calls `capture` there; the result comes back as the
// injection's own. It listens to nothing the page sends. It runs where the
// page is live, so it can tell what the page shows: it drops elements with
// no box, `display: none` or `visibility: hidden` as computed, gives each
// image the source the page shows (`currentSrc`), and makes every address
// absolute. The app turns the HTML into Markdown.
import { Readability } from '@mozilla/readability';
import type { ClipMode } from './protocol.ts';

export type Captured = {
  url: string;
  title: string;
  html: string;
  text: string;
  byline: string | null;
  siteName: string | null;
};

/** Attributes holding an address, made absolute. */
const ADDRESSES = ['href', 'src', 'poster', 'cite'];
/** Elements with no box of their own that still show something. */
const BOXLESS = new Set(['BR', 'WBR']);
/** Elements that show something themselves, which `visibility: hidden` hides. */
const REPLACED = new Set(['IMG', 'PICTURE', 'VIDEO', 'AUDIO', 'CANVAS', 'svg', 'IFRAME', 'INPUT']);
/** Ancestors a selection inside one keeps, so its code stays code and its link a link. */
const KEPT_ANCESTORS = new Set([
  'PRE',
  'CODE',
  'A',
  'BLOCKQUOTE',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
]);

const absolute = (value: string) => {
  try {
    return new URL(value, document.baseURI).href;
  } catch {
    return value;
  }
};

/** Whether the page hides `element`, as computed. */
function hidden(element: Element, style: CSSStyleDeclaration) {
  if (style.display === 'none') return true;
  if (style.display === 'contents' || BOXLESS.has(element.tagName)) return false;
  return element.getClientRects().length === 0;
}

/**
 * Clean `copy`, a deep clone of the live `live`, walking both at once:
 * what the live page hides goes from the copy, and what's kept gets its
 * shown image and absolute addresses. `within`, if given, skips what lies
 * outside it, which a selection leaves out anyway.
 */
function clean(live: Element, copy: Element, within?: Range) {
  const stack: [Element, Element][] = [[live, copy]];
  while (stack.length > 0) {
    const [from, to] = stack.pop()!;
    const style = getComputedStyle(from);
    const shown = style.visibility === 'visible';
    const lives = [...from.childNodes];
    const copies = [...to.childNodes];
    for (let index = 0; index < lives.length; index++) {
      const child = lives[index]!;
      const twin = copies[index]!;
      if (child.nodeType === Node.TEXT_NODE) {
        if (!shown) twin.remove();
        continue;
      }
      if (!(child instanceof Element) || !(twin instanceof Element)) continue;
      if (within && !within.intersectsNode(child)) continue;
      const childStyle = getComputedStyle(child);
      if (
        hidden(child, childStyle) ||
        (childStyle.visibility !== 'visible' && REPLACED.has(child.tagName))
      ) {
        twin.remove();
        continue;
      }
      fix(child, twin);
      stack.push([child, twin]);
    }
  }
}

/** The copy's addresses absolute, and an image the one the page shows. */
function fix(live: Element, copy: Element) {
  for (const name of ADDRESSES) {
    const value = copy.getAttribute(name);
    if (value !== null && !(name === 'href' && value.startsWith('#'))) {
      copy.setAttribute(name, absolute(value));
    }
  }
  if (live instanceof HTMLImageElement) {
    const shown = live.currentSrc || live.src;
    if (shown) copy.setAttribute('src', shown);
    copy.removeAttribute('srcset');
    copy.removeAttribute('sizes');
    // Its picture's other sources too: the image now names the one shown.
    if (copy.parentElement?.tagName === 'PICTURE') {
      for (const source of copy.parentElement.querySelectorAll(':scope > source')) source.remove();
    }
  }
}

/** The body, cleaned. */
function cleanBody(): HTMLElement {
  const copy = document.body.cloneNode(true) as HTMLElement;
  clean(document.body, copy);
  return copy;
}

/** The index path from `root` down to `node`. */
function pathTo(root: Node, node: Node): number[] {
  const path: number[] = [];
  for (let at = node; at !== root; at = at.parentNode!) {
    path.unshift([...at.parentNode!.childNodes].indexOf(at as ChildNode));
  }
  return path;
}

const follow = (root: Node, path: number[]) =>
  path.reduce<Node>((at, index) => at.childNodes[index]!, root);

/** One range of the selection as HTML, cleaned, inside the ancestors it needs. */
function rangeHtml(range: Range): string {
  let root = range.commonAncestorContainer;
  if (!(root instanceof Element)) root = root.parentElement ?? document.body;
  const live = root as Element;
  const copy = live.cloneNode(true) as Element;
  // The same range in the copy, made before cleaning, so it moves as the
  // cleaning removes what's hidden: a range follows its tree's changes.
  const copied = document.createRange();
  copied.setStart(follow(copy, pathTo(live, range.startContainer)), range.startOffset);
  copied.setEnd(follow(copy, pathTo(live, range.endContainer)), range.endOffset);
  clean(live, copy, range);
  let fragment: Node = copied.cloneContents();
  for (let at: Element | null = live; at && at !== document.body; at = at.parentElement) {
    if (!KEPT_ANCESTORS.has(at.tagName)) continue;
    const shell = at.cloneNode(false) as Element;
    fix(at, shell);
    shell.append(fragment);
    fragment = shell;
  }
  const holder = document.createElement('div');
  holder.append(fragment);
  return holder.innerHTML;
}

function selection(): Pick<Captured, 'html' | 'text'> {
  const chosen = getSelection();
  if (!chosen || chosen.isCollapsed) return { html: '', text: '' };
  const ranges = Array.from({ length: chosen.rangeCount }, (_, index) => chosen.getRangeAt(index));
  return { html: ranges.map(rangeHtml).join(''), text: chosen.toString() };
}

function article(): Pick<Captured, 'html' | 'text' | 'byline' | 'siteName'> {
  // Readability changes the document it reads, so it reads a copy, made
  // of what the page shows.
  const copy = document.implementation.createHTMLDocument(document.title);
  const base = copy.createElement('base');
  base.href = document.baseURI;
  copy.head.append(base);
  copy.body.replaceWith(copy.adoptNode(cleanBody()));
  const found = new Readability(copy).parse();
  if (!found?.content) throw new Error('No article');
  return {
    html: found.content,
    text: found.textContent ?? '',
    byline: found.byline?.trim() || null,
    siteName: found.siteName?.trim() || null,
  };
}

/** What `mode` clips from this page. Link takes the selection as text, if any. */
function capture(mode: ClipMode): Captured {
  const page = { url: location.href, title: document.title, byline: null, siteName: null };
  switch (mode) {
    case 'link':
      return { ...page, html: '', text: getSelection()?.toString() ?? '' };
    case 'selection':
      return { ...page, ...selection() };
    case 'article':
      return { ...page, ...article() };
    case 'page':
      return { ...page, html: cleanBody().innerHTML, text: document.body.innerText };
  }
}

declare global {
  var wikistowCapture: typeof capture | undefined;
}

// Reached through a second injection (background.ts), in this extension's
// own world: the page's scripts can't see it.
globalThis.wikistowCapture = capture;
