import { EditorSelection, StateEffect, StateField, type EditorState } from '@codemirror/state';
import { Decoration, EditorView } from '@codemirror/view';
import type { Findable, FindSession } from '../../find/findable';
import { withLineBreaks } from './files';
import {
  isMatch,
  matchesIn,
  matchFrom,
  NOTHING_FOUND,
  type FindQuery,
  type Found,
  type Match,
} from '../../find/match';

/** What Find on page looks for in the source, and the matches, by position. */
type Finding = { query: FindQuery | null; matches: readonly Match[] };

const setQuery = StateEffect.define<FindQuery | null>();

// Each line break is one position, so the text joined with LF has the editor's own positions.
const matchesOf = (state: EditorState, query: FindQuery | null) =>
  query ? matchesIn(state.doc.toString(), query) : [];

const finding = StateField.define<Finding>({
  create: () => ({ query: null, matches: [] }),
  update(value, tr) {
    let { query } = value;
    for (const effect of tr.effects) if (effect.is(setQuery)) query = effect.value;
    if (query === value.query && !tr.docChanged) return value;
    return { query, matches: matchesOf(tr.state, query) };
  },
  provide: (field) =>
    EditorView.decorations.compute([field, 'selection'], (state) => {
      const { matches } = state.field(field);
      if (matches.length === 0) return Decoration.none;
      const { from, to } = state.selection.main;
      return Decoration.set(
        matches.map((match) =>
          (isMatch(match, from, to) ? current : match_).range(match.from, match.to),
        ),
      );
    }),
});

const match_ = Decoration.mark({ class: 'cm-find-match' });
const current = Decoration.mark({ class: 'cm-find-match cm-find-current' });

/** What the bar says: the current match is the one selected, if one is. */
function foundIn(state: EditorState): Found {
  const { matches } = state.field(finding);
  if (matches.length === 0) return NOTHING_FOUND;
  const { from, to } = state.selection.main;
  const index = matches.findIndex((match) => isMatch(match, from, to));
  return { count: matches.length, current: index === -1 ? null : index };
}

/** The look of matches, in the palette's colours, as the reader's (`::highlight()` in app.css). */
const findTheme = EditorView.theme({
  '.cm-find-match': {
    backgroundColor: 'color-mix(in oklab, var(--draft-dot) 30%, transparent)',
    borderRadius: '2px',
  },
  '.cm-find-current': { backgroundColor: 'var(--draft-dot)', color: 'black' },
});

/**
 * Find on page in the source editor: every match marked, the current one
 * selected, which typing or replacing changes as any edit does.
 * `listening` is told of each change to what it finds.
 */
export function sourceFind(listening: () => ((found: Found) => void) | null) {
  return [
    finding,
    findTheme,
    EditorView.updateListener.of((update) => {
      const report = listening();
      if (!report) return;
      const before = update.startState.field(finding);
      const after = update.state.field(finding);
      if (before !== after || update.selectionSet) report(foundIn(update.state));
    }),
  ];
}

/** Find on page over `view()`, the source editor while it's there. */
export function sourceFindable(
  view: () => EditorView | null,
  listen: (report: ((found: Found) => void) | null) => void,
): Findable {
  return {
    replaces: true,
    open(report): FindSession {
      listen(report);
      // Select match `index` of `matches`, shown in the middle; nothing if there's none.
      const go = (matches: readonly Match[], index: number | null) => {
        const match = index === null ? undefined : matches[index];
        return match
          ? {
              selection: EditorSelection.single(match.from, match.to),
              effects: [EditorView.scrollIntoView(match.from, { y: 'center' })],
            }
          : { effects: [] };
      };
      const replaceWith = (editor: EditorView, text: string, all: boolean) => {
        const { state } = editor;
        const { matches, query } = state.field(finding);
        if (!query) return 0;
        const { from, to } = state.selection.main;
        const replaced = all ? matches : matches.filter((match) => isMatch(match, from, to));
        if (replaced.length === 0) return 0;
        // In the page's line breaks, as text pasted is.
        const insert = state.toText(withLineBreaks(text, state.lineBreak));
        const changes = state.changes(replaced.map((match) => ({ ...match, insert })));
        // On to the next match, after what was put in; replacing all, after the last.
        const last = replaced.at(-1)!;
        const after = changes.mapPos(last.to, 1);
        const next = matchesOf(state.update({ changes }).state, query);
        const index = all ? null : matchFrom(next, { from: after, to: after }, 0);
        const spec = go(next, index);
        editor.dispatch({
          changes,
          selection: spec.selection ?? EditorSelection.cursor(after),
          effects: spec.effects,
          userEvent: all ? 'input.replace.all' : 'input.replace',
        });
        return replaced.length;
      };
      return {
        search(query) {
          const editor = view();
          if (!editor) return report(NOTHING_FOUND);
          const shown = query.text === '' ? null : query;
          const matches = matchesOf(editor.state, shown);
          const { from, to } = editor.state.selection.main;
          const spec = go(matches, matchFrom(matches, { from, to }, 0));
          editor.dispatch({ ...spec, effects: [setQuery.of(shown), ...spec.effects] });
          // Said even when nothing changed for the listener to hear, as when nothing is found again.
          report(foundIn(editor.state));
        },
        step(by) {
          const editor = view();
          if (!editor) return;
          const { matches } = editor.state.field(finding);
          const { from, to } = editor.state.selection.main;
          editor.dispatch(go(matches, matchFrom(matches, { from, to }, by)));
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
          view()?.dispatch({ effects: setQuery.of(null) });
        },
      };
    },
  };
}
