import { Fragment } from '@milkdown/kit/prose/model';
import type { EditorState } from '@milkdown/kit/prose/state';
import type { Writer } from './writer';

// What a plugin's page handle reads at the visual editor's cursor
// (`PageHandle.editor`, ADR 0011 decision 3). What it inserts goes in as
// a paste does (`pasting` in plugins.ts).

/**
 * What `state` has selected, as Markdown written as the page would write
 * it, with LF line breaks, or `''` at a cursor. Text within one block is
 * that text alone, without the block's own Markdown (a heading's `#`).
 */
export function selectedMarkdown(state: EditorState, write: Writer): string {
  const { selection, schema, doc } = state;
  if (selection.empty) return '';
  const { $from, $to } = selection;
  const text = () => doc.textBetween(selection.from, selection.to, '\n\n');
  const paragraph = schema.nodes['paragraph'];
  if (!paragraph) return text();
  let blocks: Fragment;
  if ($from.sameParent($to) && $from.parent.isTextblock) {
    // In a code block, the text is what it says.
    if ($from.parent.type.spec.code) return doc.textBetween($from.pos, $to.pos);
    blocks = Fragment.from(
      paragraph.create(null, $from.parent.content.cut($from.parentOffset, $to.parentOffset)),
    );
  } else {
    const { content } = selection.content();
    // An atom selected alone, as an image, is in a paragraph of its own.
    blocks = content.firstChild?.isInline
      ? Fragment.from(paragraph.create(null, content))
      : content;
  }
  const selected = schema.topNodeType.createAndFill(undefined, blocks);
  return selected ? write.write(selected, false).markdown : text();
}
