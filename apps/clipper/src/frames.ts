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
 * selection in a frame the focus isn't in is older, and left out. Where
 * the focus went into a frame that wasn't read, or into one of several
 * with no index, it's somewhere within: a frame there the focus didn't
 * leave, with a selection, comes first.
 */
export function chooseFrame(reads: FrameRead[], page: FrameRead): FrameRead {
  const has = (read: FrameRead) => read.selection.trim() !== '';
  const chain = [page];
  let below: FrameRead[] = [];
  for (let focus = page; focus.left;) {
    const step = [...focus.path, focus.into];
    const next = reads.filter((read) => read.path.length === step.length && within(read, step));
    const onward = next.length === 1 ? next : next.filter((read) => read.left);
    if (onward.length !== 1) {
      below = reads.filter((read) => within(read, step));
      break;
    }
    focus = onward[0]!;
    chain.push(focus);
  }
  return below.find((read) => !read.left && has(read)) ?? [...chain].reverse().find(has) ?? page;
}
