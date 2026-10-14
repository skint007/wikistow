import { EditorView, ViewPlugin } from '@codemirror/view';
import { pastedFiles } from '../pasted-files';
import type { EditorSurfaceProps } from '../surface';

/**
 * Where files pasted or dropped are to go, moved along with edits made
 * while they upload. Text typed there meanwhile goes after the files.
 */
type Spot = { at: number };

/** `text` with its line breaks written as the page writes them. */
export const withLineBreaks = (text: string, lineBreak: string) =>
  text.replace(/\r\n?|\n/g, lineBreak);

const filesIn = (data: DataTransfer | null) => Array.from(data?.files ?? []);

/**
 * Files pasted or dropped into the editor go to `onFiles`, and their
 * Markdown goes in where they landed once they're uploaded. Pasting files
 * replaces what was selected straight away, as pasting text does.
 *
 * Pasting or dropping text is left to the editor: it never uploads
 * anything. A paste with both text and files (a spreadsheet's cells, a
 * Word paragraph, which come with a picture of themselves) is text, unless
 * the text is only the files' names (`pastedFiles`).
 */
export function fileDrops(onFiles: () => EditorSurfaceProps['onFiles']) {
  const spots = new Set<Spot>();
  let destroyed = false;

  const upload = (view: EditorView, files: File[], spot: Spot) => {
    spots.add(spot);
    onFiles()(files, (markdown) => {
      spots.delete(spot);
      if (destroyed) return false;
      const { state } = view;
      const insert = state.toText(withLineBreaks(markdown, state.lineBreak));
      // The cursor still where the files went goes after them, as after any
      // paste; anywhere else it stays where the person is.
      const { main } = state.selection;
      const waiting = state.selection.ranges.length === 1 && main.empty && main.head === spot.at;
      view.dispatch({
        changes: { from: spot.at, insert },
        ...(waiting ? { selection: { anchor: spot.at + insert.length } } : {}),
        userEvent: 'input.paste',
      });
      return true;
    });
  };

  return [
    EditorView.domEventHandlers({
      paste(event, view) {
        const files = pastedFiles(event.clipboardData);
        if (files.length === 0) return false;
        event.preventDefault();
        const { from, to } = view.state.selection.main;
        if (to > from) {
          view.dispatch({
            changes: { from, to },
            selection: { anchor: from },
            userEvent: 'input.paste',
          });
        }
        upload(view, files, { at: from });
        return true;
      },
      drop(event, view) {
        const files = filesIn(event.dataTransfer);
        if (files.length === 0) return false;
        event.preventDefault();
        const at =
          view.posAtCoords({ x: event.clientX, y: event.clientY }) ??
          view.state.selection.main.head;
        upload(view, files, { at });
        return true;
      },
    }),
    EditorView.updateListener.of((update) => {
      if (!update.docChanged) return;
      for (const spot of spots) spot.at = update.changes.mapPos(spot.at, -1);
    }),
    // The view goes; an upload finishing later lands elsewhere.
    ViewPlugin.define(() => ({
      destroy() {
        destroyed = true;
      },
    })),
  ];
}
