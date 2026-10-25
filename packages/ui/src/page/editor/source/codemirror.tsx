import { autocompletion, completionKeymap } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, insertNewline } from '@codemirror/commands';
import {
  Annotation,
  EditorState,
  Transaction,
  type Extension,
  type TransactionSpec,
} from '@codemirror/state';
import {
  drawSelection,
  dropCursor,
  EditorView,
  highlightSpecialChars,
  keymap,
} from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import { useEffect, useImperativeHandle, useLayoutEffect, useRef } from 'react';
import { textEdits } from '../../link-renames';
import { lineBreakFor, type EditorSurfaceProps } from '../surface';
import { referenceCompletions, wikilinkCompletions } from './completion';
import { fileDrops, withLineBreaks } from './files';
import { sourceLanguage } from './language';
import { linkMarks, recheckLinks } from './link-marks';
import { sourceTheme } from './theme';

// A change the session made (`replace`), which `onChange` doesn't report.
const external = Annotation.define<boolean>();

/**
 * The source surface: CodeMirror over the page's Markdown, with the text
 * kept exactly as given and typed. Its line breaks are the page's own (CRLF
 * stays CRLF), Enter adds only a line break, and pasted text takes the
 * page's line breaks. Text leaves CodeMirror only through `sliceDoc`, which
 * writes each line break as the page does; `doc.toString()` would write LF.
 *
 * It runs in a shadow root of its host: CodeMirror styles itself with a
 * stylesheet it builds at run time, which the Content Security Policy only
 * allows as a constructed sheet adopted by a shadow root, never as the
 * `<style>` it would add to the document.
 */
export default function CodeMirrorSurface({
  initial,
  onChange,
  links,
  onFiles,
  lineBreak,
  properties,
  otherPages,
  ref,
}: EditorSurfaceProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  // The editor is built once; it reads the latest of these when it needs them.
  const latest = useRef({ onChange, links, onFiles, properties, otherPages });
  useLayoutEffect(() => {
    latest.current = { onChange, links, onFiles, properties, otherPages };
  });
  const text = useRef(initial);

  useLayoutEffect(() => {
    const element = host.current;
    if (!element) return;
    const root = element.shadowRoot ?? element.attachShadow({ mode: 'open' });
    const editor = new EditorView({
      root,
      parent: root,
      state: EditorState.create({
        doc: text.current,
        extensions: extensions({
          // A line ending the other way stays part of its line, shown as a
          // special character, and is kept byte for byte.
          lineBreak: lineBreakFor(text.current, lineBreak),
          latest: () => latest.current,
          changed: (markdown) => {
            text.current = markdown;
            latest.current.onChange(markdown);
          },
        }),
      }),
    });
    view.current = editor;
    return () => {
      text.current = editor.state.sliceDoc();
      editor.destroy();
      root.replaceChildren();
      view.current = null;
    };
  }, []);

  // Pages and the link table change as the tree loads and saves land.
  useEffect(() => {
    view.current?.dispatch({ effects: recheckLinks.of(null) });
  }, [links]);

  useImperativeHandle(
    ref,
    () => ({
      read: () => view.current?.state.sliceDoc() ?? text.current,
      replace(markdown) {
        text.current = markdown;
        const editor = view.current;
        if (editor) replaceText(editor, markdown);
      },
      focus(at) {
        const editor = view.current;
        if (!editor) return;
        editor.focus();
        if (at === undefined) return;
        // Each line break is one position, however many characters it's written as.
        const { lineBreak } = editor.state;
        const breaks = editor.state.sliceDoc().slice(0, at).split(lineBreak).length - 1;
        const anchor = Math.min(at - breaks * (lineBreak.length - 1), editor.state.doc.length);
        editor.dispatch({ selection: { anchor }, scrollIntoView: true });
      },
      insertCode(code) {
        const editor = view.current;
        if (!editor) return;
        const { state } = editor;
        let { from, to } = state.selection.main;
        // Where the code span `at` is strictly inside ends, if it is in one.
        const spanEnd = (at: number) => {
          for (let node = syntaxTree(state).resolveInner(at, -1); ; node = node.parent) {
            if (node.name === 'InlineCode' && node.from < at && at < node.to) return node.to;
            if (!node.parent) return null;
          }
        };
        // A cursor or a selection end in a code span puts it after the span,
        // replacing nothing, so no span is cut or left a backtick short.
        const end = spanEnd(to) ?? to;
        if (end !== to || (from !== to && spanEnd(from) !== null)) from = to = end;
        // A backtick beside it would make one span of the two.
        const before = state.sliceDoc(from - 1, from) === '`' ? ' ' : '';
        const after = state.sliceDoc(to, to + 1) === '`' ? ' ' : '';
        const insert = `${before}\`${code}\`${after}`;
        editor.dispatch({
          changes: { from, to, insert },
          selection: { anchor: from + insert.length },
          scrollIntoView: true,
          userEvent: 'input',
        });
        editor.focus();
      },
    }),
    [],
  );

  return (
    <div
      ref={host}
      className="h-full w-full rounded-control border border-input bg-background font-mono text-sm leading-relaxed focus-within:ring-2 focus-within:ring-ring"
    />
  );
}

function extensions({
  lineBreak,
  latest,
  changed,
}: {
  lineBreak: string;
  latest: () => Pick<EditorSurfaceProps, 'links' | 'onFiles' | 'properties' | 'otherPages'>;
  changed: (markdown: string) => void;
}): Extension {
  const assist = () => latest().links;
  return [
    EditorState.lineSeparator.of(lineBreak),
    EditorView.clipboardInputFilter.of((text, state) => withLineBreaks(text, state.lineBreak)),
    history(),
    drawSelection(),
    dropCursor(),
    highlightSpecialChars(),
    EditorView.lineWrapping,
    sourceLanguage,
    sourceTheme,
    autocompletion({
      override: [
        wikilinkCompletions(assist),
        referenceCompletions(
          () => latest().properties,
          () => latest().otherPages,
        ),
      ],
      icons: false,
      // The list only opens inside `[[` or after `` `= ``, where Enter means to accept.
      interactionDelay: 0,
    }),
    linkMarks(assist),
    fileDrops(() => latest().onFiles),
    typingLines,
    keymap.of([
      { key: 'Enter', run: insertNewline },
      ...completionKeymap,
      ...historyKeymap,
      ...defaultKeymap,
    ]),
    EditorView.contentAttributes.of({
      id: 'page-source',
      'aria-label': 'Page source',
      spellcheck: 'true',
    }),
    EditorView.updateListener.of((update) => {
      const edited = update.transactions.some((tr) => tr.docChanged && !tr.annotation(external));
      if (edited) changed(update.state.sliceDoc());
    }),
  ];
}

/**
 * Text typed with a line break in it, or over a range of several lines,
 * goes in through the editor. Left to the browser, making or joining lines
 * writes a `style` attribute into the editor's DOM, which the Content
 * Security Policy refuses. The range is the one the browser names (a
 * spellcheck fix names one word), else the selection.
 *
 * Edits this can't take over are left to the browser. Android Chrome
 * (126 and later) edits through EditContext, so it never touches the DOM.
 * Without EditContext, joining lines can still have a `style` refused, but
 * that style only copies the line's computed one, so the text comes out
 * right (checked in #2).
 */
const typingLines = EditorView.domEventHandlers({
  beforeinput(event, view) {
    const { state } = view;
    const replacing =
      event.inputType === 'insertText' || event.inputType === 'insertReplacementText';
    const text = event.data ?? event.dataTransfer?.getData('text/plain');
    if (!replacing || view.composing || text === undefined || text === null) return false;
    const targets = targetRanges(event, view);
    // A range the editor can't place is left to the browser rather than guessed at.
    if (targets === null) return false;
    const ranges = targets.length > 0 ? targets : state.selection.ranges;
    const across = ranges.some(
      (range) => state.doc.lineAt(range.from).number !== state.doc.lineAt(range.to).number,
    );
    if (!across && !/[\r\n]/.test(text)) return false;
    event.preventDefault();
    const insert = withLineBreaks(text, state.lineBreak);
    let spec: TransactionSpec;
    if (targets.length === 0) {
      spec = state.replaceSelection(insert);
    } else {
      const changes = state.changes(targets.map(({ from, to }) => ({ from, to, insert })));
      const last = targets.at(-1);
      spec = { changes, selection: { anchor: changes.mapPos(last?.to ?? 0, 1) } };
    }
    view.dispatch(spec, { scrollIntoView: true, userEvent: 'input.type' });
    return true;
  },
});

/**
 * The document ranges an input event says it changes: none when it names
 * none, or null when one is outside the editor's text.
 */
function targetRanges(event: InputEvent, view: EditorView): { from: number; to: number }[] | null {
  const ranges: { from: number; to: number }[] = [];
  for (const range of event.getTargetRanges()) {
    const { startContainer, endContainer } = range;
    if (!view.contentDOM.contains(startContainer) || !view.contentDOM.contains(endContainer)) {
      return null;
    }
    try {
      const start = view.posAtDOM(startContainer, range.startOffset);
      const end = view.posAtDOM(endContainer, range.endOffset);
      ranges.push({ from: Math.min(start, end), to: Math.max(start, end) });
    } catch {
      return null;
    }
  }
  return ranges;
}

/**
 * Show `markdown` in `editor` by changing only what differs, one change per
 * link a save renamed (`textEdits`), so the cursor, and the person's undo
 * history, stay where they were. It isn't an edit of theirs to undo.
 */
function replaceText(editor: EditorView, markdown: string) {
  const { state } = editor;
  const { lineBreak } = state;
  const now = state.sliceDoc();
  // A position counts each line break once, however it's written.
  const position = (offset: number) =>
    offset - (lineBreak.length - 1) * (now.slice(0, offset).split(lineBreak).length - 1);
  // Whether `offset` is inside a CRLF line break, which no edit may start or end in.
  const splits = (offset: number) =>
    lineBreak === '\r\n' && offset > 0 && now.slice(offset - 1, offset + 1) === lineBreak;
  const changes = textEdits(now, markdown).map(({ from, to, insert }) => {
    if (splits(from)) {
      from--;
      insert = `\r${insert}`;
    }
    if (splits(to)) {
      to++;
      insert = `${insert}\n`;
    }
    return { from: position(from), to: position(to), insert: state.toText(insert) };
  });
  if (changes.length === 0) return;
  editor.dispatch({
    changes,
    annotations: [external.of(true), Transaction.addToHistory.of(false)],
  });
}
