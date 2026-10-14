import { foldTitle, linkKey, writableInLink } from '@wikistow/client';
import { plainText } from '../../components/name';
import { linkedPage, titleOptions } from './link-model';
import type { LinkAssist } from './surface';

// What either editor offers while a wikilink is typed, whichever shows it.

/** `[[` and what follows it up to the cursor: a target, then a heading after `#`. */
export const TYPING_LINK = /\[\[[^[\]|#\n]*(?:#[^[\]|#\n]*)?$/;
/** What may follow the start of an option's text while it's still the one being typed. */
export const TYPING = /^[^[\]|#/\n]*$/;

/** One thing to write into a link being typed. */
export type LinkOption = {
  /** What the typed text is matched against. */
  label: string;
  displayLabel: string;
  detail: string | null;
  type: 'page' | 'heading' | 'create';
  /** What goes in the link from `start` on: a target, or a heading. */
  text: string;
  /** Done once the option is written: a pick recorded, a page made. */
  accepted?: () => void;
};

/** The options for a link being typed, written from `start` of the typed text on. */
export type LinkOptions = { start: number; options: LinkOption[] };

/**
 * The options for `typed`, `[[` and what follows it up to the cursor
 * (`TYPING_LINK`): the pages a link here may name, by title, then "Create
 * page" for a title none of them has; after `#`, the headings of the page
 * the link names. `markdown` is this page's text as it is now, whose own
 * headings `[[#` names. Null before the tree loads, or when nothing fits.
 */
export async function linkOptions(
  typed: string,
  links: LinkAssist,
  markdown: () => string,
): Promise<LinkOptions | null> {
  if (!links.pages || !typed.startsWith('[[')) return null;
  const hash = typed.indexOf('#');
  if (hash < 0) return titles(typed.slice(2), links);
  const scope = { pages: links.pages, table: links.table, selfId: links.selfId };
  const pageId = linkedPage(typed.slice(2, hash).trim(), scope);
  if (pageId === null) return null;
  const headings =
    pageId === links.selfId ? await links.ownHeadings(markdown()) : await links.headings(pageId);
  return {
    start: hash + 1,
    options: headings.map((text) => ({
      label: text,
      displayLabel: plainText(text),
      detail: null,
      type: 'heading',
      text,
    })),
  };
}

// The pages for a target typed so far. A target with folders (`Work/Pl`)
// completes its title among the pages in those folders.
function titles(typed: string, links: LinkAssist): LinkOptions {
  const pages = links.pages ?? [];
  const targets = links.targets();
  const slash = typed.lastIndexOf('/');
  const folders =
    slash < 0
      ? []
      : typed
          .slice(0, slash)
          .split('/')
          .map((f) => foldTitle(f.trim()));
  const inFolders = (above: readonly string[]) =>
    folders.length <= above.length &&
    folders.every((f, i) => foldTitle(above[above.length - folders.length + i] ?? '') === f);
  const options: LinkOption[] = titleOptions({ pages, selfId: links.selfId, targets })
    .filter((option) => inFolders(option.page.folders))
    .map(({ page, text, detail, pick }) => ({
      label: page.title,
      displayLabel: plainText(page.title),
      detail: detail === null ? null : plainText(detail),
      type: 'page',
      ...(slash < 0
        ? {
            text,
            ...(pick ? { accepted: () => links.pick(linkKey({ target: text }), page.id) } : {}),
          }
        : { text: page.title }),
    }));
  const title = typed.trim();
  const taken = pages.some(
    (page) =>
      (targets === null || targets.has(page.id)) &&
      page.title !== null &&
      foldTitle(page.title) === foldTitle(title),
  );
  const { create } = links;
  if (create && slash < 0 && writableInLink(title) && !taken) {
    options.push({
      label: typed,
      displayLabel: `Create page “${plainText(title)}”`,
      detail: null,
      type: 'create',
      text: title,
      accepted: () => create(title),
    });
  }
  return { start: 2 + slash + 1, options };
}

/**
 * The options that fit `query`, what's typed from `start` on, best first:
 * labels starting with it, then with a word starting with it, then holding
 * it, then holding its letters in order. "Create page" stays last.
 */
export function matching(options: readonly LinkOption[], query: string): LinkOption[] {
  const typed = foldTitle(query.trim());
  const rank = (option: LinkOption) => {
    if (option.type === 'create') return 4;
    const label = foldTitle(option.label);
    if (label.startsWith(typed)) return 0;
    if (label.split(/[\s\-_/]+/).some((word) => word.startsWith(typed))) return 1;
    if (label.includes(typed)) return 2;
    let at = 0;
    for (const char of typed) {
      at = label.indexOf(char, at) + 1;
      if (at === 0) return null;
    }
    return 3;
  };
  return options
    .map((option, i) => ({ option, i, rank: rank(option) }))
    .filter((ranked) => ranked.rank !== null)
    .sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0) || a.i - b.i)
    .map(({ option }) => option);
}
