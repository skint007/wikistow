// Which frame of a tab holds the selection to clip (#474). Each frame has
// a selection of its own, which it keeps when the focus leaves it, so the
// one to clip is where the focus is: followed from the page down, frame
// by frame, as each frame says where it is and which of its frames the
// focus went into. That holds while the popup has the focus, as each
// document keeps its focused element. `readFrame` runs in each frame, as
// the background's `probe` injects it; `chooseFrame` picks from what came.

/**
 * What `readFrame` says of one frame. `path` is where the frame is, as its
 * index among its parent's frames at each step from the page's own down,
 * which a frame can tell though its parent is of another site. A frame in
 * a shadow root has no index there, as its parent's frames leave it out:
 * -1. `into` is the index of the frame within it that the focus went into,
 * -1 if that has none; `left`, that the focus went into one.
 */
export type FrameRead = {
  frameId: number;
  selection: string;
  title: string;
  path: number[];
  into: number;
  left: boolean;
};

/**
 * Read this frame: its selection, title, place and focus. Injected as it
 * is, so it uses nothing from outside it.
 */
export function readFrame() {
  const chosen = getSelection();
  // An element's shadow root, a closed one too, which a content script may
  // open: Chrome's way, then Firefox's.
  const shadowOf = (element: Element): ShadowRoot | null => {
    try {
      return (
        element.shadowRoot ??
        globalThis.chrome?.dom?.openOrClosedShadowRoot?.(element as HTMLElement) ??
        (element as Element & { openOrClosedShadowRoot?: ShadowRoot | null })
          .openOrClosedShadowRoot ??
        null
      );
    } catch {
      return null;
    }
  };
  // The focused element, within the shadow roots it's in.
  let inner = document.activeElement;
  for (let root = inner && shadowOf(inner); root?.activeElement; root = shadowOf(inner!)) {
    inner = root.activeElement;
  }
  const child =
    inner instanceof HTMLIFrameElement ||
    inner instanceof HTMLFrameElement ||
    inner instanceof HTMLObjectElement
      ? inner.contentWindow
      : null;
  // A window's index among its parent's frames, which another site may ask.
  const indexIn = (parent: Window, frame: Window) => {
    for (let index = 0; index < parent.length; index++) {
      if (parent[index] === frame) return index;
    }
    return -1;
  };
  const path: number[] = [];
  for (let at: Window = window; at !== at.parent; at = at.parent) {
    path.unshift(indexIn(at.parent, at));
  }
  return {
    // As capture takes it (`selectedText` in capture.ts): none when it's
    // collapsed, as for text selected in a text box.
    selection: chosen && !chosen.isCollapsed ? chosen.toString() : '',
    title: document.title,
    path,
    into: child ? indexIn(window, child) : -1,
    left: child !== null,
  };
}

const index = (at: unknown) => Number.isSafeInteger(at) && (at as number) >= -1;

/** The frames' reads among `ran`, as they came: none for a frame no script ran in. */
export function frameReads(ran: { frameId?: unknown; result?: unknown }[]): FrameRead[] {
  return ran.flatMap(({ frameId, result }) => {
    const got = result as Partial<Record<keyof FrameRead, unknown>> | null | undefined;
    if (typeof frameId !== 'number' || typeof got?.selection !== 'string') return [];
    if (!Array.isArray(got.path) || !got.path.every(index)) return [];
    return [
      {
        frameId,
        selection: got.selection,
        title: typeof got.title === 'string' ? got.title : '',
        path: got.path as number[],
        into: index(got.into) ? (got.into as number) : -1,
        left: got.left === true,
      },
    ];
  });
}

const within = (read: FrameRead, prefix: number[]) =>
  read.path.length >= prefix.length && prefix.every((at, step) => read.path[step] === at);

/**
 * The frame whose selection to clip, of `reads`, from `page` down: the one
 * the focus is in, else the nearest above it with one, else `page`. A
 * selection in a frame the focus isn't in is older, and left out.
 *
 * The focus is in a frame if the nearest frame read above it says the
 * focus went in its way: the one just above, or, past frames that weren't
 * read, such as one from another site, the one above those. Frames in
 * shadow roots share their paths, so the focus may be in any that do, and
 * goes on into whichever says it went on. Of the frames it may end in,
 * the deepest is taken, the first of those as they came.
 */
export function chooseFrame(reads: FrameRead[], page: FrameRead): FrameRead {
  const has = (read: FrameRead) => read.selection.trim() !== '';
  const inside = reads
    .filter((read) => read.path.length > page.path.length && within(read, page.path))
    .sort((one, other) => one.path.length - other.path.length);
  /** The frames the focus may be in, each with those above it that it came from. */
  const from = new Map<FrameRead, FrameRead[]>([[page, []]]);
  for (const read of inside) {
    for (let depth = read.path.length - 1; depth >= page.path.length; depth--) {
      const prefix = read.path.slice(0, depth);
      const above = reads.filter((at) => at.path.length === depth && within(at, prefix));
      if (above.length === 0) continue;
      const into = above.filter((at) => from.has(at) && at.left && at.into === read.path[depth]);
      if (into.length > 0) from.set(read, into);
      break;
    }
  }
  const passed = new Set([...from.values()].flat());
  let end = page;
  for (const read of from.keys()) {
    if (!passed.has(read) && read.path.length > end.path.length) end = read;
  }
  for (let at: FrameRead | undefined = end; at; at = from.get(at)?.[0]) {
    if (has(at)) return at;
  }
  return page;
}
