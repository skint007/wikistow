// Whether a version's kept passages fit the text a page shows, where the
// text they were cut from isn't known (ADR 0016, step 5: the snippet).

/**
 * Whether `passages`, in order, could have been cut from `text`: each
 * starts a word of it, or the page. Passages kept under a revision ID whose
 * text has changed since, as a save into this device's queue changes it,
 * nearly always fail this, unless the change came after the last of them
 * (`meaningPassages` starts each at a word, but for a word longer than a
 * passage, cut between characters: such a page fails it too).
 */
export function cutFrom(text: string, passages: readonly { start: number }[]): boolean {
  let before = -1;
  for (const { start } of passages) {
    if (start <= before) return false;
    if (start > 0 && !(/\s/.test(text.charAt(start - 1)) && /\S/.test(text.charAt(start)))) {
      return false;
    }
    before = start;
  }
  return true;
}
