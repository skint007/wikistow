import type { Node } from '@milkdown/kit/prose/model';
import {
  Plugin,
  PluginKey,
  TextSelection,
  type EditorState,
  type Transaction,
} from '@milkdown/kit/prose/state';
import { Decoration, DecorationSet, type EditorView } from '@milkdown/kit/prose/view';
import { $prose } from '@milkdown/kit/utils';
import { reveal, type Findable, type FindSession } from '../../find/findable';
import {
  isMatch,
  matchesIn,
  matchFrom,
  NOTHING_FOUND,
  type FindQuery,
  type Found,
  type Match,
} from '../../find/match';

/** What Find on page looks for in the visual editor, and the matches, by document position. */
type Finding = { query: FindQuery | null; matches: readonly Match[] };

// Something in a line that isn't text, such as a wikilink or math: one
// character no typed text has, so no match takes it in.
const OBJECT = '￼';

/**
 * Where `query` is in `doc`: in each text block's text, by position. A
 * match never runs from one block into the next, nor over a wikilink or
 * math, which hold their source, not the text they show.
 */
export function matchesOf(doc: Node, query: FindQuery | null): Match[] {
  if (!query || query.text === '') return [];
  const found: Match[] = [];
  doc.descendants((block, pos) => {
    if (!block.isTextblock) return true;
    let text = '';
    // Where each child starts, in `text` and in the document, and how long it is there.
    const starts: { at: number; pos: number; size: number }[] = [];
    block.forEach((child, offset) => {
      starts.push({ at: text.length, pos: pos + 1 + offset, size: child.nodeSize });
      text += child.isText ? child.text! : OBJECT;
    });
    const position = (at: number, end: boolean) => {
      const start = starts.findLast((child) => (end ? child.at < at : child.at <= at))!;
      return start.pos + (at - start.at);
    };
    for (const match of matchesIn(text, query))
      found.push({ from: position(match.from, false), to: position(match.to, true) });
    return false;
  });
  return found;
}

const key = new PluginKey<Finding>('find');

/** What the bar says: the current match is the one selected, if one is. */
function foundIn(state: EditorState): Found {
  const matches = key.getState(state)?.matches ?? [];
  if (matches.length === 0) return NOTHING_FOUND;
  const { from, to } = state.selection;
  const index = matches.findIndex((match) => isMatch(match, from, to));
  return { count: matches.length, current: index === -1 ? null : index };
}

/**
 * Find on page in the visual editor: every match marked (`.find-match` in
 * app.css), the current one selected, which typing or replacing changes as
 * any edit does. `listening` is told of each change to what it finds.
 */
export const visualFind = (listening: () => ((found: Found) => void) | null) =>
  $prose(
    () =>
      new Plugin<Finding>({
        key,
        state: {
          init: () => ({ query: null, matches: [] }),
          apply(tr, value) {
            const query = tr.getMeta(key) as FindQuery | null | undefined;
            if (query === undefined && !tr.docChanged) return value;
            const next = query === undefined ? value.query : query;
            return { query: next, matches: matchesOf(tr.doc, next) };
          },
        },
        props: {
          decorations(state) {
            const matches = key.getState(state)?.matches ?? [];
            if (matches.length === 0) return null;
            const { from, to } = state.selection;
            return DecorationSet.create(
              state.doc,
              matches.map((match) =>
                Decoration.inline(match.from, match.to, {
                  class: isMatch(match, from, to) ? 'find-match find-current' : 'find-match',
                }),
              ),
            );
          },
        },
        view: () => ({
          update(view, before) {
            const report = listening();
            if (!report) return;
            if (
              key.getState(before) !== key.getState(view.state) ||
              !before.selection.eq(view.state.selection)
            )
              report(foundIn(view.state));
          },
        }),
      }),
  );

/** Show `match` in the middle of the boxes the editor scrolls in, without the focus. */
function show(view: EditorView, match: Match) {
  const rect = () => {
    const start = view.coordsAtPos(match.from);
    const end = view.coordsAtPos(match.to);
    return new DOMRect(
      start.left,
      start.top,
      Math.max(0, end.right - start.left),
      end.bottom - start.top,
    );
  };
  reveal(rect, view.dom);
}

/** Find on page over `view()`, the visual editor while it's there. */
export function visualFindable(
  view: () => EditorView | null,
  listen: (report: ((found: Found) => void) | null) => void,
): Findable {
  return {
    replaces: true,
    open(report): FindSession {
      listen(report);
      // Select match `index` of `matches`, then show it; nothing if there's none.
      const go = (
        editor: EditorView,
        tr: Transaction,
        matches: readonly Match[],
        index: number | null,
      ) => {
        const match = index === null ? undefined : matches[index];
        if (match) tr.setSelection(TextSelection.create(tr.doc, match.from, match.to));
        editor.dispatch(tr);
        if (match) show(editor, match);
      };
      const replaceWith = (editor: EditorView, text: string, all: boolean) => {
        const { state } = editor;
        const finding = key.getState(state);
        if (!finding?.query) return 0;
        const { from, to } = state.selection;
        const replaced = all
          ? finding.matches
          : finding.matches.filter((match) => isMatch(match, from, to));
        if (replaced.length === 0) return 0;
        const tr = state.tr;
        // From the last, so each match's place is still as found.
        for (const match of [...replaced].reverse()) {
          if (text === '') tr.delete(match.from, match.to);
          else tr.insertText(text, match.from, match.to);
        }
        const after = tr.mapping.map(replaced.at(-1)!.to, 1);
        tr.setSelection(TextSelection.create(tr.doc, after));
        // On to the next match, after what was put in; replacing all, nowhere.
        const next = matchesOf(tr.doc, finding.query);
        go(
          editor,
          tr.scrollIntoView(),
          next,
          all ? null : matchFrom(next, { from: after, to: after }, 0),
        );
        return replaced.length;
      };
      return {
        search(query) {
          const editor = view();
          if (!editor) return report(NOTHING_FOUND);
          const shown = query.text === '' ? null : query;
          const matches = matchesOf(editor.state.doc, shown);
          const { from, to } = editor.state.selection;
          go(
            editor,
            editor.state.tr.setMeta(key, shown),
            matches,
            matchFrom(matches, { from, to }, 0),
          );
          // Said even when nothing changed for the listener to hear, as when nothing is found again.
          report(foundIn(editor.state));
        },
        step(by) {
          const editor = view();
          if (!editor) return;
          const matches = key.getState(editor.state)?.matches ?? [];
          const { from, to } = editor.state.selection;
          go(editor, editor.state.tr, matches, matchFrom(matches, { from, to }, by));
        },
        replace(text) {
          const editor = view();
          if (!editor) return;
          if (foundIn(editor.state).current === null) return this.step(1);
          replaceWith(editor, text, false);
        },
        replaceAll(text) {
          const editor = view();
          return editor ? replaceWith(editor, text, true) : 0;
        },
        leave() {
          const editor = view();
          if (!editor) return false;
          editor.focus();
          return true;
        },
        end() {
          listen(null);
          const editor = view();
          editor?.dispatch(editor.state.tr.setMeta(key, null));
        },
      };
    },
  };
}
