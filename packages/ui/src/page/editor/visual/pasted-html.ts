import { copiedHere } from './schema';

// Styles in pasted HTML: `style` attributes, `<style>` and stylesheet links.
// The Content Security Policy refuses and reports them in any document
// they're read in, even one nobody sees, as ProseMirror reads a paste, so
// they never told it anything: bold written as a style isn't bold here.
// The HTML is read with each "style" in it marked, save a `<style>` tag's
// name, so no attribute read is a style; those named so are taken out, with
// `<style>` elements, links and templates, and the marks. A
// `<style>` element is read as the browser reads it, its text CSS to its end
// tag and never HTML, so what follows it is what the HTML says; reading it
// raises one `style-src-elem` report, in the console only. An end tag left
// unmarked is one that can end its text (`</style>`, `</style `): written
// inside another tag, such a one is read as a style attribute, which goes
// too, though it's reported first.
const MARK = '\uFDD0';
const MARKED = new RegExp(`(s)${MARK}(tyle)`, 'gi');
const isStyle = (name: string) => name.toLowerCase().replace(MARK, '') === 'style';
const styleOf = (element: Element) => element.getAttribute(`s${MARK}tyle`) ?? '';

const HTML = 'http://www.w3.org/1999/xhtml';
const SVG = 'http://www.w3.org/2000/svg';
const MATHML = 'http://www.w3.org/1998/Math/MathML';

// HTML a browser never shows, nor anything in it: a script, style or title;
// what's for browsers without scripts or frames; what an iframe, object,
// player, canvas, meter, progress bar or Chromium's permission elements
// show only if they can't show themselves; a select's or datalist's
// options; and a ruby's brackets for browsers without it.
const UNSHOWN_HTML = new Set([
  ...['noscript', 'noembed', 'noframes', 'iframe', 'object', 'script', 'style', 'title'],
  ...['video', 'audio', 'canvas', 'meter', 'progress', 'select', 'datalist'],
  ...['fencedframe', 'geolocation', 'usermedia', 'camera', 'microphone', 'rp'],
]);
// The SVG that shows text, or HTML (`foreignObject`, if it has a size), and
// in a <text>, what shows its text. Nothing else shows what it holds: not a
// title or description, what's drawn only by reference (`defs`, `clipPath`)
// or along a path (`textPath`), nor an element SVG doesn't know.
const SHOWN_SVG = new Set(['svg', 'g', 'a', 'text', 'foreignObject']);
const IN_TEXT_SVG = new Set(['tspan', 'a']);
// MathML's annotations, and a phantom or space, which shows nothing.
const UNSHOWN_MATHML = new Set(['annotation', 'annotation-xml', 'mphantom', 'mspace']);
// MathML that shows only its first element.
const FIRST_MATHML = new Set(['semantics', 'maction']);
// MathML's token elements, the only ones that show the text in them.
const TOKEN_MATHML = new Set(['mi', 'mn', 'mo', 'ms', 'mtext']);

// Whether `element` is in an SVG <text>, with only SVG between.
function inSvgText(element: Element): boolean {
  for (let up = element.parentElement; up?.namespaceURI === SVG; up = up.parentElement)
    if (up.localName === 'text') return true;
  return false;
}

// Whether a browser shows the text in `element`: SVG shows it only in a
// <text> or as HTML (`foreignObject`), and MathML only in a token element.
function showsText(element: Element): boolean {
  const name = element.localName;
  switch (element.namespaceURI) {
    case SVG:
      return name === 'text' || name === 'foreignObject' || inSvgText(element);
    case MATHML:
      return TOKEN_MATHML.has(name);
    default:
      return true;
  }
}

// `css` read as a browser reads a style, escapes and all, by the CSSOM,
// which the Content Security Policy allows, unlike a style attribute. Only
// marks in a "style", as they're put, go: one written elsewhere as a
// reference (`&#xFDD0;`) stays, which a browser can't read either.
function readCss(doc: Document, css: string): CSSStyleDeclaration {
  const probe = doc.createElement('div');
  probe.style.cssText = css.replace(MARKED, '$1$2');
  return probe.style;
}

// The style each element's style attribute gives it (`readCss`): its first
// named "style", as a browser reads only the first, marked or not, as one
// left unmarked (`</style `) is read as a style too.
const styles = new WeakMap<Element, CSSStyleDeclaration>();
function declared(element: Element): CSSStyleDeclaration {
  let style = styles.get(element);
  if (!style) {
    const attribute = [...element.attributes].find(({ name }) => isStyle(name));
    style = readCss(element.ownerDocument, attribute?.value ?? '');
    styles.set(element, style);
  }
  return style;
}

// Whether a style rolls back past itself (`revert-layer`, `revert-rule`),
// to an attribute's value.
const rolledBack = (value: string) => /^\s*revert-/i.test(value);

// The SVG presentation attributes read here, which a style overrides.
const PRESENTED = new Set(['display', 'visibility', 'opacity']);

// `element`'s value for the CSS property `name`, as its style gives it, or
// else, in SVG, its presentation attribute, read as CSS too; '' if neither.
// A style rolled back (`rolledBack`) leaves the attribute's.
function cssOf(element: Element, name: string): string {
  let value = declared(element).getPropertyValue(name);
  const presented =
    element.namespaceURI === SVG && PRESENTED.has(name) ? element.getAttribute(name) : null;
  if ((!value || rolledBack(value)) && presented !== null) {
    const { style } = element.ownerDocument.createElement('div');
    style.setProperty(name, presented.replace(MARKED, '$1$2'));
    value = style.getPropertyValue(name);
  }
  return value.trim().toLowerCase();
}

// A value worked out from elsewhere, such as a custom property's
// (`var(--x)`), an attribute's (`attr(x)`) or a sum's (`calc(…)`), which
// may come to anything.
const worked = (value: string) => value.includes('(');

// Displays that show nothing of what an element holds, as columns'.
const COLUMNS = new Set(['table-column', 'table-column-group']);
// HTML that `display: contents` shows nothing of, as it has no contents to
// show but itself.
const CONTENTLESS = new Set([
  ...['br', 'wbr', 'meter', 'progress', 'canvas', 'embed', 'object', 'audio'],
  ...['iframe', 'img', 'video', 'frame', 'frameset', 'input', 'textarea', 'select'],
]);

/**
 * Whether `element`'s style or SVG attributes hide it and all it holds: it
 * has no box (`display: none`), or shows nothing of what it holds, as a
 * column, or an image, SVG or MathML with `display: contents`; it draws
 * nothing (`opacity: 0`), or none of what it holds (`content-visibility:
 * hidden`). A value worked out from elsewhere is taken to hide it. What
 * `visibility: hidden` hides is found apart (`visibleOnly`), as what's in
 * it can show itself again; `collapse` hides it all here, as it does a
 * table's row, with all in it. Sizes, clipping, colours and places off the
 * page are left, as is an opacity just above 0: none has a clean cut-off.
 *
 * A browser's copy writes the page's styles in each element's, so what an
 * animation fades in from `opacity: 0` or `visibility: hidden` is taken
 * as hidden too: whether one runs isn't known here, and a page could name
 * one that doesn't.
 */
function styleHides(element: Element): boolean {
  const display = cssOf(element, 'display');
  const opacity = cssOf(element, 'opacity');
  const contents = cssOf(element, 'content-visibility');
  const contentless =
    element.namespaceURI === SVG ||
    element.namespaceURI === MATHML ||
    (element.namespaceURI === HTML && CONTENTLESS.has(element.localName));
  return (
    [display, opacity, contents].some(worked) ||
    display === 'none' ||
    COLUMNS.has(display) ||
    // Or inherited, as from a `<slot>`, whose display is `contents`.
    ((display === 'contents' || display === 'inherit') && contentless) ||
    Number.parseFloat(opacity) <= 0 ||
    contents === 'hidden' ||
    cssOf(element, 'visibility') === 'collapse'
  );
}

// The styles that can size an element.
const SIZES = ['width', 'height', 'inline-size', 'block-size'].flatMap((size) => [
  size,
  `max-${size}`,
]);

// Whether `value` is a length above 0, as an SVG attribute (`9`, `9px`) or a
// style (`9px`) gives one, read as CSS; not a keyword (`auto`).
function positive(doc: Document, value: string): boolean {
  const { style } = doc.createElement('div');
  style.setProperty('width', value);
  if (!style.width) style.setProperty('width', `${value}px`);
  return !worked(style.width) && Number.parseFloat(style.width) > 0;
}

/**
 * Whether `element`, an SVG drawing or `foreignObject`, is no wide or high,
 * or may be, at which it shows nothing. A drawing is by its attributes, its
 * style or its `viewBox`. A `foreignObject` is laid out at 0 unless its
 * width and height, by its style or else its attributes, are lengths above
 * 0, and any other size its style gives is too.
 */
function flat(element: Element): boolean {
  const style = declared(element);
  const doc = element.ownerDocument;
  const styled = SIZES.map((size) => style.getPropertyValue(size)).filter(
    (value) => value && !rolledBack(value),
  );
  if (element.localName === 'foreignObject')
    return (
      ['width', 'height'].some((name) => {
        const value = style.getPropertyValue(name);
        return !positive(
          doc,
          value && !rolledBack(value) ? value : (element.getAttribute(name) ?? ''),
        );
      }) || styled.some((value) => value !== 'none' && !positive(doc, value))
    );
  const [, , width, height] = (element.getAttribute('viewBox') ?? '').trim().split(/[\s,]+/);
  return [
    element.getAttribute('width'),
    element.getAttribute('height'),
    ...styled,
    width,
    height,
  ].some((value) => !!value && (worked(value) || Number.parseFloat(value) <= 0));
}

// Whether a browser shows nothing of `element`, as its kind, attributes or style say.
function unshown(element: Element): boolean {
  const name = element.localName;
  if (styleHides(element)) return true;
  switch (element.namespaceURI) {
    case HTML:
      return (
        UNSHOWN_HTML.has(name) ||
        element.hasAttribute('hidden') ||
        element.hasAttribute('popover') ||
        (name === 'dialog' && !element.hasAttribute('open'))
      );
    case SVG:
      return (
        !(inSvgText(element) ? IN_TEXT_SVG : SHOWN_SVG).has(name) ||
        // A link in a link draws nothing.
        (name === 'a' &&
          element.parentElement?.namespaceURI === SVG &&
          element.parentElement.localName === 'a') ||
        ((name === 'svg' || name === 'foreignObject') && flat(element)) ||
        // Drawn only if the browser's language or extensions match.
        element.hasAttribute('systemLanguage') ||
        element.hasAttribute('requiredExtensions')
      );
    case MATHML:
      return UNSHOWN_MATHML.has(name);
    default:
      return false;
  }
}

// What a browser shows of `element`'s children, if not all: none of a
// shadow root's host, which shows the root instead (`<template
// shadowrootmode>`); an option's text alone, outside a select too; a
// closed <details>' summary; MathML's first element.
function shownOf(element: Element): (Element | string)[] | null {
  const { localName: name, namespaceURI: space } = element;
  const first = (found: Element | null) => (found ? [found] : []);
  if (element.querySelector(':scope > template[shadowrootmode]')) return [];
  if (space === HTML && name === 'option') {
    // Without what `unshown` and `visibleOnly` find hidden in it. What
    // hides the option itself is found later, as for any element.
    const label = element.cloneNode(true);
    if (label instanceof HTMLElement) {
      for (const inner of [...label.querySelectorAll('*')].filter(unshown)) inner.remove();
      visibleOnly(label);
    }
    return [label.textContent ?? ''];
  }
  if (space === HTML && name === 'details' && !element.hasAttribute('open'))
    return first(element.querySelector(':scope > summary'));
  if (space === MATHML && FIRST_MATHML.has(name)) return first(element.firstElementChild);
  return null;
}

// Whether `element` says it's hidden by `visibility`, in its style or, in
// SVG, its attribute: true if hidden, false if shown, null if it takes its
// parent's. One worked out from elsewhere is taken as hidden.
function hiddenBy(element: Element): boolean | null {
  const value = cssOf(element, 'visibility');
  if (worked(value) || value === 'hidden' || value === 'collapse') return true;
  return value === 'visible' || value === 'initial' ? false : null;
}

/**
 * `body` without what `visibility` hides, which, unlike what `unshown`
 * finds, something in it can show again (`visibility: visible`): an
 * element hidden goes whole if nothing in it is shown, and if something
 * is, loses just its own text. `body` is in `page`, the `<html>` pasted,
 * if it's a page's.
 */
function visibleOnly(body: HTMLElement, page?: Element) {
  const elements = [...body.querySelectorAll('*')];
  const hidden = new Map<Element, boolean>(page ? [[page, hiddenBy(page) ?? false]] : []);
  for (const element of [body, ...elements]) {
    const parent = element.parentElement;
    hidden.set(element, hiddenBy(element) ?? (parent !== null && hidden.get(parent) === true));
  }
  // Those with something shown in them, found from the deepest up.
  const showing = new Set<Element>();
  for (const element of elements.toReversed())
    if ((!hidden.get(element) || showing.has(element)) && element.parentElement)
      showing.add(element.parentElement);
  for (const element of [body, ...elements]) {
    if (!hidden.get(element)) continue;
    if (!showing.has(element)) {
      if (element === body) body.replaceChildren();
      else element.remove();
      continue;
    }
    for (const node of [...element.childNodes]) if (node instanceof Text) node.remove();
  }
}

/**
 * `doc`'s body without what a browser wouldn't show, which ProseMirror
 * would otherwise read, if not at once then from the depth `data-pm-slice`
 * says to start at: elements it never shows (`unshown`), the children of
 * one that shows only some (`shownOf`), what `visibility` hides
 * (`visibleOnly`), and text where it shows none (`showsText`). All of it,
 * if the body or page is hidden, as the attributes of a `<body>` or
 * `<html>` pasted are theirs.
 */
function shownOnly({ body, documentElement }: Document) {
  if (unshown(body) || unshown(documentElement)) body.replaceChildren();
  const elements = [...body.querySelectorAll('*')];
  for (const element of [body, ...elements]) {
    // Not one already taken out with what holds it, as an option in an option.
    if (!element.isConnected) continue;
    const shown = shownOf(element);
    if (shown) element.replaceChildren(...shown);
  }
  for (const element of elements.filter(unshown)) element.remove();
  visibleOnly(body, documentElement);
  for (const element of body.querySelectorAll('*'))
    if (!showsText(element))
      for (const node of [...element.childNodes]) if (node instanceof Text) node.remove();
}

// As a standard page, as ProseMirror reads it, not one in quirks mode, and
// all its body: what starts the HTML goes there, not in the head, where an
// element a head can't hold would end a <noscript> before it and be shown.
const parse = (html: string) =>
  new DOMParser().parseFromString(`<!DOCTYPE html><body>${html}`, 'text/html');

// `html` read, with only what a browser shows. Each image is the one it
// shows (`shownSource`), found first, as a `<source>` hidden, as one
// always is, still offers images.
const readShown = (html: string) => {
  const doc = parse(html);
  const pictured = picturesShow(doc.body);
  for (const img of doc.body.querySelectorAll('img')) {
    const shown = shownSource(img, pictured.get(img));
    if (shown !== null) img.setAttribute('src', shown);
    img.removeAttribute('srcset');
  }
  shownOnly(doc);
  return doc;
};

/**
 * Whether `doc`, the HTML `marked` shown only as `shownOnly` leaves it,
 * shows no more than a browser would. A browser runs scripts, so reads a
 * <noscript>'s content as text up to its end tag, as it does a
 * <noframes>'s; `DOMParser` doesn't, reading it as markup, which can close
 * it sooner (`<div><noscript></div>…`), showing what follows. Read again
 * with each `<noscript` and `</noscript` written `noframes`, wherever it
 * stands, it must show the same, the word read alike in each.
 */
function asWithScripts(marked: string, doc: Document): boolean {
  if (!/<\/?noscript/i.test(marked)) return true;
  // One already there would read as the other.
  if (/<\/?noframes/i.test(marked)) return false;
  const again = readShown(marked.replace(/(<\/?)noscript/gi, '$1noframes'));
  const alike = (shown: Document) => shown.body.innerHTML.replace(/noscript/gi, 'noframes');
  return alike(again) === alike(doc);
}

// An image a `srcset` offers, the pixel density it's drawn at, and whether
// that comes from its width.
type Candidate = { url: string; density: number; byWidth: boolean };

const SPACES = /[\t\n\f\r ]+/;
const SKIPPED = /[\t\n\f\r ,]*/y;
const URL_TEXT = /[^\t\n\f\r ]+/y;
// What describes an image, to a comma outside brackets.
const DESCRIBED = /(?:[^,(]|\([^)]*\)?)*,?/y;
const INTEGER = /^\d+$/;
const FLOAT = /^(?:\d+(?:\.\d+)?|\.\d+)(?:e[+-]?\d+)?$/i;

// The most a width or height can be, as Chromium reads one.
const MOST = 2 ** 31 - 1;

// The density an image is drawn at, as its descriptors (`2x`, `640w`,
// `640w 480h`) say, or null if HTML would refuse them: an `x` is its own,
// none is 1, and a `w` is its width over the window's. The width is over
// the width the page lays the image out at (`sizes`), which depends on the
// page's layout and isn't known here, so it's taken as the window's, as
// for a page that doesn't say. Chromium compares densities as 32-bit
// floats, so they're read as those.
function describedBy(descriptors: string[]): Omit<Candidate, 'url'> | null {
  let x: number | undefined;
  let w: number | undefined;
  let h: number | undefined;
  for (const descriptor of descriptors) {
    const unit = descriptor.slice(-1);
    const value = descriptor.slice(0, -1);
    const n = Number(value);
    const size = INTEGER.test(value) && n > 0 && n <= MOST;
    const first = [x, w, h].every((d) => d === undefined);
    if (unit === 'x' && FLOAT.test(value) && Number.isFinite(n) && first) x = n;
    else if (unit === 'w' && size && x === undefined && w === undefined) w = n;
    else if (unit === 'h' && size && x === undefined && h === undefined) h = n;
    else return null;
  }
  if (w === undefined)
    return h === undefined ? { density: Math.fround(x ?? 1), byWidth: false } : null;
  return { density: Math.fround(w / Math.max(window.innerWidth, 1)), byWidth: true };
}

// `url` without the commas ending it.
function unended(url: string) {
  let end = url.length;
  while (url[end - 1] === ',') end--;
  return url.slice(0, end);
}

// The images a `srcset` offers, as HTML parses it: a URL to a space, or to
// the commas ending it, as one can hold commas (`data:…,…`), then what
// describes it. Each HTML would refuse is left out.
function candidates(srcset: string): Candidate[] {
  const found: Candidate[] = [];
  let at = 0;
  const take = (pattern: RegExp) => {
    pattern.lastIndex = at;
    const [taken = ''] = pattern.exec(srcset) ?? [];
    at += taken.length;
    return taken;
  };
  for (take(SKIPPED); at < srcset.length; take(SKIPPED)) {
    const written = take(URL_TEXT);
    const url = unended(written);
    const descriptors = url === written ? take(DESCRIBED).replace(/,$/, '') : '';
    const described = describedBy(descriptors.split(SPACES).filter(Boolean));
    if (described) found.push({ url, ...described });
  }
  return found;
}

// The types a `<picture>`'s source may give that browsers show.
const IMAGE_TYPES = new Set([
  ...['image/png', 'image/x-png', 'image/apng', 'image/jpeg', 'image/jpg', 'image/pjpeg'],
  ...['image/gif', 'image/webp', 'image/avif', 'image/bmp', 'image/svg+xml'],
  ...['image/x-icon', 'image/vnd.microsoft.icon', 'image/x-xbitmap'],
]);

// The images a `<picture>`'s `<source>` offers, none unless a browser here
// would take it: one for a screen like this one, of a type browsers show.
function offeredBy(source: Element): Candidate[] {
  const media = source.getAttribute('media');
  const type = source.getAttribute('type')?.split(';')[0]?.trim().toLowerCase();
  if (media !== null && !window.matchMedia(media).matches) return [];
  return type && !IMAGE_TYPES.has(type) ? [] : candidates(source.getAttribute('srcset') ?? '');
}

// `url` read as written, without the marks on each "style" (`unstyled`),
// or null if it isn't a full URL.
function fullUrl(url: string): URL | null {
  try {
    return new URL(url.replaceAll(MARK, ''));
  } catch {
    return null;
  }
}

/**
 * Which of the images `offered` a browser shows, or null if none: the
 * first at the least density at least the screen's, or failing that the
 * greatest, as browsers pick; Chromium takes a denser one in a `data:`
 * URL instead, as it needn't download it.
 *
 * It's close, not exact, as some of what a browser picks by isn't known
 * here: the page's layout (`describedBy`), its screen, which `media` and
 * the density are matched to this one's, and which images Chromium already
 * has, as it takes a denser one it has instead too. A page offers one
 * picture at different sizes, so this is one it showed at some size.
 */
function picked(offered: Candidate[]): string | null {
  // The first at each density, least first.
  const sorted = offered
    .toSorted((a, b) => a.density - b.density)
    .filter((candidate, i, all) => candidate.density !== all[i - 1]?.density);
  const screen = Math.fround(window.devicePixelRatio);
  const at = sorted.findIndex(({ density }) => density >= screen);
  const winner = at === -1 ? sorted.length - 1 : at;
  const shown =
    sorted.slice(winner + 1).findLast(({ url }) => fullUrl(url)?.protocol === 'data:') ??
    sorted[winner];
  return shown?.url ?? null;
}

// The image shown, as `picked`, for each image in a `<picture>` under
// `body` that the first source before it to offer any offers one
// (`offeredBy`), each source read once.
function picturesShow(body: HTMLElement): Map<Element, string> {
  const shown = new Map<Element, string>();
  for (const picture of body.querySelectorAll('picture')) {
    if (picture.namespaceURI !== HTML) continue;
    let first: string | null = null;
    for (const child of picture.children) {
      if (child.namespaceURI !== HTML) continue;
      if (child.localName === 'source' && first === null) first = picked(offeredBy(child));
      if (child.localName === 'img' && first !== null) shown.set(child, first);
    }
  }
  return shown;
}

/**
 * The image a browser shows for `img`, or null if none: `pictured`, what
 * its `<picture>` shows (`picturesShow`), or else the one `picked` of its
 * own `srcset`, with its `src` as the image at 1x if that has none and
 * describes none by width.
 *
 * A browser's copy makes `src` a full URL but leaves a `srcset` as
 * written, relative to a page not known here. So a relative image, with a
 * full `src`, is that `src`, as it was before `srcset` was read, so images
 * from such pages still show.
 */
function shownSource(img: Element, pictured: string | undefined): string | null {
  const src = img.getAttribute('src');
  let shown = pictured;
  if (shown === undefined) {
    const offered = candidates(img.getAttribute('srcset') ?? '');
    if (src && !offered.some(({ density, byWidth }) => density === 1 || byWidth))
      offered.push({ url: src, density: 1, byWidth: false });
    shown = picked(offered) ?? undefined;
  }
  if (shown === undefined) return null;
  return src && fullUrl(src) && !fullUrl(shown) ? src : shown;
}

// Every element under `root`, those in templates too.
function* elements(root: ParentNode): Generator<Element> {
  for (const element of root.querySelectorAll('*')) {
    yield element;
    if (element instanceof HTMLTemplateElement) yield* elements(element.content);
  }
}

// A paragraph Word writes as an item of a list: which list, at what level,
// and the span showing its bullet or number (`·`, `3.`, `(a)`).
type Item = {
  p: Element;
  list: string;
  level: number;
  shown: Element | undefined;
  bullet: string;
  numbered: boolean;
};

// A list open as the items are read: whose, at what level, and whether numbered.
type Open = { element: HTMLElement; list: string; level: number; numbered: boolean };

// Word writes a list item's list and level in its style (`mso-list: l0
// level2 lfo1`, its list both `l0` and `lfo1`, as restarting its numbering
// makes another), and its bullet as text in a span styled `mso-list: Ignore`.
// Numbered if it shows a number, or a letter and `.` or `)`; full-width
// forms read as the others. Word has nine levels; one said to be deeper
// goes at the ninth.
function itemOf(p: Element): Item | null {
  const [, list, level, override = ''] =
    /mso-list:\s*(l\d+)\s+level(\d+)(?:\s+(lfo\d+))?/i.exec(styleOf(p)) ?? [];
  if (!list || !level) return null;
  const shown = [...p.querySelectorAll('span')].find((s) => /mso-list:\s*ignore/i.test(styleOf(s)));
  const bullet = shown?.textContent?.slice(0, 20).normalize('NFKC') ?? '';
  const numbered = /\p{N}|^\s*\(?\p{L}+[.)]/u.test(bullet);
  const depth = Math.min(Number(level), 9);
  return { p, list: `${list} ${override}`, level: depth, shown, bullet, numbered };
}

// The number an item shows in digits, its own (`2.1.` is 1), if no more
// than nine digits, as Markdown reads.
function numberOf(item: Item): number | undefined {
  const digits = /(?<!\d)(\d{1,9})\D*$/.exec(item.bullet)?.[1];
  return digits === undefined ? undefined : Number(digits);
}

// Numbers `list` from `start`, so items copied from a list's middle keep theirs.
function numberFrom(list: Open, start: number) {
  if (list.numbered && start !== 1) list.element.setAttribute('start', String(start));
  else list.element.removeAttribute('start');
}

// A list for `item`, numbered from its number.
function listFor(doc: Document, item: Item): Open {
  const { list, level, numbered } = item;
  const opened = { element: doc.createElement(numbered ? 'ol' : 'ul'), list, level, numbered };
  numberFrom(opened, numberOf(item) ?? 1);
  return opened;
}

// Whether `next` comes straight after `p`, with only blank text or comments between.
function follows(p: Element, next: Element): boolean {
  for (let node = p.nextSibling; node; node = node.nextSibling) {
    if (node === next) return true;
    if (node instanceof Element || (node instanceof Text && node.data.trim())) return false;
  }
  return false;
}

// Word's list paragraphs as lists, nested by level, each numbered or not as
// its first item is. Items of another list, as when one is pasted into
// another, go in a list of their own, unless both are bulleted. A table
// cell can't hold a list, so there the bullet stays as text, a plain one
// as Word's may be drawn in a symbol font. Read before styles are taken
// out, as Word says it all in them.
function wordLists(body: HTMLElement) {
  const doc = body.ownerDocument;
  // Each item, and whether it comes straight after the one before, read
  // before any moves, as moving one moves it from beside the next.
  const items: [Item, boolean][] = [];
  let last: Element | null = null;
  for (const p of body.querySelectorAll('p')) {
    // Word doesn't write a paragraph in another, and reading each again with it costs.
    if (p.parentElement?.closest('p')) continue;
    const item = itemOf(p);
    if (!item) continue;
    if (p.closest('td, th')) {
      if (item.shown && !item.numbered) item.shown.textContent = '•\u00a0';
      continue;
    }
    items.push([item, last !== null && follows(last, p)]);
    last = p;
  }
  let open: Open[] = [];
  for (const [item, after] of items) {
    item.shown?.remove();
    if (!after) open = [];
    // Out of the lists deeper than the item. One of its kind opened past a
    // level skipped on the way in takes the item's level, as does the first;
    // if of the item's list, numbered on to the item's own number rather
    // than its first's, when that number comes after its items.
    let top = open.at(-1);
    while (top && item.level < top.level) {
      const outer = open.at(-2);
      if (top.numbered === item.numbered && (!outer || outer.level < item.level)) {
        const number = numberOf(item) ?? 0;
        const before = top.element.childElementCount;
        if (top.list === item.list && number > before) numberFrom(top, number - before);
        top.level = item.level;
      } else open.pop();
      top = open.at(-1);
    }
    // Another list at its level is one of its own, unless both are bulleted.
    if (top?.level === item.level && top.list !== item.list && (top.numbered || item.numbered)) {
      open.pop();
      top = open.at(-1);
    }
    if (!top || item.level > top.level) {
      const opened = listFor(doc, item);
      if (top) (top.element.lastElementChild ?? top.element).append(opened.element);
      else item.p.before(opened.element);
      open.push((top = opened));
    }
    const li = doc.createElement('li');
    li.append(item.p);
    top.element.append(li);
  }
}

/**
 * Pasted HTML without its styles, with only what a browser shows
 * (`shownOnly`), each image the one shown, not always its `src`
 * (`shownSource`), and with data attributes only if this tab copied it, in
 * which ProseMirror finds what a page can hold, with
 * Word's list paragraphs as lists and its title a heading; null if, read
 * again as ProseMirror reads it, or as a browser running scripts reads it,
 * it would read otherwise, or if it holds the character styles are marked
 * with, so only its text is pasted.
 */
export function unstyled(html: string): string | null {
  // One there already would read as a mark: a style attribute's name, or
  // nothing in a style.
  if (html.includes(MARK)) return null;
  const marked = html.replace(
    /(<\/?)?(s)(tyle)(?=([\s/>]?))/gi,
    (name, open: string | undefined, s: string, tyle: string, end: string) =>
      open === '<' || (open === '</' && end) ? name : `${open ?? ''}${s}${MARK}${tyle}`,
  );
  const read = readShown(marked);
  if (!asWithScripts(marked, read)) return null;
  const { body } = read;
  wordLists(body);
  // Word's title is the page's heading.
  for (const title of body.querySelectorAll('p.MsoTitle')) {
    const heading = read.createElement('h1');
    title.replaceWith(heading);
    // One by one, as spread out, very many would overflow the stack.
    while (title.firstChild) heading.append(title.firstChild);
  }
  // Data attributes, which a browser doesn't show, are kept only as this
  // tab copied them, which the schema reads back: from elsewhere they'd
  // claim a wikilink, image or footnote other than what's shown. One node
  // this tab copied vouches for all the HTML, as the marks and wrappers
  // ProseMirror copies with it aren't marked; nothing else has the token.
  const own = [...elements(read)].some(copiedHere);
  for (const element of elements(read)) {
    const tag = element.localName;
    if (isStyle(tag) || tag === 'link' || tag === 'template') element.remove();
    for (const { name } of [...element.attributes])
      if (isStyle(name) || (!own && name.startsWith('data-'))) element.removeAttribute(name);
  }
  // Google Docs wraps what's copied in a bold that its own style undoes.
  for (const wrapper of body.querySelectorAll('b[id^="docs-internal-guid"]')) {
    while (wrapper.firstChild) wrapper.before(wrapper.firstChild);
    wrapper.remove();
  }
  // ProseMirror reads the HTML given it again, as a page's body. Some HTML
  // reads otherwise then, such as markup nested past the parser's depth or
  // moved between SVG or MathML and HTML, showing what wasn't shown here.
  // What reading again changes harmlessly is changed first: a carriage
  // return becomes a line break, and a line break starting a <pre> goes.
  for (const block of body.querySelectorAll('pre, textarea, listing')) {
    const first = block.firstChild;
    if (first instanceof Text) first.data = first.data.replace(/^(\r\n?|\n)/, '');
  }
  const out = body.innerHTML.replace(/\r\n?/g, '\n');
  const again = document.implementation.createHTMLDocument('');
  again.body.innerHTML = out;
  return again.body.innerHTML === out ? out.replace(MARKED, '$1$2') : null;
}
