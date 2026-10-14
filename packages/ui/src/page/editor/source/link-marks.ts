import { ChangeSet, StateEffect, type ChangeDesc, type Range } from '@codemirror/state';
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  keymap,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view';
import type { PlacedWikilink } from '@wikistow/client';
import { plainText } from '../../../components/name';
import { MarkdownWorker, READ_BUDGET_MS } from '../../markdown-worker';
import { ambiguousAmong, type AmbiguousLink } from '../link-model';
import type { LinkAssist } from '../surface';

/** Work the marks out again: the pages or link table changed. */
export const recheckLinks = StateEffect.define<null>();

// How long typing pauses before links are read again; until then the marks
// move with the text.
const RECHECK_MS = 250;

/** The page's text with each line break one character, as CodeMirror counts positions. */
const textOf = (view: EditorView) => view.state.doc.sliceString(0, undefined, '\n');

/** Whether `changes` change anything inside `link`, not just beside it. */
function editedInside(link: PlacedWikilink, changes: ChangeDesc): boolean {
  let inside = false;
  changes.iterChangedRanges((from, to) => {
    if (from < link.end && to > link.start) inside = true;
  });
  return inside;
}

/**
 * `links`, read from an earlier text, where they are after `changes`. A
 * link edited inside goes, until the text is read again: what it names may
 * have changed.
 */
const mapped = (links: readonly PlacedWikilink[], changes: ChangeDesc): PlacedWikilink[] =>
  links.flatMap((link) =>
    editedInside(link, changes)
      ? []
      : [{ ...link, start: changes.mapPos(link.start, 1), end: changes.mapPos(link.end, -1) }],
  );

// A small button after an ambiguous link, asking which page it means.
class ChooseWidget extends WidgetType {
  readonly link: AmbiguousLink;
  readonly assist: () => LinkAssist;

  constructor(link: AmbiguousLink, assist: () => LinkAssist) {
    super();
    this.link = link;
    this.assist = assist;
  }

  override eq(other: ChooseWidget) {
    return (
      other.link.key === this.link.key &&
      other.link.target === this.link.target &&
      other.link.chosen === this.link.chosen
    );
  }

  override toDOM() {
    const { key, target, chosen } = this.link;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = chosen ? 'cm-link-choose cm-link-chosen' : 'cm-link-choose';
    const label = `${chosen ? 'Change' : 'Choose'} which page “${plainText(target)}” means`;
    button.setAttribute('aria-label', label);
    button.title = `More than one page has this title. ${label} (Alt+Enter).`;
    // Keep the cursor where it is; the click opens the chooser.
    button.addEventListener('mousedown', (event) => event.preventDefault());
    button.addEventListener('click', () => this.assist().choose({ key, target }));
    return button;
  }
}

function marks(links: readonly PlacedWikilink[], assist: () => LinkAssist): DecorationSet {
  const ranges: Range<Decoration>[] = links.map((link) =>
    Decoration.mark({ class: 'cm-wikilink' }).range(link.start, link.end),
  );
  const current = assist();
  if (current.pages) {
    const scope = { pages: current.pages, table: current.table, selfId: current.selfId };
    for (const link of ambiguousAmong(links, scope)) {
      if (link.chosen === null) {
        ranges.push(Decoration.mark({ class: 'cm-wikilink-ambiguous' }).range(link.from, link.to));
      }
      ranges.push(
        Decoration.widget({ widget: new ChooseWidget(link, assist), side: 1 }).range(link.to),
      );
    }
  }
  return Decoration.set(ranges, true);
}

/**
 * Wikilinks styled as links, and each one several pages have the title of
 * marked, with a button to choose which page it means. Alt+Enter on such a
 * link chooses too. The links are read in a worker of the editor's own,
 * given as long as the reader, once typing pauses: some text takes the
 * parser far longer than its size suggests (#87). Until then the marks
 * move with the text; a page whose links can't be read in time has none.
 */
export function linkMarks(assist: () => LinkAssist) {
  const plugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet = Decoration.none;
      /** The links as last read, where they are in the text now. */
      links: PlacedWikilink[] = [];
      /** The read under way, and the changes made since it was asked for. */
      reading: { since: ChangeSet } | null = null;
      /** The text changed during the read under way: read it again after. */
      again = false;
      timer: ReturnType<typeof setTimeout> | undefined;
      readonly reader = new MarkdownWorker();
      readonly view: EditorView;

      constructor(view: EditorView) {
        this.view = view;
        this.read();
      }

      update(update: ViewUpdate) {
        if (update.docChanged) {
          if (this.reading) this.reading.since = this.reading.since.compose(update.changes);
          const links = mapped(this.links, update.changes);
          // A link edited inside loses its marks and button now, not once read again.
          const kept = links.length === this.links.length;
          this.links = links;
          this.decorations = kept
            ? this.decorations.map(update.changes)
            : marks(this.links, assist);
          clearTimeout(this.timer);
          this.timer = setTimeout(() => this.read(), RECHECK_MS);
        }
        const asked = update.transactions.some((tr) => tr.effects.some((e) => e.is(recheckLinks)));
        if (asked) this.decorations = marks(this.links, assist);
      }

      // Read the links of the text as it is now; the marks follow once they're
      // read. Never during an update: it dispatches only once they are. A
      // read under way finishes first, its links moved with the text, so a
      // slow read still lands while typing goes on.
      read() {
        if (this.reading) {
          this.again = true;
          return;
        }
        const text = textOf(this.view);
        // Every wikilink is written with `[[`: a page without one has none to read.
        if (!text.includes('[[')) {
          if (this.links.length > 0 || this.decorations.size > 0) this.show([]);
          return;
        }
        const reading = { since: ChangeSet.empty(this.view.state.doc.length) };
        this.reading = reading;
        const settle = (links: readonly PlacedWikilink[]) => {
          // The editor closed meanwhile: nothing to show.
          if (this.reading !== reading) return;
          this.reading = null;
          this.show(mapped(links, reading.since));
          if (this.again) {
            this.again = false;
            this.read();
          }
        };
        this.reader
          .run('wikilinks', text, { budgetMs: READ_BUDGET_MS })
          // Past its time, or not readable at all: taken as written, as the reader does.
          .then(settle, () => settle([]));
      }

      show(links: PlacedWikilink[]) {
        this.links = links;
        this.view.dispatch({ effects: recheckLinks.of(null) });
      }

      destroy() {
        clearTimeout(this.timer);
        this.reading = null;
        this.reader.close();
      }
    },
    { decorations: (plugin) => plugin.decorations },
  );
  /** Open the chooser for the ambiguous link at the cursor. */
  const chooseAtCursor = (view: EditorView) => {
    const current = assist();
    const links = view.plugin(plugin)?.links ?? [];
    if (!current.pages) return false;
    const scope = { pages: current.pages, table: current.table, selfId: current.selfId };
    const head = view.state.selection.main.head;
    const link = ambiguousAmong(links, scope).find((l) => l.from <= head && head <= l.to);
    if (!link) return false;
    current.choose({ key: link.key, target: link.target });
    return true;
  };
  return [plugin, keymap.of([{ key: 'Alt-Enter', run: chooseAtCursor }])];
}
