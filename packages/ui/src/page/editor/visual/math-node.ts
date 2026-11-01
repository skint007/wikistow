import type { MilkdownPlugin } from '@milkdown/kit/ctx';
import { InputRule } from '@milkdown/kit/prose/inputrules';
import type { Node } from '@milkdown/kit/prose/model';
import { NodeSelection, Plugin, TextSelection } from '@milkdown/kit/prose/state';
import type { EditorView, NodeView } from '@milkdown/kit/prose/view';
import { $inputRule, $node, $prose, $view } from '@milkdown/kit/utils';
import type { ElementContent } from 'hast';
import { find, html } from 'property-information';

// Math in the visual editor: each block (`$$`) or inline math (`$…$`) an
// atom holding its TeX, written back as math (`mathToMarkdownExtension`).
// It shows the MathML the reader shows; a click, or Enter on it selected,
// opens its TeX to edit beside it, drawn again as it's typed. Leaving
// the field puts it in the page; emptied, the math goes.

type Renderer = typeof import('@wikistow/client/reader/math');

// KaTeX, loaded only once a page shows math.
let renderer: Renderer | undefined;
let loading: Promise<Renderer> | undefined;
const loadRenderer = () =>
  (loading ??= import('@wikistow/client/reader/math').then((loaded) => (renderer = loaded)));

const MATHML = 'http://www.w3.org/1998/Math/MathML';

/** `node`, a sanitized hast element (`texElement`), as DOM: MathML inside `<math>`. */
function domOf(node: ElementContent, inMath = false): globalThis.Node {
  if (node.type !== 'element')
    return document.createTextNode(node.type === 'text' ? node.value : '');
  const math = inMath || node.tagName === 'math';
  const element = math
    ? document.createElementNS(MATHML, node.tagName)
    : document.createElement(node.tagName);
  for (const [key, value] of Object.entries(node.properties)) {
    if (value === null || value === undefined || value === false) continue;
    const info = find(html, key);
    const written = Array.isArray(value)
      ? value.join(info.commaSeparated ? ', ' : ' ')
      : value === true
        ? ''
        : String(value);
    element.setAttribute(info.attribute, written);
  }
  element.append(...node.children.map((child) => domOf(child, math)));
  return element;
}

const node = (name: string, display: boolean) =>
  $node(name, () => ({
    ...(display ? { group: 'block' } : { group: 'inline', inline: true }),
    atom: true,
    selectable: true,
    attrs: { value: { default: '', validate: 'string' } },
    parseDOM: [
      {
        tag: display ? 'div[data-math]' : 'span[data-math]',
        getAttrs: (dom) => ({
          value: dom instanceof HTMLElement ? (dom.getAttribute('data-math') ?? '') : '',
        }),
      },
    ],
    toDOM: (node) => [
      display ? 'div' : 'span',
      { 'data-math': node.attrs.value },
      node.attrs.value,
    ],
    parseMarkdown: {
      match: (node) => node.type === (display ? 'math' : 'inlineMath'),
      runner: (state, node, type) => {
        state.addNode(type, { value: typeof node.value === 'string' ? node.value : '' });
      },
    },
    toMarkdown: {
      match: (node) => node.type.name === name,
      runner: (state, node) => {
        state.addNode(display ? 'math' : 'inlineMath', undefined, String(node.attrs.value));
      },
    },
  }));

/** A math block (`$$`): its TeX alone on the lines between. */
export const mathBlockSchema = node('math_block', true);
/** Inline math (`$…$`). */
export const inlineMathSchema = node('math_inline', false);

const MATH_TYPES = new Set(['math_block', 'math_inline']);

// Each math view by its DOM, for Enter to open the one selected.
const views = new WeakMap<globalThis.Node, MathView>();

// Math just made, whose TeX opens once it's shown.
const opening = new WeakSet<Node>();

class MathView implements NodeView {
  readonly dom: HTMLElement;
  readonly #shown: HTMLElement;
  readonly #display: boolean;
  #node: Node;
  readonly #view: EditorView;
  readonly #getPos: () => number | undefined;
  #field: HTMLTextAreaElement | null = null;
  #gone = false;

  constructor(node: Node, view: EditorView, getPos: () => number | undefined) {
    this.#display = node.type.name === 'math_block';
    this.#node = node;
    this.#view = view;
    this.#getPos = getPos;
    const tag = this.#display ? 'div' : 'span';
    this.dom = document.createElement(tag);
    this.dom.className = `math math-editable ${this.#display ? 'math-display' : 'math-inline'}`;
    this.#shown = document.createElement(tag);
    this.dom.append(this.#shown);
    this.dom.addEventListener('click', () => this.open());
    views.set(this.dom, this);
    this.#draw();
    if (opening.has(node)) {
      opening.delete(node);
      requestAnimationFrame(() => this.open());
    }
  }

  /** `tex`, the node's own unless it's being typed, as the reader shows it; its text while KaTeX loads. */
  #draw(tex = String(this.#node.attrs.value)) {
    if (!renderer) {
      this.#shown.replaceChildren(tex);
      void loadRenderer().then(() => {
        if (!this.#gone) this.#draw(this.#field?.value ?? String(this.#node.attrs.value));
      });
      return;
    }
    this.#shown.replaceChildren(tex.trim() ? domOf(renderer.texElement(tex, this.#display)) : '');
  }

  /** Opens its TeX to edit, focused. */
  open() {
    if (this.#field || this.#gone || !this.#view.editable) return;
    // Inline, one line as wide as its TeX, which Enter puts in the page.
    const field = document.createElement('textarea');
    field.value = String(this.#node.attrs.value);
    field.spellcheck = false;
    field.setAttribute('aria-label', this.#display ? 'Math block, as TeX' : 'Math, as TeX');
    field.className = this.#display
      ? 'math-source block w-full resize-y rounded-control border border-border bg-background px-3 py-2 font-mono text-sm'
      : 'math-source resize-none overflow-hidden rounded-row border border-border bg-background px-1 align-middle font-mono text-[0.9em]';
    const fit = () => {
      if (this.#display) field.rows = Math.max(2, field.value.split('\n').length);
      else {
        field.rows = 1;
        field.cols = Math.max(4, field.value.length + 1);
      }
    };
    fit();
    field.addEventListener('input', () => {
      fit();
      this.#draw(field.value);
    });
    field.addEventListener('keydown', (event) => {
      const done =
        event.key === 'Escape' ||
        (event.key === 'Enter' && (!this.#display || event.ctrlKey || event.metaKey));
      if (!done) return;
      event.preventDefault();
      this.#close(true);
    });
    field.addEventListener('blur', () => this.#close(false));
    this.#field = field;
    this.dom.prepend(field);
    field.focus();
  }

  /** Puts what was typed in the page, or takes the math out if emptied; back in the page if `refocus`. */
  #close(refocus: boolean) {
    const field = this.#field;
    if (!field) return;
    this.#field = null;
    field.remove();
    const pos = this.#getPos();
    if (pos === undefined || this.#gone) return;
    const value = this.#display ? field.value.trim() : field.value.replace(/\s+/g, ' ').trim();
    const { tr } = this.#view.state;
    const end = pos + this.#node.nodeSize;
    if (!value) tr.delete(pos, end);
    else if (value !== this.#node.attrs.value) tr.setNodeMarkup(pos, undefined, { value });
    else this.#draw();
    if (refocus) {
      // After inline math, to type on; on a block, to move on from.
      if (!value)
        tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(pos, tr.doc.content.size))));
      else if (this.#display) tr.setSelection(NodeSelection.create(tr.doc, pos));
      else tr.setSelection(TextSelection.create(tr.doc, end));
    }
    if (tr.docChanged || refocus) this.#view.dispatch(tr.scrollIntoView());
    if (refocus) this.#view.focus();
  }

  update(node: Node) {
    if (node.type !== this.#node.type) return false;
    const changed = node.attrs.value !== this.#node.attrs.value;
    this.#node = node;
    if (changed && !this.#field) this.#draw();
    return true;
  }

  stopEvent = (event: Event) =>
    !!this.#field && event.target instanceof globalThis.Node && this.#field.contains(event.target);

  ignoreMutation = () => true;

  destroy() {
    this.#gone = true;
    views.delete(this.dom);
  }
}

/** Enter on selected math opens its TeX; in a paragraph of just `$$`, it makes a math block there. */
const mathKeys = $prose(
  () =>
    new Plugin({
      props: {
        handleKeyDown(view, event) {
          if (
            event.key !== 'Enter' ||
            event.shiftKey ||
            event.altKey ||
            event.ctrlKey ||
            event.metaKey
          )
            return false;
          const { selection, schema } = view.state;
          if (selection instanceof NodeSelection && MATH_TYPES.has(selection.node.type.name)) {
            const dom = view.nodeDOM(selection.from);
            const math = dom ? views.get(dom) : undefined;
            math?.open();
            return !!math;
          }
          const type = schema.nodes['math_block'];
          const { $from, empty } = selection;
          const paragraph = $from.parent;
          if (!type || !empty || paragraph.type.name !== 'paragraph') return false;
          if (paragraph.textContent !== '$$' || paragraph.childCount !== 1) return false;
          if ($from.parentOffset !== paragraph.content.size) return false;
          const math = type.create();
          opening.add(math);
          const tr = view.state.tr.replaceRangeWith($from.before(), $from.after(), math);
          view.dispatch(tr.scrollIntoView());
          return true;
        },
      },
    }),
);

// Typed inline math, by the reader's rule: `$`, something not a space,
// and a closing `$` after something not a space, outside code.
const TYPED = /(?<![$\\])\$([^\s$](?:[^$]*[^\s$\\])?)\$$/;

const typedMath = $inputRule(
  (ctx) =>
    new InputRule(TYPED, (state, match, start, end) => {
      const [, tex] = match;
      const code = state.schema.marks['inlineCode'];
      const inCode =
        state.doc.resolve(start).parent.type.spec.code ||
        (code && state.doc.rangeHasMark(start, end, code));
      if (!tex || inCode) return null;
      return state.tr.replaceWith(start, end, inlineMathSchema.type(ctx).create({ value: tex }));
    }),
);

/** A math block's node, its view, and Enter making one or opening one selected, as `markdownSyntaxes` registers them. */
export const mathEditorNode = (): MilkdownPlugin[] =>
  [
    mathBlockSchema,
    $view(mathBlockSchema, () => (n, v, p) => new MathView(n, v, p)),
    mathKeys,
  ].flat();

/** Inline math's node, its view, and typing it, as `markdownSyntaxes` registers them. */
export const inlineMathEditorNode = (): MilkdownPlugin[] =>
  [
    inlineMathSchema,
    $view(inlineMathSchema, () => (n, v, p) => new MathView(n, v, p)),
    typedMath,
  ].flat();
