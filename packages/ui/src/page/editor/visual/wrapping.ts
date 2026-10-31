import type { ResolvedPos } from '@milkdown/kit/prose/model';
import { EditorState, Plugin, TextSelection, type Command } from '@milkdown/kit/prose/state';
import { $prose } from '@milkdown/kit/utils';
import { FORMATS } from './formatting';

// Typed over selected text, a bracket or quote wraps it, as in a code
// editor, and a Markdown marker puts its format on it, as the toolbar
// does. The selection stays on the text, so typing again wraps it again.
// With nothing selected, typing goes on as before: the input rules turn
// typed Markdown (`*word*`) into formatting.

// Each character that wraps the selection in text, and the one closing it.
// `[` twice makes `[[text]]`, which `typedLinks` turns into a wikilink.
const PAIRS: Record<string, string> = {
  '(': ')',
  '[': ']',
  '{': '}',
  '<': '>',
  '"': '"',
  "'": "'",
};

// `open` before the selected text and `close` after it, with the marks the
// text starts with, and the selection on the text still.
const wrap =
  (open: string, close: string): Command =>
  (state, dispatch) => {
    const { selection } = state;
    if (!(selection instanceof TextSelection)) return false;
    const { $from, $to, anchor, head } = selection;
    if (dispatch) {
      const marks = $from.marksAcross($to) ?? [];
      const text = (char: string, $at: ResolvedPos) =>
        state.schema.text(char, $at.parent.type.allowedMarks(marks));
      const tr = state.tr.insert($to.pos, text(close, $to)).insert($from.pos, text(open, $from));
      dispatch(
        tr.setSelection(TextSelection.create(tr.doc, anchor + 1, head + 1)).scrollIntoView(),
      );
    }
    return true;
  };

// Each of `commands` on the selection as the one before leaves it, all in
// one transaction, so one undo step. Each runs on a state with no plugins,
// whose own would see the steps twice.
const inTurn =
  (...commands: Command[]): Command =>
  (state, dispatch) => {
    const tr = state.tr;
    for (const command of commands) {
      const now = EditorState.create({ doc: tr.doc, selection: tr.selection });
      if (!command(now, (done) => done.steps.forEach((step) => tr.step(step)))) return false;
    }
    dispatch?.(tr.scrollIntoView());
    return true;
  };

// `*` or `_`, as Markdown counts them: italic once, bold twice (`**text**`),
// both three times.
const emphasis: Command = (state, dispatch) =>
  FORMATS.italic.active(state) && !FORMATS.bold.active(state)
    ? inTurn(FORMATS.italic.run, FORMATS.bold.run)(state, dispatch)
    : FORMATS.italic.run(state, dispatch);

// The formats Markdown's markers stand for. Strikethrough stays on a
// second `~`, as GFM's `~~text~~`.
const MARKERS: Record<string, Command> = {
  '*': emphasis,
  _: emphasis,
  '`': FORMATS.code.run,
  '~': (state, dispatch) => FORMATS.strike.active(state) || FORMATS.strike.run(state, dispatch),
};

/** Brackets, quotes and Markdown's markers typed over selected text wrap it. */
export const wrapSelection = $prose(
  () =>
    new Plugin({
      props: {
        handleTextInput(view, from, to, text) {
          const { selection } = view.state;
          if (view.composing || selection.empty || from !== selection.from || to !== selection.to)
            return false;
          // Code shows markers as text, so there they wrap it as quotes do.
          const code = !!selection.$from.parent.type.spec.code;
          const close = PAIRS[text] ?? (code && text in MARKERS ? text : undefined);
          const command = (!code && MARKERS[text]) || (close && wrap(text, close));
          return !!command && command(view.state, view.dispatch);
        },
      },
    }),
);
