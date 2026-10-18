import { parseWikilink, type WikilinkNode } from '@wikistow/client';
import type { MilkdownPlugin } from '@milkdown/kit/ctx';
import type { Node } from '@milkdown/kit/prose/model';
import type { NodeView } from '@milkdown/kit/prose/view';
import { $node, $view } from '@milkdown/kit/utils';
import { plainText } from '../../../components/name';
import { wikilinkView } from '../../wikilink-model';
import { ambiguousAmong } from '../link-model';
import type { VisualHost } from './host';
import { readAlone } from './read-alone';
import { notLoaded, showAttachment } from './views';

/**
 * A wikilink or embed in the visual editor: one atom holding its source,
 * written back exactly as it was read. It shows what the reader would, as
 * its editor sees it. Pasted, its source is taken only if it reads as just
 * this wikilink: it's written as it is, and the paste shows only its text.
 */
export const wikilinkSchema = $node('wikilink', () => ({
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  attrs: { source: { default: '', validate: 'string' } },
  parseDOM: [
    {
      tag: 'span[data-wikilink]',
      getAttrs: (dom) => {
        const source = dom instanceof HTMLElement ? dom.getAttribute('data-wikilink') : null;
        const link = source === null ? null : readAlone(source);
        return link?.type === 'wikilink' && link.source === source && { source };
      },
    },
  ],
  toDOM: (node) => ['span', { 'data-wikilink': node.attrs.source }, node.attrs.source],
  parseMarkdown: {
    match: (node) => node.type === 'wikilink',
    runner: (state, node, type) => {
      state.addNode(type, { source: node.source });
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === 'wikilink',
    runner: (state, node) => {
      state.addNode('wikilink', undefined, undefined, { source: node.attrs.source });
    },
  },
}));

const LINK = 'text-primary-ink';
const MISSING = 'text-muted-foreground underline decoration-dashed underline-offset-2';
const AMBIGUOUS = 'underline decoration-wavy decoration-draft-dot underline-offset-3';
const CHOOSE =
  'mx-0.5 inline-grid size-[1.25em] cursor-pointer place-items-center rounded-full bg-status-draft align-text-bottom font-sans text-[0.75em] font-bold text-status-draft-foreground';
const CHOSEN =
  'mx-0.5 inline-grid size-[1.25em] cursor-pointer place-items-center rounded-full bg-muted align-text-bottom font-sans text-[0.75em] font-bold text-muted-foreground';

/** The ambiguous link `link` is, if it is one, as the editor's pages read it. */
export function ambiguity(link: WikilinkNode, host: VisualHost) {
  const links = host.links();
  if (!links.pages) return undefined;
  const [found] = ambiguousAmong([{ ...link, start: 0, end: link.source.length }], {
    pages: links.pages,
    table: links.table,
    selfId: links.selfId,
  });
  return found;
}

const inLink = (node: Node) => node.marks.some((mark) => mark.type.name === 'link');

class WikilinkView implements NodeView {
  readonly dom = document.createElement('span');
  #source: string;
  readonly #inLink: boolean;
  readonly #host: VisualHost;
  #shown = 0;

  constructor(node: Node, host: VisualHost) {
    this.#source = String(node.attrs.source);
    this.#inLink = inLink(node);
    this.#host = host;
    this.dom.dataset.wikilink = this.#source;
    host.live.add(this);
    this.redraw();
  }

  redraw() {
    const shown = ++this.#shown;
    const link = parseWikilink(this.#source);
    this.dom.dataset.hint = this.#source;
    this.dom.className = '';
    if (!link) {
      this.dom.replaceChildren(this.#source);
      return;
    }
    const links = this.#host.links();
    const view = wikilinkView(link, {
      pages: links.pages,
      links: links.table,
      selfId: links.selfId,
      attachments: this.#host.attachments().list,
      editor: true,
    });
    const text = document.createElement('span');
    text.textContent = plainText(view.text);
    this.dom.replaceChildren(text);
    switch (view.kind) {
      case 'page':
      case 'file':
        text.className = LINK;
        break;
      case 'missing':
        text.className = MISSING;
        text.dataset.hint = 'No page has this title yet';
        break;
      case 'image': {
        const ref = this.#host.attachments().list.find((a) => a.id === view.attachmentId);
        if (ref) showAttachment(this.#host, this.dom, ref, view.text, () => shown === this.#shown);
        else this.dom.replaceChildren(notLoaded(view.text));
        return;
      }
      case 'ambiguous':
      case 'text':
        break;
    }
    const ambiguous = ambiguity(link, this.#host);
    if (!ambiguous) return;
    if (ambiguous.chosen === null) text.className = AMBIGUOUS;
    const { key, target } = ambiguous;
    const label = `${ambiguous.chosen ? 'Change' : 'Choose'} which page “${plainText(target)}” means`;
    const hint = `More than one page has this title. ${label} (Alt+Enter).`;
    // A button can't sit inside a link's `<a>`; there Alt+Enter alone opens the chooser.
    if (this.#inLink) {
      text.dataset.hint = hint;
      return;
    }
    const button = document.createElement('button');
    button.type = 'button';
    button.className = ambiguous.chosen ? CHOSEN : CHOOSE;
    button.textContent = ambiguous.chosen ? '✓' : '?';
    button.setAttribute('aria-label', label);
    button.dataset.hint = hint;
    // Keep the cursor where it is; the click opens the chooser.
    button.addEventListener('mousedown', (event) => event.preventDefault());
    button.addEventListener('click', () => this.#host.links().choose({ key, target }));
    this.dom.append(button);
  }

  update(node: Node) {
    // In or out of a link, it's drawn anew.
    if (node.type.name !== 'wikilink' || inLink(node) !== this.#inLink) return false;
    const source = String(node.attrs.source);
    if (source !== this.#source) {
      this.#source = source;
      this.dom.dataset.wikilink = source;
      this.redraw();
    }
    return true;
  }

  stopEvent = (event: Event) => event.target instanceof HTMLButtonElement;
  ignoreMutation = () => true;

  destroy() {
    this.#shown++;
    this.#host.live.delete(this);
  }
}

/** The wikilink's node and its view, as `markdownSyntaxes` registers it. */
export const wikilinkEditorNode = (host: VisualHost): MilkdownPlugin[] =>
  [wikilinkSchema, $view(wikilinkSchema, () => (node) => new WikilinkView(node, host))].flat();
