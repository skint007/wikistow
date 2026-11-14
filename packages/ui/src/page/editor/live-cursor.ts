// Others' cursors in a live session's `body` (ADR 0015 decision 7, protocol
// section 5.10, **`presence`**), as both editors resolve them.
import * as Y from 'yjs';

/**
 * The offset in `text` a relative position names, or null when it isn't
 * in `text` (section 5.10, **`presence`**): resolved against `text` itself,
 * a position naming `body` as its root included, never through `doc.get`,
 * which would make any other root it names.
 */
export function resolveIn(text: Y.Text, encoded: Uint8Array): number | null {
  const doc = text.doc;
  if (!doc) return null;
  let position: Y.RelativePosition;
  try {
    position = Y.decodeRelativePosition(encoded);
  } catch {
    return null;
  }
  if (position.item === null) {
    if (position.tname !== 'body') return null;
    return position.assoc >= 0 ? text.length : 0;
  }
  let absolute: Y.AbsolutePosition | null;
  try {
    absolute = Y.createAbsolutePositionFromRelativePosition(
      new Y.RelativePosition(null, null, position.item, position.assoc),
      doc,
    );
  } catch {
    return null;
  }
  return absolute && absolute.type === text ? Math.min(absolute.index, text.length) : null;
}
