import type { MilkdownPlugin } from '@milkdown/kit/ctx';
import { Mark, type Node } from '@milkdown/kit/prose/model';
import { Plugin } from '@milkdown/kit/prose/state';
import type { EditorView, NodeView } from '@milkdown/kit/prose/view';
import { $node, $prose, $remark, $view } from '@milkdown/kit/utils';
import { blockLanguage, claimedInline, inlineSpan } from '@wikistow/plugin-sdk';
import type { Literal, Nodes, Root } from 'mdast';
import type { Options } from 'mdast-util-to-markdown';
import type { Processor } from 'unified';
import { drawBlock, type BlockDrawing, type BlockInputs } from '../../../plugins/block-drawing';
import type { PluginBlock } from '../../../plugins/runtime';
import type { VisualHost } from './host';
import { changedRanges, EXTERNAL } from './plugins';
import { readAlone } from './read-alone';

// Inline code a plugin claims (`` `plugin:<id>/<type> <text>` ``, ADR 0011,
// decision 7) in the visual editor: one atom holding the span's Markdown,
// written back exactly as it was read, so no plugin's code runs in reading
// or writing the page, and the page never changes for being claimed. Where
// a running plugin draws its type, the atom shows the plugin's view
// (`drawBlock`), whose `setText` is the person's own edit; anywhere else,
// the code it is.

declare module 'mdast' {
  /** Inline code a plugin claims, as the visual editor reads it: its Markdown (`value`), kept as it is. */
  interface PluginInline extends Literal {
    type: 'pluginInline';
  }
  interface PhrasingContentMap {
    pluginInline: PluginInline;
  }
  interface RootContentMap {
    pluginInline: PluginInline;
  }
}

/**
 * The Markdown of a code span read from `raw`, its text in the page, whose
 * code is `code`: its backticks and any space just inside them as written,
 * around its code as read. That is `raw` itself, but on lines after the
 * first, where a list's indent or a quote's `>` is the container's, which
 * writes it again, and in a table cell, whose `\|` reads as `|` (written
 * back as `\|` there).
 */
function spanSource(raw: string, code: string): string {
  const fence = /^`+/.exec(raw)?.[0] ?? '`';
  const first = raw.charAt(fence.length);
  // A space or line break just inside each end is read away, the code holding neither.
  const padded = first === ' ' || first === '\n';
  const last = padded ? raw.charAt(raw.length - fence.length - 1) : '';
  return `${fence}${padded ? first : ''}${code}${last}${fence}`;
}

/** The code a span's Markdown holds: between its backticks, one space just inside each read away. */
function codeOf(source: string): string {
  const fence = /^`+/.exec(source)?.[0] ?? '';
  const inner = source.slice(fence.length, source.length - fence.length);
  const padded = /^[ \n][\s\S]*[ \n]$/.test(inner) && /[^ \n]/.test(inner);
  return padded ? inner.slice(1, -1) : inner;
}

/** Each claimed code span `tree` holds, read from `file`, made a `pluginInline` holding its Markdown. */
function readClaimedSpans(tree: Root, file: { toString(): string }) {
  const text = String(file);
  const stack: Nodes[] = [tree];
  for (let node = stack.pop(); node; node = stack.pop()) {
    if (!('children' in node)) continue;
    for (const [i, child] of node.children.entries()) {
      if (child.type !== 'inlineCode' || !claimedInline(child.value)) {
        stack.push(child);
        continue;
      }
      const start = child.position?.start.offset;
      const end = child.position?.end.offset;
      // Without where it was read, there's nothing to keep: left as code.
      if (start === undefined || end === undefined) continue;
      const value = spanSource(text.slice(start, end), child.value);
      node.children[i] = { type: 'pluginInline', value, position: child.position };
    }
  }
}

/** Writes a `pluginInline` back as it was read; in a table cell, its bars escaped. */
const writeClaimedSpans: Options = {
  handlers: {
    pluginInline: (node: { value: string }, _parent, state) =>
      state.stack.includes('tableCell') ? node.value.replace(/\|/g, '\\|') : node.value,
  },
};

/** The remark step reading claimed spans, and the writing of them, for the visual editor only. */
const claimedSpans = $remark(
  'pluginInline',
  () =>
    function (this: Processor) {
      (this.data().toMarkdownExtensions ??= []).push(writeClaimedSpans);
      return readClaimedSpans;
    },
);

/** Whether `source` is a claimed span's Markdown, and only that. */
const isClaimedSpan = (source: string) => {
  const read = readAlone(source);
  return (
    read?.type === 'inlineCode' &&
    claimedInline(read.value) !== null &&
    codeOf(source) === read.value
  );
};

export const pluginInlineSchema = $node('plugin_inline', () => ({
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  attrs: { source: { default: '', validate: 'string' } },
  parseDOM: [
    {
      tag: 'span[data-plugin-inline]',
      // Pasted, taken only if it reads as just this span, as it's written as it is.
      getAttrs: (dom) => {
        const source = dom instanceof HTMLElement ? dom.getAttribute('data-plugin-inline') : null;
        return source !== null && isClaimedSpan(source) && { source };
      },
    },
  ],
  // Its code as code, which is what's pasted where its Markdown isn't taken.
  toDOM: (node) => [
    'span',
    { 'data-plugin-inline': node.attrs.source },
    ['code', codeOf(String(node.attrs.source))],
  ],
  parseMarkdown: {
    match: (node) => node.type === 'pluginInline',
    runner: (state, node, type) => {
      state.addNode(type, { source: typeof node.value === 'string' ? node.value : '' });
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === 'plugin_inline',
    runner: (state, node) => {
      state.addNode('pluginInline', undefined, String(node.attrs.source));
    },
  },
}));

/**
 * A claimed span: the view of a running plugin that draws its type, in an
 * editor someone sees, else its code. The view's `setText` makes the span's
 * Markdown anew (`inlineSpan`), as the person's edit; the view that asked
 * isn't drawn again for it.
 */
class PluginInlineView implements NodeView {
  readonly dom = document.createElement('span');
  readonly #view: EditorView;
  readonly #getPos: () => number | undefined;
  readonly #host: VisualHost;
  readonly #unsubscribe: () => void;
  #node: Node;
  /** The plugin's view drawn, and which; no drawing while it is first drawn. */
  #drawn: { span: PluginBlock; drawing: BlockDrawing | null } | null = null;

  constructor(node: Node, view: EditorView, getPos: () => number | undefined, host: VisualHost) {
    this.#node = node;
    this.#view = view;
    this.#getPos = getPos;
    this.#host = host;
    this.dom.contentEditable = 'false';
    this.#draw();
    this.#unsubscribe = host.plugins()?.subscribe(() => this.#draw()) ?? (() => {});
  }

  #claimed() {
    return claimedInline(codeOf(String(this.#node.attrs.source)));
  }

  #setText(text: string) {
    const pos = this.#getPos();
    const claimed = this.#claimed();
    if (pos === undefined || !claimed) return;
    const source = inlineSpan(claimed.pluginId, claimed.type, text);
    if (source === this.#node.attrs.source) return;
    this.#view.dispatch(this.#view.state.tr.setNodeMarkup(pos, undefined, { source }));
  }

  /** The plugin's view, or the code, as plugins come and go and the span changes. */
  #draw() {
    const page = this.#host.page();
    const runtime = this.#host.plugins();
    const claimed = this.#claimed();
    const span =
      page && claimed
        ? runtime?.get().inline.get(blockLanguage(claimed.pluginId, claimed.type))
        : undefined;
    const inputs: BlockInputs | null =
      page && runtime && claimed
        ? {
            runtime,
            source: claimed.text,
            page,
            properties: null,
            setSource: (text) => this.#setText(text),
            setProperty: null,
          }
        : null;
    // The same view, or still none: a drawn one decides itself whether to draw again.
    if (this.#drawn?.span.view === span?.view && this.#drawn?.span.pluginId === span?.pluginId) {
      if (inputs) this.#drawn?.drawing?.update(inputs);
      if (!this.#drawn) this.#showCode();
      return;
    }
    this.#undraw();
    if (!span || !inputs) return this.#showCode();
    this.dom.className = 'plugin-inline';
    this.dom.dataset['pluginInline'] = span.type;
    // Noted first: a view failing tells the runtime, whose listeners call this again at once.
    const drawn: { span: PluginBlock; drawing: BlockDrawing | null } = { span, drawing: null };
    this.#drawn = drawn;
    drawn.drawing = drawBlock(this.dom, span, inputs);
  }

  #showCode() {
    this.dom.className = '';
    delete this.dom.dataset['pluginInline'];
    const code = document.createElement('code');
    code.textContent = codeOf(String(this.#node.attrs.source)).replace(/\n/g, ' ');
    this.dom.replaceChildren(code);
  }

  #undraw() {
    this.#drawn?.drawing?.destroy();
    this.#drawn = null;
    this.dom.replaceChildren();
  }

  update(node: Node) {
    if (node.type !== this.#node.type) return false;
    this.#node = node;
    this.#draw();
    return true;
  }

  // The plugin's view takes its own events, such as typing in a field of its own.
  stopEvent = (event: Event) =>
    this.#drawn !== null &&
    event.target instanceof globalThis.Node &&
    this.dom.contains(event.target);

  ignoreMutation = () => true;

  destroy() {
    this.#unsubscribe();
    this.#undraw();
  }
}

/** Whether an inline node is written as a code span: a claimed span, or code. */
const claimed = (node: Node) => node.type.name === 'plugin_inline';
const writtenAsCode = (node: Node) =>
  claimed(node) || node.marks.some((mark) => mark.type.spec.code);

/** A node's marks but code, which are written around its code span. */
const outside = (node: Node) => node.marks.filter((mark) => !mark.type.spec.code);

/**
 * A space between a claimed span and code right beside it, as where the
 * text between them was deleted: Markdown can't hold two code spans side
 * by side, which would be written, and read again, as one. Where other
 * marks differ, as emphasis or a link around one of them, what's written
 * between them parts them already. Only the text blocks the person's
 * change reached, of text or of marks, are looked at; the page shown
 * afresh, as from another device, is left as it is.
 */
const keptApart = $prose(
  () =>
    new Plugin({
      appendTransaction(transactions, _old, state) {
        if (!transactions.some((tr) => tr.docChanged && !tr.getMeta(EXTERNAL))) return null;
        const { doc } = state;
        const spaces: { pos: number; marks: readonly Mark[] }[] = [];
        const seen = new Set<number>();
        // Marks too: text beside a span made code is a change of marks only.
        for (const { from, to } of changedRanges(transactions, true)) {
          doc.nodesBetween(
            Math.max(0, from - 1),
            Math.min(doc.content.size, to + 1),
            (node, pos) => {
              if (!node.isTextblock) return true;
              if (seen.has(pos)) return false;
              seen.add(pos);
              let before: Node | null = null;
              node.forEach((child, offset) => {
                const together =
                  before &&
                  writtenAsCode(before) &&
                  writtenAsCode(child) &&
                  (claimed(before) || claimed(child)) &&
                  Mark.sameSet(outside(before), outside(child));
                // In the marks both have outside the code, such as italic.
                if (together) spaces.push({ pos: pos + 1 + offset, marks: outside(child) });
                before = child;
              });
              return false;
            },
          );
        }
        if (spaces.length === 0) return null;
        const tr = state.tr;
        for (const { pos, marks } of spaces.sort((a, b) => b.pos - a.pos))
          tr.insert(pos, state.schema.text(' ', marks));
        return tr;
      },
    }),
);

/** Claimed spans' reading and writing, their node and its view, and spans kept apart from code. */
export const pluginInlineNode = (host: VisualHost): MilkdownPlugin[] =>
  [
    claimedSpans,
    pluginInlineSchema,
    keptApart,
    $view(
      pluginInlineSchema,
      () => (node, view, getPos) => new PluginInlineView(node, view, getPos, host),
    ),
  ].flat();
