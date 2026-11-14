// Which editor each page's draft view shows the person's cursor in, as their
// presence says (protocol section 5.10, **`presence`**: `editor`), so the
// others' apps know to show a caret or a bar by the block.

const shown = new Map<string, 'source' | 'visual'>();

/** The editor the person's cursor was last in on `pageId`'s draft view: the source editor until told. */
export const liveEditorOf = (pageId: string): 'source' | 'visual' => shown.get(pageId) ?? 'source';

/** The person's cursor is in `editor` on `pageId`'s draft view; whether that's new. */
export function showLiveEditor(pageId: string, editor: 'source' | 'visual'): boolean {
  if (liveEditorOf(pageId) === editor) return false;
  shown.set(pageId, editor);
  return true;
}

/** The draft view of `pageId` closed. */
export function forgetLiveEditor(pageId: string): void {
  shown.delete(pageId);
}
