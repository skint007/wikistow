import { isolateHistory } from '@codemirror/commands';
import { EditorSelection } from '@codemirror/state';
import { EditorView } from '@codemirror/view';

// Each character that wraps a selection, and what closes it.
const PAIRS = new Map([
  ['(', ')'],
  ['[', ']'],
  ['{', '}'],
  ['<', '>'],
  ['`', '`'],
  ['"', '"'],
  ["'", "'"],
  ['*', '*'],
  ['_', '_'],
  ['~', '~'],
]);

/**
 * Wrap every selection in `text` and its pair, as one undo step, keeping
 * each selection on the text inside so typing again wraps once more. Only
 * when no selection is empty; otherwise `text` is typed as ever.
 */
function wrap(view: EditorView, text: string): boolean {
  const close = PAIRS.get(text);
  const { state } = view;
  if (close === undefined || state.selection.ranges.some((range) => range.empty)) return false;
  const spec = state.changeByRange((range) => ({
    changes: [
      { from: range.from, insert: text },
      { from: range.to, insert: close },
    ],
    range: EditorSelection.range(range.anchor + text.length, range.head + text.length),
  }));
  // Not `input.type`, which would open completion inside a new `[[`.
  view.dispatch(spec, {
    scrollIntoView: true,
    userEvent: 'input',
    annotations: isolateHistory.of('full'),
  });
  return true;
}

/**
 * Typing a bracket, quote or Markdown mark over selected text wraps it
 * rather than replacing it. Brackets never close themselves as text is
 * typed. Placed before `typingLines`, which would replace a selection over
 * several lines. Where the browser types through EditContext (Android
 * Chrome) there is no `beforeinput` to take, so the input handler wraps.
 */
export const selectionWraps = [
  EditorView.domEventHandlers({
    beforeinput(event, view) {
      if (event.inputType !== 'insertText' || view.composing || !event.data) return false;
      if (!wrap(view, event.data)) return false;
      event.preventDefault();
      return true;
    },
  }),
  // EditContext names only the part that changed: `*` typed over `*it*`
  // comes as `it*` deleted, keeping the first `*`. So this reads what the
  // whole selection became.
  EditorView.inputHandler.of((view, from, to, text) => {
    const { state } = view;
    const { main } = state.selection;
    if (view.composing || from < main.from || to > main.to) return false;
    return wrap(view, state.sliceDoc(main.from, from) + text + state.sliceDoc(to, main.to));
  }),
];
