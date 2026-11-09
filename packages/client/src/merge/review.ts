// What saving a merge changes in theirs (ADR 0013, decision 7), and the
// word marks the choosing step and the review show.
import { diffArrays, diffWordsWithSpace } from 'diff';

/** A run of text as a word diff marks it. */
export type Mark = { text: string; change: 'same' | 'added' | 'removed' };

/** `from` changed into `to`, word by word, the spaces between words kept. */
export function wordMarks(from: string, to: string): Mark[] {
  return diffWordsWithSpace(from, to).map((part) => ({
    text: part.value,
    change: part.added ? 'added' : part.removed ? 'removed' : 'same',
  }));
}

/**
 * One line of the review, block by block: unchanged blocks (a run of them
 * as one, for the view to fold), a changed block with its words marked,
 * or a block added or taken out.
 */
export type ReviewLine =
  | { kind: 'same'; text: string }
  | { kind: 'changed'; marks: Mark[] }
  | { kind: 'added'; text: string }
  | { kind: 'removed'; text: string };

/** A piece of the Markdown, with what it reads as. */
export type Piece = { text: string; key: string };

const isBlank = ({ key }: Piece) => key.startsWith('blank:');

const wordsOf = (text: string) => new Set(text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);

// How alike two pieces are: the share of the longer one's words they
// have in common, or 0 below half.
function likeness(a: Piece, b: Piece): number {
  const [x, y] = [wordsOf(a.text), wordsOf(b.text)];
  const shared = [...x].filter((word) => y.has(word)).length;
  const share = shared / Math.max(x.size, y.size, 1);
  return share >= 0.5 ? share : 0;
}

/**
 * The pairs of `from` and `to`, in order, that are most alike in all
 * (each a removed piece and the added piece it changed into), as indexes.
 */
function pairsOf(from: readonly Piece[], to: readonly Piece[]): [number, number][] {
  const like = from.map((a) => to.map((b) => likeness(a, b)));
  const pair = (i: number, j: number) => like[i]?.[j] ?? 0;
  // best[i][j]: the most likeness from[i…] and to[j…] can pair up.
  const best = Array.from({ length: from.length + 1 }, () =>
    new Array<number>(to.length + 1).fill(0),
  );
  const at = (i: number, j: number) => best[i]?.[j] ?? 0;
  for (let i = from.length - 1; i >= 0; i--) {
    const row = best[i] ?? [];
    for (let j = to.length - 1; j >= 0; j--) {
      const paired = pair(i, j) > 0 ? pair(i, j) + at(i + 1, j + 1) : 0;
      row[j] = Math.max(at(i + 1, j), at(i, j + 1), paired);
    }
  }
  const pairs: [number, number][] = [];
  for (let i = 0, j = 0; i < from.length && j < to.length;) {
    if (pair(i, j) > 0 && at(i, j) === pair(i, j) + at(i + 1, j + 1)) pairs.push([i++, j++]);
    else if (at(i, j) === at(i + 1, j)) i++;
    else j++;
  }
  return pairs;
}

/**
 * `merged` against `theirs`, by what each piece reads as, so a change of
 * style alone never shows. A run that changed as many pieces as it had
 * shows each as changed; another shows what it took out, then what it
 * added. Blank lines added or taken out don't show.
 */
export function reviewLines(theirs: readonly Piece[], merged: readonly Piece[]): ReviewLine[] {
  const lines: ReviewLine[] = [];
  const same = (text: string) => {
    const last = lines.at(-1);
    if (last?.kind === 'same') last.text += text;
    else lines.push({ kind: 'same', text });
  };
  let removed: Piece[] = [];
  let added: Piece[] = [];
  const flush = () => {
    const out = removed.filter((piece) => !isBlank(piece));
    const into = added.filter((piece) => !isBlank(piece));
    const changed = (from: Piece, to: Piece) =>
      lines.push({ kind: 'changed', marks: wordMarks(from.text, to.text) });
    if (out.length === into.length) {
      out.forEach((piece, i) => changed(piece, into[i] ?? piece));
    } else {
      // Pieces that share most of their words are one piece changed,
      // paired so that they are most alike in all.
      let o = 0;
      let a = 0;
      const stops: [number, number][] = [...pairsOf(out, into), [out.length, into.length]];
      for (const [i, j] of stops) {
        for (const { text } of out.slice(o, i)) lines.push({ kind: 'removed', text });
        for (const { text } of into.slice(a, j)) lines.push({ kind: 'added', text });
        const [from, to] = [out[i], into[j]];
        if (from && to) changed(from, to);
        [o, a] = [i + 1, j + 1];
      }
    }
    removed = [];
    added = [];
  };
  let t = 0;
  let m = 0;
  const changes = diffArrays([...theirs], [...merged], { comparator: (a, b) => a.key === b.key });
  for (const change of changes) {
    if (change.removed) {
      removed.push(...theirs.slice(t, (t += change.count)));
      continue;
    }
    if (change.added) {
      added.push(...merged.slice(m, (m += change.count)));
      continue;
    }
    flush();
    // As merged, which is what is saved.
    same(
      merged
        .slice(m, m + change.count)
        .map(({ text }) => text)
        .join(''),
    );
    t += change.count;
    m += change.count;
  }
  flush();
  return lines;
}
