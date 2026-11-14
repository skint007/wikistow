import { editorViewCtx, parserCtx, serializerCtx } from '@milkdown/kit/core';
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

/** An editor nobody sees that pastes, its empty page, and its writer. */
type Paster = { view: EditorView; empty: EditorState; writer: Writer };

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
      return { view, empty: view.state, writer: made };
    });
  })().catch((error: unknown) => {
    shared = undefined;
    throw error;
  });
  return shared;
}

// The writer reads back a slice of this long at a time, letting the page
// get on between, so a long clip doesn't hold up typing.
const SLICE_MS = 10;

async function prepared(writer: Writer, doc: Node) {
  for (;;) {
    const end = performance.now() + SLICE_MS;
    if (writer.prepare(doc, () => performance.now() < end)) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/**
 * `html` as the Markdown pasting it, with `text` as its plain text, into
 * an empty page in the visual editor writes, with a final line break, and
 * whether that reads back as what the paste showed. HTML that gives
 * nothing, as when it can't be read (`unstyled`), gives `text`, as a
 * paste does. Empty if neither gives anything.
 */
export async function htmlMarkdown(html: string, text = ''): Promise<Written> {
  if (!html && !text) return { markdown: '', faithful: true };
  const { view, empty, writer } = await paster();
  view.updateState(empty);
  const data = new DataTransfer();
  data.setData('text/html', html);
  data.setData('text/plain', text);
  // As the browser hands ProseMirror a paste.
  view.dom.dispatchEvent(
    new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
  );
  const { doc } = view.state;
  // Not holding on to the clip.
  view.updateState(empty);
  await prepared(writer, doc);
  return writer.write(doc, true);
}
