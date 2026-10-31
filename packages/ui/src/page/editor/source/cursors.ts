import { addCursorAbove, addCursorBelow, copyLineDown, copyLineUp } from '@codemirror/commands';
import { selectNextOccurrence } from '@codemirror/search';
import { EditorState, type Extension } from '@codemirror/state';
import {
  EditorView,
  keymap,
  rectangularSelection,
  ViewPlugin,
  type Command,
} from '@codemirror/view';

/** `command`, never falling through to the key's next binding. */
const only =
  (command: Command): Command =>
  (view) => {
    command(view);
    return true;
  };

// Whether Alt is held, as CodeMirror's `crosshairCursor` tracks it. That
// shows the crosshair with a `style` attribute, which the Content Security
// Policy refuses, so this sets a class the theme styles instead.
const altHeld = ViewPlugin.fromClass(
  class {
    held = false;
    readonly view: EditorView;

    constructor(view: EditorView) {
      this.view = view;
    }

    set(held: boolean) {
      if (held === this.held) return;
      this.held = held;
      this.view.update([]);
    }
  },
  {
    eventObservers: {
      keydown(event) {
        this.set(event.key === 'Alt' || event.altKey);
      },
      keyup(event) {
        if (event.key === 'Alt' || !event.altKey) this.set(false);
      },
      mousemove(event) {
        this.set(event.altKey);
      },
    },
  },
);

/**
 * Several cursors, as in VS Code. Alt+drag selects a column, Ctrl+D (Cmd+D
 * on a Mac) adds the next match of the selection, and `defaultKeymap` has
 * the rest: Ctrl+Alt+Up and Down (Cmd+Alt on a Mac) add a cursor above or
 * below, Escape goes back to one, and Ctrl+click (Cmd+click) adds one where
 * it lands. Linux desktops often take Ctrl+Alt+Up and Down, so there
 * Shift+Alt adds the cursor and copying a line moves to Ctrl+Shift+Alt.
 * Placed before `defaultKeymap`, whose Shift+Alt copies the line.
 */
export const multipleCursors: Extension = [
  EditorState.allowMultipleSelections.of(true),
  rectangularSelection(),
  altHeld,
  EditorView.contentAttributes.of((view) =>
    view.plugin(altHeld)?.held ? { class: 'cm-crosshair' } : null,
  ),
  keymap.of([
    { key: 'Mod-d', run: selectNextOccurrence, preventDefault: true },
    { linux: 'Shift-Alt-ArrowUp', run: only(addCursorAbove) },
    { linux: 'Shift-Alt-ArrowDown', run: only(addCursorBelow) },
    { linux: 'Ctrl-Shift-Alt-ArrowUp', run: copyLineUp },
    { linux: 'Ctrl-Shift-Alt-ArrowDown', run: copyLineDown },
  ]),
];
