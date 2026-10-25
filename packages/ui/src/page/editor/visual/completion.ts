import type { PropertyData } from '@wikistow/client';
import type { EditorState } from '@milkdown/kit/prose/state';
import { Plugin, TextSelection } from '@milkdown/kit/prose/state';
import type { EditorView } from '@milkdown/kit/prose/view';
import { $prose } from '@milkdown/kit/utils';
import {
  linkOptions,
  matching,
  TYPING_LINK,
  type LinkOption,
  type LinkOptions,
} from '../link-completions';
import { matchingProperties, propertyOptions, TYPING_REFERENCE } from '../property-completions';
import type { LinkAssist } from '../surface';

// What an atom (a link, an image, a line break) reads as in the text before the cursor.
const ATOM = '￼';

/**
 * What's being typed, the cursor at `to`: a link, `[[` at `from` and the
 * text between; or a reference to one of the page's values, typed as text
 * after `` `= `` (`prefix`, from its backtick on), its name from `from`.
 * Code already a span isn't completed: the cursor is only ever in one as
 * it's put there, not as a reference is typed.
 */
type Typing =
  | { kind: 'link'; from: number; to: number; typed: string }
  | { kind: 'reference'; from: number; to: number; typed: string; prefix: string };

function typingAt(state: EditorState): Typing | null {
  const { selection } = state;
  if (!selection.empty) return null;
  const { $from } = selection;
  const { parent } = $from;
  if (!parent.isTextblock || parent.type.spec.code) return null;
  if ($from.marks().some((mark) => mark.type.spec.code)) return null;
  const offset = $from.parentOffset;
  const before = parent.textBetween(Math.max(0, offset - 500), offset, undefined, ATOM);
  const match = TYPING_LINK.exec(before);
  // Not an embed (`![[`), nor across an atom.
  if (match && before[match.index - 1] !== '!' && !match[0].includes(ATOM)) {
    return {
      kind: 'link',
      from: $from.pos - (before.length - match.index),
      to: $from.pos,
      typed: match[0],
    };
  }
  // Not after another backtick, which opens a longer code span.
  const reference = TYPING_REFERENCE.exec(before);
  if (!reference || before[reference.index - 1] === '`' || reference[0].includes(ATOM)) return null;
  const name = reference[1] ?? '';
  return {
    kind: 'reference',
    from: $from.pos - name.length,
    to: $from.pos,
    typed: name,
    prefix: reference[0].slice(0, reference[0].length - name.length),
  };
}

/** The list on screen: its options, the one Enter takes, and where the link starts. */
export type CompletionList = {
  id: string;
  /** What the options are for: a link, or a property. */
  label: string;
  options: readonly LinkOption[];
  active: number;
  at: { left: number; top: number; bottom: number };
} | null;

let lists = 0;

/**
 * Wikilink completion in the visual editor, as the source editor has it
 * (`linkOptions`): after `[[`, the pages a link here may name, then
 * "Create page"; after `#`, headings. Arrow keys move through the list,
 * Enter or Tab writes the link as its atom, Escape closes it.
 */
export class LinkCompletion {
  readonly id = `link-options-${++lists}`;
  readonly #links: () => LinkAssist;
  readonly #markdown: () => string;
  readonly #properties: () => readonly PropertyData[] | null;
  #list: CompletionList = null;
  readonly #listeners = new Set<() => void>();
  #view: EditorView | null = null;
  #typing: Typing | null = null;
  #start = 0;
  // Where the person closed the list, which stays closed until they type another link.
  #dismissed: number | null = null;
  #asked = 0;
  // The headings found for the link typed at `from` up to its `#`, kept
  // while only the heading is typed: they may take a while to read (#87).
  #headings: { from: number; target: string; found: Promise<LinkOptions | null> } | null = null;

  constructor(
    links: () => LinkAssist,
    markdown: () => string,
    properties: () => readonly PropertyData[] | null = () => null,
  ) {
    this.#links = links;
    this.#markdown = markdown;
    this.#properties = properties;
  }

  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => void this.#listeners.delete(listener);
  };

  list = (): CompletionList => this.#list;

  #show(list: CompletionList) {
    this.#list = list;
    const dom = this.#view?.dom;
    if (dom) {
      dom.setAttribute('aria-expanded', String(list !== null));
      const active = list && list.options.length > 0 ? `${this.id}-${list.active}` : null;
      if (active) dom.setAttribute('aria-activedescendant', active);
      else dom.removeAttribute('aria-activedescendant');
    }
    for (const listener of this.#listeners) listener();
  }

  /** Work the options out again: the pages or link table changed. */
  refresh() {
    this.#typing = null;
    this.#headings = null;
    if (this.#view) this.#update(this.#view);
  }

  #update(view: EditorView) {
    const typing = typingAt(view.state);
    const was = this.#typing;
    if (typing && was && typing.from === was.from && typing.typed === was.typed) return;
    this.#typing = typing;
    // Options still being found are for typing that's gone.
    const asked = ++this.#asked;
    if (!typing || this.#dismissed === typing.from) {
      if (!typing) [this.#dismissed, this.#headings] = [null, null];
      if (this.#list) this.#show(null);
      return;
    }
    void this.#options(typing).then((found) => {
      if (asked !== this.#asked || this.#view !== view) return;
      const typed = typing.typed.slice(found?.start ?? 0);
      const options = !found
        ? []
        : typing.kind === 'link'
          ? matching(found.options, typed)
          : matchingProperties(found.options, typed);
      if (!found || options.length === 0) {
        this.#show(null);
        return;
      }
      this.#start = found.start;
      const { left, top, bottom } = view.coordsAtPos(
        typing.kind === 'reference' ? typing.from - typing.prefix.length : typing.from,
      );
      const label = typing.kind === 'link' ? 'Link to' : 'Property';
      this.#show({ id: this.id, label, options, active: 0, at: { left, top, bottom } });
    });
  }

  #options(typing: Typing): Promise<LinkOptions | null> {
    if (typing.kind !== 'link') {
      return Promise.resolve({ start: 0, options: propertyOptions(this.#properties()) });
    }
    const hash = typing.typed.indexOf('#');
    if (hash < 0) return linkOptions(typing.typed, this.#links(), this.#markdown);
    const target = typing.typed.slice(0, hash + 1);
    const kept = this.#headings;
    if (kept?.from === typing.from && kept.target === target) return kept.found;
    const found = linkOptions(typing.typed, this.#links(), this.#markdown);
    this.#headings = { from: typing.from, target, found };
    return found;
  }

  #move(by: number) {
    const list = this.#list;
    if (!list) return;
    const count = list.options.length;
    this.#show({ ...list, active: (list.active + by + count) % count });
  }

  /** Write option `index` as the link or reference being typed. */
  accept(index: number) {
    const [view, typing, list] = [this.#view, this.#typing, this.#list];
    const option = list?.options[index];
    if (view && typing && option && typing.kind !== 'link') {
      this.#reference(view, typing, option.text);
      return;
    }
    const type = view?.state.schema.nodes['wikilink'];
    if (!view || !typing || !option || !type) return;
    const source = `${typing.typed.slice(0, this.#start)}${option.text}]]`;
    const { doc } = view.state;
    const closed = doc.textBetween(typing.to, Math.min(typing.to + 2, doc.content.size)) === ']]';
    const tr = view.state.tr.replaceWith(
      typing.from,
      closed ? typing.to + 2 : typing.to,
      type.create({ source }),
    );
    tr.setSelection(TextSelection.create(tr.doc, typing.from + 1));
    view.dispatch(tr.scrollIntoView());
    view.focus();
    // Refused, as while text the session gave is checked: nothing else happens either.
    if (view.state.doc === doc) return;
    option.accepted?.();
  }

  /**
   * Write `name` as the reference being typed, as inline code from its
   * backtick on, the closing one included if it's there, the cursor after it.
   */
  #reference(view: EditorView, typing: Extract<Typing, { kind: 'reference' }>, name: string) {
    const { state } = view;
    const code = state.schema.marks['inlineCode'];
    if (!code) return;
    const start = typing.from - typing.prefix.length;
    const closed =
      state.doc.textBetween(typing.to, Math.min(typing.to + 1, state.doc.content.size)) === '`';
    const text = `${typing.prefix.slice(1)}${name}`;
    const tr = state.tr.replaceWith(
      start,
      closed ? typing.to + 1 : typing.to,
      state.schema.text(text, [code.create()]),
    );
    tr.setSelection(TextSelection.create(tr.doc, start + text.length));
    view.dispatch(tr.removeStoredMark(code).scrollIntoView());
    view.focus();
  }

  #key(event: KeyboardEvent): boolean {
    const list = this.#list;
    if (!list || event.altKey || event.ctrlKey || event.metaKey) return false;
    switch (event.key) {
      case 'ArrowDown':
        this.#move(1);
        return true;
      case 'ArrowUp':
        this.#move(-1);
        return true;
      case 'Enter':
      case 'Tab':
        this.accept(list.active);
        return true;
      case 'Escape':
        this.#dismissed = this.#typing?.from ?? null;
        this.#show(null);
        return true;
      default:
        return false;
    }
  }

  readonly plugin = $prose(
    () =>
      new Plugin({
        view: (view) => {
          this.#view = view;
          view.dom.setAttribute('aria-autocomplete', 'list');
          view.dom.setAttribute('aria-controls', this.id);
          view.dom.setAttribute('aria-expanded', 'false');
          return {
            update: (view) => this.#update(view),
            destroy: () => {
              this.#view = null;
              this.#asked++;
              this.#list = null;
            },
          };
        },
        props: {
          handleKeyDown: (_view, event) => this.#key(event),
          handleDOMEvents: {
            blur: () => {
              this.#asked++;
              if (this.#list) this.#show(null);
              this.#typing = null;
              return false;
            },
          },
        },
      }),
  );
}
