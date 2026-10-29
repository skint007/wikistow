import { QUERY_LANGUAGE, type AttachmentRef } from '@wikistow/client';
import { CODE_LANGUAGES, type AlertType } from '@wikistow/client/reader';
import { Fragment, type Node } from '@milkdown/kit/prose/model';
import { NodeSelection, Plugin, Selection, TextSelection } from '@milkdown/kit/prose/state';
import type { EditorView, NodeView } from '@milkdown/kit/prose/view';
import {
  blockquoteSchema,
  codeBlockSchema,
  imageSchema,
  listItemSchema,
} from '@milkdown/kit/preset/commonmark';
import { tableSchema } from '@milkdown/kit/preset/gfm';
import { $prose, $view } from '@milkdown/kit/utils';
import { createRoot } from 'react-dom/client';
import { Picker, type PickerOption } from '@/components/ui/picker';
import { cn } from '@/lib/utils';
import { QUOTE_KINDS } from '../../alert-title';
import { attachmentId } from '../../attachments';
import { alertIn } from './alerts';
import { setKind, type QuoteKind } from './formatting';
import { claimedBlock, PluginError, type BlockProps } from '@wikistow/plugin-sdk';
import {
  blockProperties,
  checkedProperty,
  setOwn,
  stillShown,
  type DrawnProperties,
} from '../../../plugins/block-properties';
import { takesPropsInPlace, updateInPlace } from '../../../plugins/in-place';
import type { PluginBlock } from '../../../plugins/runtime';
import { attachmentById, type VisualHost } from './host';
import type { QueryResults } from './query-results';

/** A note in place of an image that isn't shown, as the reader writes it. */
export function notLoaded(alt: string): HTMLElement {
  const note = document.createElement('span');
  note.className =
    'inline-flex items-center gap-1.5 rounded-row bg-muted px-2 py-1 text-sm text-muted-foreground';
  note.textContent = alt ? `Image not loaded: ${alt}` : 'Image not loaded';
  return note;
}

/**
 * Show attachment `ref` in `into`: a note while it's decrypted, then the
 * image. `current` says whether it's still wanted when that's done.
 */
export function showAttachment(
  host: VisualHost,
  into: HTMLElement,
  ref: AttachmentRef,
  alt: string,
  current: () => boolean,
) {
  const waiting = document.createElement('span');
  waiting.className = 'text-sm text-muted-foreground';
  waiting.textContent = `Decrypting ${ref.name}…`;
  into.replaceChildren(waiting);
  void host
    .attachments()
    .url(ref)
    .then((url) => {
      if (!current()) return;
      if (!url) {
        into.replaceChildren(notLoaded(alt));
        return;
      }
      const image = document.createElement('img');
      image.src = url;
      image.alt = alt || ref.name;
      image.className = 'max-w-full rounded-control';
      into.replaceChildren(image);
    });
}

/**
 * An image: one of the page's attachments, decrypted here, or a note. An
 * image on another host is never loaded, nor its address given to an `img`.
 */
class ImageView implements NodeView {
  readonly dom = document.createElement('span');
  #node: Node;
  readonly #host: VisualHost;
  #shown = 0;

  constructor(node: Node, host: VisualHost) {
    this.#node = node;
    this.#host = host;
    this.dom.className = 'inline-block max-w-full';
    host.live.add(this);
    this.redraw();
  }

  redraw() {
    const { src, alt } = this.#node.attrs;
    const id = attachmentId(typeof src === 'string' ? src : undefined);
    const ref = id === null ? undefined : attachmentById(this.#host, id);
    const text = typeof alt === 'string' ? alt : '';
    const shown = ++this.#shown;
    if (!ref) this.dom.replaceChildren(notLoaded(text));
    else showAttachment(this.#host, this.dom, ref, text, () => shown === this.#shown);
  }

  update(node: Node) {
    if (node.type !== this.#node.type) return false;
    const same = node.attrs.src === this.#node.attrs.src && node.attrs.alt === this.#node.attrs.alt;
    this.#node = node;
    if (!same) this.redraw();
    return true;
  }

  ignoreMutation = () => true;

  destroy() {
    this.#shown++;
    this.#host.live.delete(this);
  }
}

export const imageView = (host: VisualHost) =>
  $view(imageSchema.node, () => (node) => new ImageView(node, host));

/**
 * A table in a box that scrolls sideways, so a wide one isn't squeezed
 * into the editor's width (see `.tableWrapper` in app.css).
 */
class TableView implements NodeView {
  dom = document.createElement('div');
  contentDOM: HTMLElement;

  constructor() {
    this.dom.className = 'tableWrapper';
    const table = this.dom.appendChild(document.createElement('table'));
    this.contentDOM = table.appendChild(document.createElement('tbody'));
  }
}

export const tableView = $view(tableSchema.node, () => () => new TableView());

/**
 * A code block under a picker of its language: `text` for none, then
 * highlight.js's languages, with the block's own label too if it's none of
 * them, kept as written. Choosing one changes only the label. The picker
 * is outside the editable text, its menu outside the editor.
 *
 * A fence a running plugin claims (`plugin:<id>/<block>`) shows that
 * plugin's view instead of its text, in an editor someone sees: the view's
 * changes become the block's text, as the person's own edits. Without the
 * plugin it is this ordinary code block, and turns back into the view as
 * the plugin starts.
 */
/**
 * A plugin's view drawn for a block: the text it was drawn for or last
 * set, the properties it was drawn with and those it set, whether it could
 * set them, the element and props it was drawn with, for one that takes
 * new props in place, and what undoes it.
 */
type DrawnBlock = {
  block: PluginBlock;
  source: string;
  properties: DrawnProperties;
  settable: boolean;
  element: HTMLElement;
  props: BlockProps | null;
  undo: (() => void) | void;
};

/** The plugin block a code block is drawn as: a running plugin claims it, in an editor someone sees. */
const drawnAs = (node: Node, host: VisualHost): PluginBlock | undefined =>
  host.page() && node.type.name === 'code_block'
    ? host.plugins()?.get().blocks.get(String(node.attrs.language))
    : undefined;

/**
 * A code block a plugin draws is one unit, as an image is: its text is
 * hidden, so the cursor never goes into it. Backspace just after it and
 * Delete just before it select it instead of joining text into it, and a
 * cursor that lands in its text selects it whole.
 */
export const pluginBlockUnits = (host: VisualHost) =>
  $prose(
    () =>
      new Plugin({
        props: {
          handleKeyDown(view, event) {
            const back = event.key === 'Backspace';
            if (!back && event.key !== 'Delete') return false;
            const { selection, doc } = view.state;
            if (!(selection instanceof TextSelection) || !selection.empty) return false;
            const { $head } = selection;
            const atEdge = back
              ? $head.parentOffset === 0
              : $head.parentOffset === $head.parent.content.size;
            if (!atEdge || $head.depth === 0) return false;
            // Delete at the end of the last item of a list or quote joins what follows
            // the list, as ProseMirror's join looks past the end of each node it ends.
            for (let depth = $head.depth - 1; depth >= 0; depth--) {
              const index = $head.index(depth);
              const beside = $head.node(depth).maybeChild(back ? index - 1 : index + 1);
              if (beside) {
                if (!drawnAs(beside, host)) return false;
                const pos = back
                  ? $head.before(depth + 1) - beside.nodeSize
                  : $head.after(depth + 1);
                view.dispatch(view.state.tr.setSelection(NodeSelection.create(doc, pos)));
                return true;
              }
              // Backspace at the start of a list or quote lifts it out instead.
              if (back) return false;
            }
            return false;
          },
        },
        appendTransaction(_transactions, _old, state) {
          const { selection } = state;
          if (!(selection instanceof TextSelection) || !drawnAs(selection.$from.parent, host)) {
            return null;
          }
          return state.tr.setSelection(NodeSelection.create(state.doc, selection.$from.before()));
        },
      }),
  );

class CodeBlockView implements NodeView {
  readonly dom = document.createElement('div');
  readonly contentDOM = document.createElement('code');
  readonly #header = document.createElement('div');
  readonly #picker = createRoot(this.#header);
  readonly #block = document.createElement('div');
  readonly #pre = document.createElement('pre');
  // A query block's result, under its code (`QueryResults`).
  readonly #result = document.createElement('div');
  #query: ReturnType<QueryResults['add']> | null = null;
  readonly #view: EditorView;
  readonly #getPos: () => number | undefined;
  readonly #host: VisualHost;
  readonly #unsubscribe: () => void;
  #node: Node;
  #drawn: DrawnBlock | null = null;
  /** Its fence names a plugin that isn't drawing it, which its label says. */
  #missing = false;

  constructor(node: Node, view: EditorView, getPos: () => number | undefined, host: VisualHost) {
    this.#node = node;
    this.#view = view;
    this.#getPos = getPos;
    this.#host = host;
    this.dom.className = 'code-block';
    this.#header.className = 'code-language';
    this.#header.contentEditable = 'false';
    this.#block.className = 'plugin-block';
    this.#block.contentEditable = 'false';
    this.#pre.append(this.contentDOM);
    this.#result.className = 'query-result';
    this.#result.contentEditable = 'false';
    this.dom.append(this.#header, this.#block, this.#pre);
    this.#show();
    this.#unsubscribe = host.plugins()?.subscribe(() => this.#drawBlock()) ?? (() => {});
    host.propertyViews.add(this);
  }

  /** The page's properties changed: a block drawn for others is drawn again. */
  propertiesChanged() {
    this.#drawBlock();
  }

  #relabel(language: string) {
    const pos = this.#getPos();
    if (pos !== undefined)
      this.#view.dispatch(
        this.#view.state.tr.setNodeMarkup(pos, undefined, { ...this.#node.attrs, language }),
      );
  }

  /** Make `text` the block's text, as an edit; the view that asked isn't drawn again for it. */
  #setSource(text: string) {
    const pos = this.#getPos();
    if (pos === undefined || this.#node.textContent === text) return;
    const { state } = this.#view;
    const content = text ? state.schema.text(text) : Fragment.empty;
    if (this.#drawn) this.#drawn.source = text;
    this.#view.dispatch(state.tr.replaceWith(pos + 1, pos + 1 + this.#node.content.size, content));
  }

  #undraw() {
    try {
      this.#drawn?.undo?.();
    } catch {
      // Its own cleanup failing leaves nothing of the editor's behind.
    }
    this.#drawn = null;
    this.#block.replaceChildren();
  }

  /** The claiming plugin's view in place of the text, or the text, as plugins come and go. */
  #drawBlock() {
    const page = this.#host.page();
    const block = drawnAs(this.#node, this.#host);
    const missing =
      page !== null && !block && claimedBlock(String(this.#node.attrs.language)) !== null;
    if (missing !== this.#missing) {
      this.#missing = missing;
      this.#renderHeader();
    }
    const source = this.#node.textContent;
    const properties = blockProperties(this.#host.properties());
    const settable = this.#host.setProperty() !== null;
    // The same view, for the same text and properties, but for those it set
    // itself: the runtime rebuilds its list on every change. One the app
    // draws, a script's form, takes new properties in place instead, so it
    // and the field being typed in it stay.
    const kept = this.#drawn;
    const inPlace = kept !== null && takesPropsInPlace(kept.block.view);
    if (
      kept?.block.view === block?.view &&
      (!kept ||
        (kept.source === source &&
          kept.settable === settable &&
          (inPlace || stillShown(kept.properties, properties))))
    ) {
      // Drawn again with the same values, as for another page's, it takes nothing.
      const changed = JSON.stringify(kept?.properties.shown) !== JSON.stringify(properties);
      if (kept && inPlace && kept.props && changed) {
        kept.properties = { shown: properties, own: new Map() };
        kept.props = { ...kept.props, properties };
        updateInPlace(kept.element, kept.props);
      }
      return;
    }
    this.#undraw();
    this.#pre.classList.toggle('hidden', block !== undefined);
    if (!block || !page) return;
    const element = document.createElement('div');
    this.#block.append(element);
    const drawn: DrawnBlock = {
      block,
      source,
      properties: { shown: properties, own: new Map() },
      settable,
      element,
      props: null,
      undo: undefined,
    };
    this.#drawn = drawn;
    try {
      drawn.props = {
        source,
        page: { ...page },
        setSource: (text) => {
          if (this.#drawn === drawn) this.#setSource(text);
        },
        properties,
        setProperty: settable
          ? (key, value) => {
              const checked = checkedProperty(key, value);
              const set = this.#host.setProperty();
              if (this.#drawn !== drawn || !set) return;
              setOwn(drawn.properties, checked.key, checked.value, () => {
                const made = set(checked.key, checked.value);
                if (!made.ok) throw new PluginError('invalid', made.reason);
              });
            }
          : null,
      };
      drawn.undo = block.view(element, drawn.props);
    } catch (error) {
      element.textContent = 'This plugin block failed. Switch to source to edit it as text.';
      this.#host.plugins()?.viewFailed(block.pluginId, error);
    }
  }

  #show() {
    const language = String(this.#node.attrs.language);
    if (language) this.#pre.dataset.language = language;
    else delete this.#pre.dataset.language;
    this.#renderHeader();
    this.#drawBlock();
    this.#drawQuery();
  }

  /** A query block's result under it, for its text now; any other block has none. */
  #drawQuery() {
    const queries = this.#host.queries;
    const query = String(this.#node.attrs.language) === QUERY_LANGUAGE && queries;
    if (!query) {
      this.#query?.remove();
      this.#query = null;
      this.#result.remove();
      return;
    }
    if (this.#query) this.#query.set(this.#node.textContent);
    else {
      this.dom.append(this.#result);
      this.#query = query.add(this.#result, this.#node.textContent);
    }
  }

  #renderHeader() {
    const language = String(this.#node.attrs.language);
    // A block labelled `text` shows as plain text, which it is.
    const shown = language === 'text' ? '' : language;
    const names = ['', ...CODE_LANGUAGES];
    if (!names.includes(shown)) names.splice(1, 0, shown);
    const claimed = this.#missing ? claimedBlock(language) : null;
    this.#picker.render(
      <>
        <Picker
          label="Code language"
          value={shown}
          options={names.map((name) => ({ value: name, label: name || 'text' }))}
          onChange={(language) => this.#relabel(language)}
          // Lightened on hover instead of the Picker's tint, which would dim the label.
          className="-mx-1 h-auto w-auto gap-1 rounded-row border-0 bg-transparent px-1 py-0.5 text-xs hover:bg-background/60 hover:bg-none! data-[state=open]:bg-background/60 data-[state=open]:bg-none! [&>svg]:size-3"
        />
        {claimed && <span> · shown as written, without the {claimed.pluginId} plugin</span>}
      </>,
    );
  }

  update(node: Node) {
    if (node.type !== this.#node.type) return false;
    const relabelled = node.attrs.language !== this.#node.attrs.language;
    this.#node = node;
    if (relabelled) this.#show();
    else {
      this.#drawBlock();
      this.#drawQuery();
    }
    return true;
  }

  stopEvent = (event: Event) =>
    event.target instanceof globalThis.Node &&
    (this.#header.contains(event.target) ||
      this.#block.contains(event.target) ||
      this.#result.contains(event.target));

  ignoreMutation = (mutation: MutationRecord | { type: 'selection'; target: globalThis.Node }) =>
    mutation.type === 'selection'
      ? this.#header.contains(mutation.target) ||
        this.#block.contains(mutation.target) ||
        this.#result.contains(mutation.target)
      : !this.contentDOM.contains(mutation.target);

  // Not while React may be rendering, as the editor can update then.
  destroy() {
    this.#unsubscribe();
    this.#host.propertyViews.delete(this);
    this.#undraw();
    this.#query?.remove();
    queueMicrotask(() => this.#picker.unmount());
  }
}

export const codeBlockView = (host: VisualHost) =>
  $view(
    codeBlockSchema.node,
    () => (node, view, getPos) => new CodeBlockView(node, view, getPos, host),
  );

// Each quote kind as its picker's value: an ordinary quote is `quote`.
const QUOTE_TYPES: PickerOption<AlertType | 'quote'>[] = QUOTE_KINDS.map(
  ({ kind, label, icon }) => ({
    value: kind ?? 'quote',
    label,
    icon,
  }),
);

/**
 * A block quote under a picker of its type: Quote, or one of GitHub's
 * alerts (`alertIn`), whose label it shows in the alert's colour. Choosing
 * one changes only this quote's marker (`setKind`), keeping what it holds,
 * then focus goes back to the text, in this quote, so undo is a key away. The picker is
 * outside the editable text, its menu outside the editor.
 */
class QuoteView implements NodeView {
  readonly dom = document.createElement('blockquote');
  readonly contentDOM = document.createElement('div');
  readonly #header = document.createElement('div');
  readonly #picker = createRoot(this.#header);
  readonly #view: EditorView;
  readonly #getPos: () => number | undefined;
  #node: Node;
  #kind: QuoteKind;

  constructor(node: Node, view: EditorView, getPos: () => number | undefined) {
    this.#node = node;
    this.#kind = alertIn(node)?.type ?? null;
    this.#view = view;
    this.#getPos = getPos;
    this.#header.className = 'quote-type';
    this.#header.contentEditable = 'false';
    this.dom.append(this.#header, this.contentDOM);
    this.#show();
  }

  #retype(kind: QuoteKind) {
    const pos = this.#getPos();
    if (pos === undefined) return;
    const tr = this.#view.state.tr;
    setKind(tr, pos, kind);
    // The cursor into this quote, at the end of its text, unless it's in
    // it already, so what's typed next goes here.
    const end = pos + (tr.doc.nodeAt(pos)?.nodeSize ?? 0);
    const last = Selection.findFrom(tr.doc.resolve(end - 1), -1, true);
    if (last && (tr.selection.from <= pos || tr.selection.to >= end)) tr.setSelection(last);
    this.#view.dispatch(tr);
  }

  #show() {
    const alert = this.#kind !== null;
    this.#picker.render(
      <Picker
        label="Type of quote"
        value={this.#kind ?? 'quote'}
        options={QUOTE_TYPES}
        onChange={(type) => this.#retype(type === 'quote' ? null : type)}
        refocus={() => this.#view.focus()}
        // Lightened on hover instead of the Picker's tint, which would dim an alert's label.
        className={cn(
          '-mx-1 h-auto w-auto gap-1.5 rounded-row border-0 bg-transparent px-1 py-0.5 hover:bg-background/60 hover:bg-none! data-[state=open]:bg-background/60 data-[state=open]:bg-none!',
          alert
            ? 'text-[length:inherit] font-bold text-(--alert)'
            : 'text-xs text-subtle-foreground [&_svg]:size-3.5',
        )}
      />,
    );
  }

  update(node: Node) {
    if (node.type !== this.#node.type) return false;
    this.#node = node;
    const kind = alertIn(node)?.type ?? null;
    if (kind !== this.#kind) {
      this.#kind = kind;
      this.#show();
    }
    return true;
  }

  stopEvent = (event: Event) =>
    event.target instanceof globalThis.Node && this.#header.contains(event.target);

  ignoreMutation = (mutation: MutationRecord | { type: 'selection'; target: globalThis.Node }) =>
    mutation.type === 'selection'
      ? this.#header.contains(mutation.target)
      : !this.contentDOM.contains(mutation.target);

  // Not while React may be rendering, as the editor can update then.
  destroy() {
    queueMicrotask(() => this.#picker.unmount());
  }
}

export const quoteView = $view(
  blockquoteSchema.node,
  () => (node, view, getPos) => new QuoteView(node, view, getPos),
);

/**
 * A list item, and for a task a checkbox before it that ticks it. The
 * checkbox is the browser's own, outside the editable text.
 */
class ListItemView implements NodeView {
  readonly dom = document.createElement('li');
  readonly contentDOM: HTMLElement;
  readonly #checkbox: HTMLInputElement | null = null;
  #node: Node;

  constructor(node: Node, view: EditorView, getPos: () => number | undefined) {
    this.#node = node;
    if (typeof node.attrs.checked !== 'boolean') {
      this.contentDOM = this.dom;
      return;
    }
    this.dom.dataset.itemType = 'task';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = node.attrs.checked;
    checkbox.contentEditable = 'false';
    checkbox.setAttribute('aria-label', 'Done');
    checkbox.addEventListener('change', () => {
      const pos = getPos();
      if (pos === undefined) return;
      view.dispatch(
        view.state.tr.setNodeMarkup(pos, undefined, {
          ...this.#node.attrs,
          checked: checkbox.checked,
        }),
      );
    });
    this.#checkbox = checkbox;
    this.contentDOM = document.createElement('div');
    this.dom.append(checkbox, this.contentDOM);
  }

  update(node: Node) {
    const task = typeof node.attrs.checked === 'boolean';
    if (node.type !== this.#node.type || task !== (this.#checkbox !== null)) return false;
    this.#node = node;
    if (this.#checkbox) this.#checkbox.checked = node.attrs.checked === true;
    return true;
  }

  stopEvent = (event: Event) => event.target === this.#checkbox;

  ignoreMutation = (mutation: MutationRecord | { type: 'selection'; target: globalThis.Node }) =>
    mutation.target === this.#checkbox;
}

export const listItemView = $view(
  listItemSchema.node,
  () => (node, view, getPos) => new ListItemView(node, view, getPos),
);
