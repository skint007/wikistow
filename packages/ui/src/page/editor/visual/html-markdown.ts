import { editorStateCtx, editorViewCtx, parserCtx, serializerCtx } from '@milkdown/kit/core';
import type { Ctx } from '@milkdown/kit/ctx';
import type { Node } from '@milkdown/kit/prose/model';
import type { EditorState } from '@milkdown/kit/prose/state';
import type { EditorView } from '@milkdown/kit/prose/view';
import { loadSyntaxNodes, visualEditor, visualPlugins } from './config';
import { inertHost } from './host';
import { changeRules, pasting } from './plugins';
import { Writer, type Written } from './writer';

// HTML as Markdown with no editor open, as a clip from the browser becomes
// a page (ADR 0017 decision 5, step 3): the Markdown pasting it into an
// empty page in the visual editor writes. It's that paste, in an editor
// nobody sees, so the two can't drift apart: `unstyled`
// (`transformPastedHTML`), ProseMirror reading what's left through the
// editor's schema, the paste's own handling (`pasting`), the rules each
// change goes through (`changeRules`), and the writer.
//
// It needs a browser's DOM, as a paste does: `unstyled` reads the HTML and
// its styles as a browser reads them (`DOMParser`, the CSSOM, the screen's
// `matchMedia` and pixel density), and ProseMirror reads the HTML left as a
// DOM. So it runs in the app's page, never its main process, which has no
// DOM, and where the vault's keys and the page writer are anyway.

/** An editor nobody sees that pastes, its context, its empty page, and its writer. */
type Paster = { ctx: Ctx; view: EditorView; empty: EditorState; writer: Writer };

let shared: Promise<Paster> | undefined;

// Made once, as the visual editor is for an empty page: with nothing given
// it, the same empty paragraph and selection.
function paster(): Promise<Paster> {
  shared ??= (async () => {
    let writer: Writer | null = null;
    const editor = visualEditor({
      root: document.createElement('div'),
      plugins: [
        ...visualPlugins(inertHost(), await loadSyntaxNodes()),
        // No files come in a clip, so none go anywhere.
        pasting(
          () => () => {},
          () => writer,
        ),
        ...changeRules,
      ].flat(),
    });
    await editor.create();
    return editor.action((ctx) => {
      const made = new Writer({ parse: ctx.get(parserCtx), serialize: ctx.get(serializerCtx) });
      writer = made;
      const view = ctx.get(editorViewCtx);
      return { ctx, view, empty: view.state, writer: made };
    });
  })().catch((error: unknown) => {
    shared = undefined;
    throw error;
  });
  return shared;
}

// The writer reads back a slice this long at a time, letting the page get
// on between, so writing a long clip out doesn't hold up typing; the paste
// before it is done at once, as a paste is. Each slice waits on a message,
// not a timer: a clip mostly comes while the app is in the background,
// where Chromium runs chained timers as rarely as once a minute.
const SLICE_MS = 10;

const nextTask = () =>
  new Promise<void>((resolve) => {
    const { port1, port2 } = new MessageChannel();
    port1.onmessage = () => {
      port1.close();
      resolve();
    };
    port2.postMessage(null);
  });

async function prepared(writer: Writer, doc: Node) {
  for (;;) {
    const end = performance.now() + SLICE_MS;
    if (writer.prepare(doc, () => performance.now() < end)) return;
    await nextTask();
  }
}

/**
 * `html` as the Markdown pasting it, with `text` as its plain text, into
 * an empty page in the visual editor writes, with a final line break, and
 * whether that reads back as what the paste showed. HTML that gives
 * nothing, as when it can't be read (`unstyled`), gives `text` as plain
 * text, as a paste does; so does no HTML at all, which a paste would read
 * as Markdown instead. Empty if neither gives anything. Whatever goes wrong
 * in the paste is thrown, not saved as a page short of it.
 */
export async function htmlMarkdown(html: string, text = ''): Promise<Written> {
  if (!html && !text) return { markdown: '', faithful: true };
  const { ctx, view, empty, writer } = await paster();
  const data = new DataTransfer();
  data.setData('text/html', html);
  data.setData('text/plain', text);
  // As the browser hands ProseMirror a paste, through the calls it makes
  // of it, which throw. With HTML, the text matters only once the HTML
  // gives nothing, when the paste's own handling reads it from the event
  // and pastes it as plain text (`view.pasteText`, with no event), as is
  // done here with no HTML.
  const event = new ClipboardEvent('paste', { clipboardData: data });
  let doc: Node;
  try {
    view.updateState(empty);
    if (html) view.pasteHTML(html, event);
    else view.pasteText(text);
    doc = view.state.doc;
  } finally {
    // Not holding on to the clip, in the view or in the state Milkdown
    // keeps of it, which it notes only as a change is made.
    view.updateState(empty);
    ctx.set(editorStateCtx, empty);
  }
  await prepared(writer, doc);
  return writer.write(doc, true);
}
