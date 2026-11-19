// The frame a selection is clipped from is the one the focus is in,
// followed from the page down (frames.ts); a selection left in a frame the
// focus isn't in is older, and left out.
import { describe, expect, test } from 'vite-plus/test';
import { chooseFrame, frameReads, type FrameRead } from '../src/frames.ts';

let next = 0;
/** A frame at `path`: with the focus gone into its frame `into`, if given. */
const frame = (path: number[], selection = '', into?: number): FrameRead => ({
  frameId: path.length === 0 ? 0 : ++next,
  selection,
  title: '',
  path,
  into: into ?? -1,
  left: into !== undefined,
});

describe('choosing the frame', () => {
  test('the frame the focus went into, over a selection left in the page and in a sibling', () => {
    const page = frame([], 'Old words of the page', 1);
    const sibling = frame([0], 'An older comment');
    const focused = frame([1], 'The comment');
    expect(chooseFrame([page, sibling, focused], page)).toBe(focused);
  });

  test('back in the page, a frame’s selection is left behind', () => {
    const page = frame([]);
    expect(chooseFrame([page, frame([0], 'An older comment')], page)).toBe(page);
  });

  test('in a frame with nothing selected, the page’s selection above it', () => {
    const page = frame([], 'Words of the page', 0);
    expect(chooseFrame([page, frame([0]), frame([1], 'An older comment')], page)).toBe(page);
  });

  test('down through several frames', () => {
    const page = frame([], '', 1);
    const middle = frame([1], 'Above', 0);
    const inner = frame([1, 0], 'Deep');
    expect(chooseFrame([page, frame([0], 'Off the way'), middle, inner], page)).toBe(inner);
    const empty = frame([1, 0]);
    expect(chooseFrame([page, middle, empty], page)).toBe(middle);
  });

  test('within a frame no script may reach, a selection in a frame within it', () => {
    const page = frame([], 'Old words of the page', 0);
    const within = frame([0, 0], 'Inside');
    expect(chooseFrame([page, frame([1], 'Off the way'), within], page)).toBe(within);
    // Nothing selected within: the page's.
    expect(chooseFrame([page, frame([1], 'Off the way'), frame([0, 0])], page)).toBe(page);
  });

  test('a frame in a shadow root, which has no index, alone or under another', () => {
    const page = frame([], 'Old words of the page', -1);
    const shadowed = frame([-1], 'In a widget');
    expect(chooseFrame([page, frame([0], 'Off the way'), shadowed], page)).toBe(shadowed);
    // Its own frame took the focus, with nothing selected: its selection.
    const holding = frame([-1], 'In a widget', 0);
    expect(chooseFrame([page, holding, frame([-1, 0])], page)).toBe(holding);
    // Of a frame's shadow-root frames, the one the focus went on from.
    const onward = frame([-1], '', 0);
    const deep = frame([-1, 0], 'Deep in a widget');
    expect(chooseFrame([page, frame([-1], 'Left'), onward, deep], page)).toBe(deep);
  });

  test('shadow-root frames under another branch are left out', () => {
    const page = frame([], '', 0);
    const branch = frame([0], '', -1);
    const empty = frame([0, -1]);
    const elsewhere = frame([1, -1], 'Elsewhere');
    expect(chooseFrame([page, branch, empty, frame([1]), elsewhere], page)).toBe(page);
  });

  test('the frame the context menu named, read alone', () => {
    const named = frame([2], 'Chosen', 0);
    expect(chooseFrame([named], named)).toBe(named);
  });
});

test('reads keep only what a frame said in the shape asked', () => {
  const read = { selection: 'Words', title: 'A page', path: [0, -1], into: 2, left: true };
  expect(
    frameReads([
      { frameId: 0, result: read },
      // Firefox's, for a frame where the script failed.
      { frameId: 1, result: undefined, error: new Error('No access') } as { frameId: number },
      { frameId: 2, result: { ...read, path: [0, -2] } },
      { frameId: 3, result: { ...read, path: 'top' } },
      { frameId: 4, result: { ...read, into: 1.5, left: 'yes', title: 7 } },
    ]),
  ).toEqual([
    { frameId: 0, ...read },
    { frameId: 4, selection: 'Words', title: '', path: [0, -1], into: -1, left: false },
  ]);
});
