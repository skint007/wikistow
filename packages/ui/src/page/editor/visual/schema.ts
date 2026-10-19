import type { MilkdownPlugin } from '@milkdown/kit/ctx';
import { Fragment, type Node } from '@milkdown/kit/prose/model';
import {
  htmlSchema,
  imageSchema,
  linkSchema,
  paragraphSchema,
} from '@milkdown/kit/preset/commonmark';
import {
  extendListItemSchemaForTask,
  tableCellSchema,
  tableHeaderSchema,
} from '@milkdown/kit/preset/gfm';
import type { $NodeSchema } from '@milkdown/kit/utils';
import { linkHint } from '../../../desktop';
import { ATTACHMENT_SCHEME } from '../../attachments';
import { TAB } from './copy-marks';
import { isLiteral } from './literals';

// Changes to the stock CommonMark and GFM nodes. A node's `toDOM` is also
// what copying and dragging write, so each is made safe there too, not only
// in the node views that show it.

/**
 * Images: an untitled one's title is null, which the stock schema refuses,
 * dropping the image. And `toDOM` never writes `src`: an image made in this
 * document loads even unattached, and the page's images are attachments
 * (`attachment:`, which no browser loads) or other hosts, which reading a
 * page never contacts. Their node view shows them.
 */
export const safeImage = imageSchema.extendSchema((prev) => (ctx) => {
  const schema = prev(ctx);
  return {
    ...schema,
    attrs: { ...schema.attrs, title: { default: null, validate: 'string|null' } },
    parseDOM: [
      {
        tag: 'img[data-src]',
        getAttrs: (dom) => imageAttrs(dom, 'data-src'),
      },
      // Pasted from elsewhere.
      { tag: 'img[src]', getAttrs: (dom) => imageAttrs(dom, 'src') },
    ],
    toDOM: (node) => [
      'img',
      { 'data-src': node.attrs.src, alt: node.attrs.alt, title: node.attrs.title ?? undefined },
    ],
  };
});

function imageAttrs(dom: HTMLElement | string, from: string) {
  if (!(dom instanceof HTMLElement)) return false;
  return {
    src: dom.getAttribute(from) ?? '',
    alt: dom.getAttribute('alt') ?? '',
    title: dom.getAttribute('title'),
  };
}

/**
 * Paragraphs: an empty one, as Enter twice makes, writes nothing, as plain
 * Markdown has no empty paragraphs; as a list item's first it's kept, as
 * the item's empty text (`-`), which remark needs there. Milkdown writes
 * `<br />` instead, which the reader shows as HTML; `visualPlugins` leaves
 * out its reading that back.
 */
export const plainParagraph = paragraphSchema.extendSchema((prev) => (ctx) => {
  const schema = prev(ctx);
  return {
    ...schema,
    toMarkdown: {
      ...schema.toMarkdown,
      runner: (state, node) => {
        const top = state.top();
        const first = top?.type === 'listItem' && !top.children?.length;
        if (node.content.size > 0 || first) schema.toMarkdown.runner(state, node);
      },
    },
  };
});

const LISTS = new Set(['bullet_list', 'ordered_list']);

// Whether `list`, written right after a paragraph's line, would be read as
// part of it: one starting with an empty item, or numbered from other than
// 1, can't start there (and `-` alone makes the line a heading).
const joinsParagraph = (list: Node) => {
  const first = list.firstChild;
  const empty = first?.childCount === 1 && first.firstChild?.content.size === 0;
  return empty || (list.type.name === 'ordered_list' && list.attrs['order'] !== 1);
};

/**
 * List items (as GFM's, with task boxes), written so all they hold stays
 * in them. One whose first paragraph is empty, with more after it, writes
 * that paragraph as a space (`&#x20;`): an item that starts blank can't go
 * on past a blank line. And one is loose, a blank line between each block,
 * when without one a block would join the one before: anything after a
 * list in it, as the list's last item's, or a list a paragraph would take.
 */
export const fullListItem = extendListItemSchemaForTask.extendSchema((prev) => (ctx) => {
  const schema = prev(ctx);
  return {
    ...schema,
    toMarkdown: {
      ...schema.toMarkdown,
      runner: (state, node) => {
        let item = node;
        const first = item.firstChild;
        if (first?.type.name === 'paragraph' && first.content.size === 0 && item.childCount > 1) {
          const space = first.copy(Fragment.from(first.type.schema.text(' ')));
          item = item.copy(item.content.replaceChild(0, space));
        }
        let joins = false;
        item.forEach((child, _, i) => {
          const before = i > 0 ? item.child(i - 1) : null;
          joins ||= !!before && LISTS.has(before.type.name);
          joins ||=
            before?.type.name === 'paragraph' &&
            LISTS.has(child.type.name) &&
            joinsParagraph(child);
        });
        if (joins && !item.attrs.spread)
          item = item.type.create({ ...item.attrs, spread: true }, item.content, item.marks);
        schema.toMarkdown.runner(state, item);
      },
    },
  };
});

// The text a link shows, read from Markdown: each atom in it (an image, a
// line break) as one character, as `follow` counts it.
type Inline = { type: string; value?: unknown; children?: readonly Inline[] };
const shownText = (nodes: readonly Inline[]): string =>
  nodes
    .map((node) =>
      node.type === 'text' || node.type === 'inlineCode'
        ? String(node.value)
        : node.children
          ? shownText(node.children)
          : '\uFFFC',
    )
    .join('');

// Each link read is told apart from every other, so two side by side stay two.
let links = 0;
export const linkId = () => ++links;

// A link's id as copied HTML carries it, with this tab's own token, and
// back: an id another page or tab gives is not taken. The token marks each
// node copied too, as only HTML that carries it keeps the data attributes
// read here, such as an image's `data-src` (`unstyled`).
export const copiedLinkId = (id: number) => `${TAB}:${id}`;
const pastedLinkId = (value: string | undefined) => {
  const [tab, id] = value?.split(':') ?? [];
  return tab === TAB && id && /^\d+$/.test(id) ? Number(id) : linkId();
};

/** What copying writes on each node (`copying`): this tab's token. */
export const COPIED = { 'data-copied': TAB } as const;

/** Whether `element` is a node this tab copied (`COPIED`). */
export const copiedHere = (element: Element) => element.getAttribute('data-copied') === TAB;

/**
 * Links: one made of text (`autolinks`) is `auto`, so it follows its text
 * as that's edited, not taking in what's typed after it. One read from the
 * page isn't: it keeps where it goes and what it covers, however the text
 * beside it is edited, and none takes in what's typed at its end, which
 * one made of text does only as GFM reads it so. One whose text was an
 * address (`addressOf`), its text edited inside, goes where that says, or
 * is text if it says nowhere (`autolinks`); `read` is the text it was read
 * with, or last went by, across any marks in it. Each read, pasted or made
 * of text has an `id` of its own. One that's `bare` is written as its literal
 * (`https://…`) where that reads as it: one made of text, and one the page
 * wrote so, not as `<…>` or `[…](…)`. None of these is shown, and only the
 * `id` is copied (`copying`).
 */
export const autoLink = linkSchema.extendSchema((prev) => (ctx) => {
  const schema = prev(ctx);
  return {
    ...schema,
    attrs: {
      ...schema.attrs,
      auto: { default: false },
      bare: { default: false },
      read: { default: null },
      id: { default: null },
    },
    inclusive: false,
    // Pasted, as `pastedLinks` then takes it: the pieces of one link
    // copied here have its `id` (`data-link`), until it gives them a new one.
    parseDOM: [
      {
        tag: 'a[href]',
        getAttrs: (dom) =>
          dom instanceof HTMLElement && {
            href: dom.getAttribute('href'),
            title: dom.getAttribute('title'),
            id: pastedLinkId(dom.dataset['link']),
          },
      },
    ],
    parseMarkdown: {
      ...schema.parseMarkdown,
      runner: (state, node, type) => {
        const href = String(node['url']);
        const title = typeof node['title'] === 'string' ? node['title'] : null;
        const [text, ...rest] = node.children ?? [];
        const value = text?.type === 'text' && !rest.length ? String(text['value']) : null;
        // Written bare, a link spans just its text, or has no place when
        // GFM found it in text once read.
        const from = node.position?.start.offset;
        const to = node.position?.end.offset;
        const span = from !== undefined && to !== undefined ? to - from : value?.length;
        const bare = !title && value !== null && span === value.length && isLiteral(value, href);
        const read = shownText(node.children ?? []);
        state.openMark(type, { href, title, bare, read, id: linkId() });
        state.next(node.children);
        state.closeMark(type);
      },
    },
    toMarkdown: {
      ...schema.toMarkdown,
      // Its id keeps it apart from a link beside it going the same way.
      runner: (state, mark) => {
        const { href, title, bare, id } = mark.attrs;
        state.withMark(mark, 'link', undefined, { title, url: href, data: { bare, id } });
      },
    },
    toDOM: (mark, inline) => {
      const dom = schema.toDOM?.(mark, inline);
      const [tag, attrs] = Array.isArray(dom) ? dom : ['a', {}];
      const { auto: _a, bare: _b, read: _r, id: _i, ...rest } = attrs as Record<string, unknown>;
      // Where it goes, in the desktop app; an attachment's address or a `#` place says nothing.
      const href = String(mark.attrs.href);
      const hint =
        href.startsWith(ATTACHMENT_SCHEME) || href.startsWith('#') ? undefined : linkHint(href);
      return [String(tag), { ...rest, 'data-hint': hint }];
    },
  };
});

/**
 * HTML in a page, written as it is. Pasted, it's the text it shows: the
 * value it carries, written raw where it lands, mid-paragraph, can read
 * as Markdown the paste doesn't show, such as a live link after `<div>`.
 */
export const pastedHtml = htmlSchema.extendSchema((prev) => (ctx) => ({
  ...prev(ctx),
  parseDOM: [],
}));

// A cell's alignment as a class, not the stock `style` attribute, which the
// Content Security Policy refuses.
const ALIGNED = { left: 'text-left', center: 'text-center', right: 'text-right' } as const;
type Alignment = keyof typeof ALIGNED;
const isAlignment = (value: unknown): value is Alignment =>
  typeof value === 'string' && Object.hasOwn(ALIGNED, value);

function alignmentOf(dom: HTMLElement): Alignment | null {
  for (const [alignment, name] of Object.entries(ALIGNED))
    if (dom.classList.contains(name) && isAlignment(alignment)) return alignment;
  // Pasted from elsewhere.
  const written = dom.getAttribute('align') ?? dom.style.textAlign;
  return isAlignment(written) ? written : null;
}

const alignedCell = <T extends string>(schema: $NodeSchema<T>, tag: 'td' | 'th') =>
  schema.extendSchema((prev) => (ctx) => {
    const base = prev(ctx);
    return {
      ...base,
      // A table made here has no alignment until someone gives it one.
      attrs: { ...base.attrs, alignment: { default: null } },
      parseDOM: [
        {
          tag,
          getAttrs: (dom) =>
            dom instanceof HTMLElement && {
              colspan: Number(dom.getAttribute('colspan') ?? 1),
              rowspan: Number(dom.getAttribute('rowspan') ?? 1),
              alignment: alignmentOf(dom),
            },
        },
      ],
      toDOM: (node: Node) => {
        const { colspan, rowspan, alignment } = node.attrs;
        return [
          tag,
          {
            ...(colspan === 1 ? {} : { colspan }),
            ...(rowspan === 1 ? {} : { rowspan }),
            ...(isAlignment(alignment) ? { class: ALIGNED[alignment] } : {}),
          },
          0,
        ];
      },
    };
  });

export const schemaChanges: MilkdownPlugin[] = [
  plainParagraph,
  fullListItem,
  pastedHtml,
  autoLink,
  safeImage,
  alignedCell(tableCellSchema, 'td'),
  alignedCell(tableHeaderSchema, 'th'),
].flat();
