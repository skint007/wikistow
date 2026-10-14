/** One range of the old text replaced, as CodeMirror's `changes` take it. */
export type TextEdit = { from: number; to: number; insert: string };

/**
 * The edits turning `old` into `next`, where a save wrote links' new
 * titles into the text (`writeLinks`): one per changed link, when the two
 * differ only inside `[[…]]` on a line. Otherwise one edit spanning what
 * differs. It reads no Markdown, so no page takes it long (#87).
 */
export function textEdits(old: string, next: string): TextEdit[] {
  if (old === next) return [];
  return linkEdits(old, next) ?? [spanning(old, next)];
}

function linkEdits(old: string, next: string): TextEdit[] | null {
  const edits: TextEdit[] = [];
  // Where each text is up to; what lies before is the same in both, but
  // for the edits made.
  let [at, to] = [0, 0];
  for (;;) {
    while (at < old.length && to < next.length && old[at] === next[to]) [at, to] = [at + 1, to + 1];
    if (at === old.length && to === next.length) return edits;
    // The texts differ inside the link that opened last, in both, or not in one.
    const start = old.lastIndexOf('[[', at - 1);
    if (start < (edits.at(-1)?.to ?? 0)) return null;
    const nextStart = start + to - at;
    const [end, nextEnd] = [linkEnd(old, start), linkEnd(next, nextStart)];
    if (end === null || nextEnd === null || end <= at || nextEnd <= to) return null;
    edits.push({ from: start, to: end, insert: next.slice(nextStart, nextEnd) });
    [at, to] = [end, nextEnd];
  }
}

// `[[…]]` on one line with no bracket inside, as a link's source is written.
const LINK = /\[\[[^[\]\r\n]*\]\]/y;

/** The end of the link-like `[[…]]` at `start` of `text`, or null if none starts there. */
function linkEnd(text: string, start: number): number | null {
  LINK.lastIndex = start;
  return LINK.test(text) ? LINK.lastIndex : null;
}

function spanning(old: string, next: string): TextEdit {
  let head = 0;
  while (head < old.length && head < next.length && old[head] === next[head]) head++;
  let tail = 0;
  while (
    tail < old.length - head &&
    tail < next.length - head &&
    old[old.length - 1 - tail] === next[next.length - 1 - tail]
  )
    tail++;
  return { from: head, to: old.length - tail, insert: next.slice(head, next.length - tail) };
}
