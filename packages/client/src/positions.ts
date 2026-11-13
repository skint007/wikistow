// The order of the pages and folders in a folder, or at the top of a space
// (#400). A folder whose children have no positions lists them by name:
// folders first, then pages. One that has an order of its own lists the
// children with a position first, by position compared byte by byte, then
// any without one by name, as before. A position is a fractional index
// (`Position`), so moving one item writes its key alone.
import { integerLength, isPosition, POSITION_DIGITS, Position } from '@wikistow/contracts';

const DIGITS = POSITION_DIGITS;
const SMALLEST = `A${'0'.repeat(26)}`;

const integerPart = (key: string) => key.slice(0, integerLength(key[0] ?? '') ?? 0);

// A fraction strictly between `a` and `b` (null: 1), neither ending in 0.
function midpoint(a: string, b: string | null): string {
  if (b !== null) {
    let common = 0;
    while ((a[common] ?? '0') === b[common]) common++;
    if (common > 0) return b.slice(0, common) + midpoint(a.slice(common), b.slice(common));
  }
  const low = a ? DIGITS.indexOf(a[0] ?? '0') : 0;
  const high = b !== null ? DIGITS.indexOf(b[0] ?? '0') : DIGITS.length;
  if (high - low > 1) return DIGITS[Math.round((low + high) / 2)] ?? '';
  if (b !== null && b.length > 1) return b.slice(0, 1);
  return (DIGITS[low] ?? '') + midpoint(a.slice(1), null);
}

// The next integer part, or null past the largest.
function increment(integer: string): string | null {
  const [head = '', ...digits] = integer;
  for (let i = digits.length - 1; i >= 0; i--) {
    const next = DIGITS.indexOf(digits[i] ?? '') + 1;
    if (next < DIGITS.length) {
      digits[i] = DIGITS[next] ?? '';
      return head + digits.join('');
    }
    digits[i] = DIGITS[0] ?? '';
  }
  if (head === 'Z') return `a${DIGITS[0]}`;
  if (head === 'z') return null;
  const up = String.fromCharCode(head.charCodeAt(0) + 1);
  if (up > 'a') digits.push(DIGITS[0] ?? '');
  else digits.pop();
  return up + digits.join('');
}

// The integer part before, or null below the smallest.
function decrement(integer: string): string | null {
  const [head = '', ...digits] = integer;
  const last = DIGITS.at(-1) ?? '';
  for (let i = digits.length - 1; i >= 0; i--) {
    const next = DIGITS.indexOf(digits[i] ?? '') - 1;
    if (next >= 0) {
      digits[i] = DIGITS[next] ?? '';
      return head + digits.join('');
    }
    digits[i] = last;
  }
  if (head === 'a') return `Z${last}`;
  if (head === 'A') return null;
  const down = String.fromCharCode(head.charCodeAt(0) - 1);
  if (down < 'Z') digits.push(last);
  else digits.pop();
  return down + digits.join('');
}

/**
 * A position after `before` and ahead of `after`, either null for the open
 * end. Throws when they aren't positions in that order.
 */
export function positionBetween(before: string | null, after: string | null): Position {
  if (before !== null && !isPosition(before)) throw new RangeError(`Not a position: ${before}`);
  if (after !== null && !isPosition(after)) throw new RangeError(`Not a position: ${after}`);
  if (before !== null && after !== null && before >= after) {
    throw new RangeError(`${before} isn’t before ${after}`);
  }
  return Position.parse(between(before, after));
}

function between(a: string | null, b: string | null): string {
  if (a === null) {
    if (b === null) return `a${DIGITS[0]}`;
    const integer = integerPart(b);
    const fraction = b.slice(integer.length);
    if (integer === SMALLEST) return integer + midpoint('', fraction);
    if (integer < b) return integer;
    const down = decrement(integer);
    if (down === null) throw new RangeError('No position fits before it');
    return down;
  }
  const integer = integerPart(a);
  const fraction = a.slice(integer.length);
  if (b === null) return increment(integer) ?? integer + midpoint(fraction, null);
  const bInteger = integerPart(b);
  if (integer === bInteger) return integer + midpoint(fraction, b.slice(bInteger.length));
  const up = increment(integer);
  if (up === null) throw new RangeError('No position fits after it');
  return up < b ? up : integer + midpoint(fraction, null);
}

/** `count` positions in order between `before` and `after`, either null for the open end. */
export function positionsBetween(
  before: string | null,
  after: string | null,
  count: number,
): Position[] {
  if (count <= 0) return [];
  if (count === 1) return [positionBetween(before, after)];
  if (after === null) {
    const out: Position[] = [];
    let at = before;
    for (let i = 0; i < count; i++) out.push((at = positionBetween(at, null)));
    return out;
  }
  if (before === null) {
    const out: Position[] = [];
    let at: string = after;
    for (let i = 0; i < count; i++) out.unshift((at = positionBetween(null, at)));
    return out;
  }
  const half = Math.floor(count / 2);
  const middle = positionBetween(before, after);
  return [
    ...positionsBetween(before, middle, half),
    middle,
    ...positionsBetween(middle, after, count - half - 1),
  ];
}

/** A child of a folder, or of the top of a space, as its order needs it. */
export type OrderedNode = {
  id: string;
  kind: 'folder' | 'page';
  position: string | null;
  /** What it is listed by without a position: a folder's name, a page's title. */
  label: string;
};

/** Whether a folder's children are in an order of its own: any of them has a position. */
export const hasOwnOrder = (children: readonly Pick<OrderedNode, 'position'>[]) =>
  children.some((child) => child.position !== null);

const byName = (a: OrderedNode, b: OrderedNode) =>
  (a.kind === b.kind ? 0 : a.kind === 'folder' ? -1 : 1) ||
  a.label.localeCompare(b.label) ||
  (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

const byPosition = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The children of one folder, or of the top of a space, in the order every
 * list shows them: by position, the same positions by ID, then those with
 * none by name, folders first. So a folder nobody ordered lists by name.
 */
export function inTreeOrder<N extends OrderedNode>(children: readonly N[]): N[] {
  return children.toSorted((a, b) =>
    a.position !== null && b.position !== null
      ? byPosition(a.position, b.position) || byPosition(a.id, b.id)
      : a.position !== null
        ? -1
        : b.position !== null
          ? 1
          : byName(a, b),
  );
}

/** A position to write: a node's new key, or null to list it by name again. */
export type PositionWrite = { nodeId: string; position: Position | null };

/**
 * The positions to write so `order`, a folder's children listed as they
 * should now be, shows that way, writing as few as can be. Every child gets
 * a position, so a folder ordered once lists everything in its order, and
 * what comes later goes after all of it. `moved`, the child just put there,
 * always gets a new one; so does a child with none yet, or whose key is out
 * of order or the same as the one before it. When keys grow too long, the
 * whole folder is written afresh.
 */
export function positionsFor(
  order: readonly Pick<OrderedNode, 'id' | 'position'>[],
  moved: string | null,
): PositionWrite[] {
  const run = order;
  // The keys kept: increasing along the run, the moved child's never.
  const kept: (string | null)[] = [];
  let floor: string | null = null;
  for (const node of run) {
    const keep =
      node.id !== moved &&
      node.position !== null &&
      isPosition(node.position) &&
      (floor === null || node.position > floor);
    kept.push(keep ? node.position : null);
    if (keep) floor = node.position;
  }
  // Keys kept only where what's after them still fits: each gap between two
  // kept keys gets as many new ones as it needs.
  const fresh: (string | null)[] = [...kept];
  try {
    for (let i = 0; i < run.length;) {
      if (fresh[i] !== null) {
        i++;
        continue;
      }
      let end = i;
      while (end < run.length && kept[end] === null) end++;
      const keys = positionsBetween(fresh[i - 1] ?? null, kept[end] ?? null, end - i);
      if (keys.some((key) => key.length > MAX_KEY)) throw new RangeError('Too long');
      keys.forEach((key, k) => (fresh[i + k] = key));
      i = end;
    }
  } catch {
    positionsBetween(null, null, run.length).forEach((key, k) => (fresh[k] = key));
  }
  return run.flatMap((node, i) => {
    const position = fresh[i] ?? null;
    return position === node.position ? [] : [{ nodeId: node.id, position: position as Position }];
  });
}

// Keys this long are written afresh with the rest of their folder, before
// they reach the limit the server holds them to.
const MAX_KEY = 80;
