// The overlay for a screenshot of an area (ADR 0017, step 6). The
// background takes the visible area's screenshot, then injects this into
// the tab, only when the person asks, through `activeTab` and
// `scripting`, and calls `choose` there with a nonce of its own. The
// person drags out a rectangle over the page; the overlay goes, the page
// is drawn again without it, and it tells the background the area in the
// tab's CSS pixels, by a message naming the nonce, which cuts it from that
// screenshot (shot.ts), or from one taken then if that one's gone. It answers by message, not as
// the injection's result, as the person may take minutes, and Chrome's
// service worker or Firefox's background may sleep meanwhile; a message
// wakes them.
//
// It takes only the person's own input (`isTrusted`), so the page's
// scripts can't drag one out for them; its elements are in a closed
// shadow root, so they can't read or restyle them. It's in the top layer,
// so the page can't cover it: a manual popover, which closes none of the
// page's popovers and menus and leaves focus where it was, or, while the
// page has a modal dialog open, which makes the rest of the page inert, a
// modal dialog of its own, as the newest modal is the one that isn't inert.
//
// The page can still stop it: take it off, hide it, or swallow its input
// with listeners of its own that run first. Input can't be won back, but
// the overlay notices being taken off or hidden, goes, and says so, so the
// popup doesn't keep asking for an area that can't be chosen.
import { api } from './api.ts';
import { CHOOSE_MS, type Area, type AreaMessage, type ViewSize } from './shot.ts';
/** A drag smaller than this, either way, is a click, not an area. */
const SMALLEST = 4;
/** Keys that scroll the page, which would move it under the area. */
const SCROLL_KEYS = new Set([
  ' ',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'PageUp',
  'PageDown',
  'Home',
  'End',
]);

/**
 * The overlay shown, kept on this world's global: the background injects
 * this script again for each choice, and each run must find the overlay
 * an earlier one showed, to take it off. `look` checks that the page
 * hasn't taken it off or hidden it. `telling`: one that's gone from the
 * page, whose area is on its way to the background, until it's taken.
 */
type Shown = { stop: (() => void) | null; look: (() => void) | null; telling: boolean };
// Under a symbol, which no element's name or ID can stand in for, as a
// name can on the window.
const SHOWN = Symbol.for('wikistow.area');
const held = globalThis as unknown as { [SHOWN]?: Shown };
const shown: Shown = (held[SHOWN] ??= { stop: null, look: null, telling: false });

/** Styles that win over the page's, even its `!important` ones. */
function style(element: HTMLElement, rules: Record<string, string>) {
  for (const [property, value] of Object.entries(rules)) {
    element.style.setProperty(property, value, 'important');
  }
}

/** How long to wait for the page to be drawn again, at most: a hidden tab draws no frames. */
const DRAWN_MS = 1000;

/**
 * Animation frames to wait for the browser to show the page without the
 * overlay. The screenshot is of what the browser shows, which can be
 * frames behind what the page has drawn: in Chrome, the first frame's
 * callbacks run as the page draws the change (frame N), the second's once
 * N is handed to the compositor, but N can still be waiting to be drawn,
 * and the screenshot is of the last frame drawn. The compositor holds the
 * page back, taking a new frame only once it has drawn the one before, so
 * two frames more are a margin, not a proof. Two frames in all weren't
 * enough on a busy machine, where the screenshot kept the overlay's edge;
 * four held there.
 */
const FRAMES = 4;

/** The page shown without the overlay, after `FRAMES` frames. Not in a hidden tab, which isn't shown. */
const drawn = () =>
  new Promise<void>((resolve) => {
    if (document.hidden) return resolve();
    setTimeout(resolve, DRAWN_MS);
    let left = FRAMES;
    const frame = () => (--left > 0 ? requestAnimationFrame(frame) : resolve());
    requestAnimationFrame(frame);
  });

/** Elements whose focus is in another document, whose keys this one doesn't hear. */
const ELSEWHERE = 'iframe, frame, object, embed';

/** `showPopover`'s options, where it takes them: `source` nests it in that element's popover. */
type Show = (options?: { source?: HTMLElement | undefined }) => void;

/** Whether `showPopover` takes a `source`, as browsers that don't would show a popover that isn't nested. */
function takesSource() {
  let read = false;
  const probe = document.createElement('div');
  try {
    (probe.showPopover as Show).call(probe, {
      get source() {
        read = true;
        return undefined;
      },
    });
  } catch {
    // A popover off the page can't be shown; its options were read first.
  }
  return read;
}

/**
 * The page's own auto popover on top, a menu say, which a popover not
 * nested in it would close, as it opens or as the person presses on it:
 * the open one no other open one is nested in, by place or by the button
 * that opens it. Only those outside shadow roots are found.
 */
function topPopover(): HTMLElement | null {
  const open = [...document.querySelectorAll<HTMLElement>('[popover]:popover-open')].filter(
    (popover) => popover.popover === 'auto',
  );
  const opens = (button: Element) =>
    button.getAttribute('popovertarget') ?? button.getAttribute('commandfor');
  const within = (inner: HTMLElement, outer: HTMLElement) =>
    outer.contains(inner) ||
    (inner.id !== '' &&
      [...outer.querySelectorAll('[popovertarget], [commandfor]')].some(
        (button) => opens(button) === inner.id,
      ));
  return (
    open.findLast((outer) => !open.some((inner) => inner !== outer && within(inner, outer))) ?? null
  );
}

/**
 * Show the overlay, and wait for an area. `zoomed` when the page is pinch
 * zoomed, where what's shown isn't the tab's CSS pixels, so it can't be
 * cut to match. Otherwise the tab's size as it opened, which the
 * screenshot taken just before it was of.
 */
function choose(nonce: string): 'zoomed' | { view: ViewSize } {
  shown.stop?.();
  if (visualViewport && Math.abs(visualViewport.scale - 1) > 0.001) return 'zoomed';
  const opened: ViewSize = { width: innerWidth, height: innerHeight };

  // The page's own CSS zoom on its root, which the overlay would inherit,
  // undone: the pointer's place is in the tab's pixels, and so is the box.
  const zoom = Number.parseFloat(getComputedStyle(document.documentElement).zoom) || 1;
  /**
   * What holds the overlay in the top layer: a modal dialog, or a popover
   * that isn't a dialog, as showing a dialog, even as a popover, moves
   * focus to it. The popover is nested in the page's own on top, if
   * there's one, which closes neither as it opens nor when pressed on;
   * otherwise manual, which closes none of the page's.
   */
  function container(modal: boolean) {
    const element = document.createElement(modal ? 'dialog' : 'div');
    if (!modal) element.setAttribute('popover', source ? 'auto' : 'manual');
    element.tabIndex = -1;
    style(element, {
      all: 'initial',
      zoom: String(1 / zoom),
      display: 'block',
      position: 'fixed',
      inset: '0',
      width: '100vw',
      height: '100vh',
      'max-width': 'none',
      'max-height': 'none',
      margin: '0',
      padding: '0',
      border: '0',
      overflow: 'hidden',
      background: 'transparent',
      'z-index': '2147483647',
    });
    // A modal dialog's own Escape, should the key reach it first.
    element.addEventListener('cancel', (event) => {
      event.preventDefault();
      void finish(null);
    });
    element.addEventListener('toggle', look);
    element.addEventListener('close', look);
    return element;
  }
  let source: HTMLElement | null = null;
  try {
    source = takesSource() ? topPopover() : null;
  } catch {
    // No popovers here.
  }
  /** Whether the page has a modal dialog open, other than `mine`. */
  const pageModal = (mine?: HTMLElement) =>
    [...document.querySelectorAll('dialog:modal')].some((dialog) => dialog !== mine);
  let frame: HTMLElement = container(pageModal());
  const frameStyle = frame.getAttribute('style');

  const host = document.createElement('div');
  style(host, {
    all: 'initial',
    display: 'block',
    position: 'fixed',
    inset: '0',
    width: '100vw',
    height: '100vh',
    margin: '0',
    padding: '0',
    border: '0',
    background: 'transparent',
    'z-index': '2147483647',
    cursor: 'crosshair',
    'touch-action': 'none',
    'user-select': 'none',
  });
  const root = host.attachShadow({ mode: 'closed' });
  const shade = document.createElement('div');
  style(shade, { position: 'fixed', inset: '0', background: 'rgba(0, 0, 0, 0.35)' });
  const box = document.createElement('div');
  style(box, {
    display: 'none',
    position: 'fixed',
    'box-sizing': 'border-box',
    border: '1px solid #fff',
    outline: '1px solid rgba(0, 0, 0, 0.6)',
    'box-shadow': '0 0 0 100vmax rgba(0, 0, 0, 0.35)',
  });
  const hint = document.createElement('div');
  hint.textContent = 'Drag over the part to clip to WikiStow. Esc cancels.';
  style(hint, {
    position: 'fixed',
    top: '12px',
    left: '50%',
    transform: 'translateX(-50%)',
    padding: '6px 12px',
    'border-radius': '6px',
    background: 'rgba(20, 20, 20, 0.85)',
    color: '#fff',
    font: '13px/1.4 system-ui, sans-serif',
    'pointer-events': 'none',
    'white-space': 'nowrap',
  });
  root.append(shade, box, hint);

  let start: { x: number; y: number } | null = null;
  let area: Area | null = null;
  const timer = setTimeout(() => void finish(null), CHOOSE_MS);

  const clampX = (x: number) => Math.min(Math.max(x, 0), innerWidth);
  const clampY = (y: number) => Math.min(Math.max(y, 0), innerHeight);
  function drag(event: PointerEvent) {
    const x = clampX(event.clientX);
    const y = clampY(event.clientY);
    area = {
      x: Math.min(start!.x, x),
      y: Math.min(start!.y, y),
      width: Math.abs(x - start!.x),
      height: Math.abs(y - start!.y),
    };
    shade.style.setProperty('display', 'none', 'important');
    style(box, {
      display: 'block',
      left: `${area.x}px`,
      top: `${area.y}px`,
      width: `${area.width}px`,
      height: `${area.height}px`,
    });
  }
  function down(event: PointerEvent) {
    if (!event.isTrusted) return;
    // Any button: the middle one would start the browser's autoscroll.
    event.preventDefault();
    if (event.button !== 0) return;
    start = { x: clampX(event.clientX), y: clampY(event.clientY) };
    host.setPointerCapture(event.pointerId);
    drag(event);
  }
  function move(event: PointerEvent) {
    if (!event.isTrusted || !start) return;
    drag(event);
  }
  function up(event: PointerEvent) {
    if (!event.isTrusted || !start) return;
    drag(event);
    start = null;
    if (area && area.width >= SMALLEST && area.height >= SMALLEST) return void finish(area);
    // A click: start again.
    area = null;
    style(box, { display: 'none' });
    style(shade, { display: 'block' });
  }
  function key(event: KeyboardEvent) {
    if (!event.isTrusted) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      return void finish(null);
    }
    // Focus may still be in the page: keys that would type there, move
    // focus, scroll the page or set off its shortcuts do nothing while
    // choosing. The browser's own, with a modifier, are left alone.
    if (SCROLL_KEYS.has(event.key) || !(event.ctrlKey || event.metaKey || event.altKey)) {
      event.preventDefault();
      event.stopPropagation();
    }
  }
  const still = (event: Event) => event.preventDefault();

  host.addEventListener('pointerdown', down);
  host.addEventListener('pointermove', move);
  host.addEventListener('pointerup', up);
  host.addEventListener('wheel', still, { passive: false });
  host.addEventListener('contextmenu', still);
  host.addEventListener('mousedown', still);
  host.addEventListener('auxclick', still);
  addEventListener('keydown', key, true);
  frame.append(host);
  const hostStyle = host.getAttribute('style');

  /** How it's in the top layer, if it is. */
  let layer: 'modal' | 'popover' | null = null;
  /**
   * Into the top layer, above everything there: modal while the page has
   * a modal dialog open, a popover otherwise. Shown afresh each time, as
   * the top layer's newest is on top; a popover the page's modal would
   * make inert moves to a dialog of its own.
   */
  function raise() {
    if (pageModal(frame) && !(frame instanceof HTMLDialogElement)) {
      const dialog = container(true);
      dialog.append(host);
      frame.replaceWith(dialog);
      frame = dialog;
      observe();
    }
    try {
      if (frame instanceof HTMLDialogElement) {
        if (frame.open) frame.close();
        frame.showModal();
        layer = 'modal';
      } else {
        if (frame.matches(':popover-open')) frame.hidePopover();
        (frame.showPopover as Show).call(frame, source ? { source } : undefined);
        layer = 'popover';
      }
    } catch {
      // Where it can't be in the top layer, its z-index alone.
      layer = null;
    }
  }
  /** Whether it's still on the page as it was put there, shown, and taking input. */
  function working() {
    if (frame.parentNode !== document.documentElement || host.parentNode !== frame) return false;
    if (frame.getAttribute('style') !== frameStyle || host.getAttribute('style') !== hostStyle) {
      return false;
    }
    if (host.closest('[inert]')) return false;
    if (layer === 'modal' && !frame.matches(':modal')) return false;
    if (layer === 'popover' && !frame.matches(':popover-open')) return false;
    return frame.checkVisibility?.() ?? true;
  }
  function look() {
    if (shown.stop === remove && !working()) void finish(null, true);
  }
  // A modal dialog the page opens meanwhile, over this one, which would
  // make it inert: this one goes over it in turn. Made before `watch`, so
  // it's told first, as the page's modal hides a nested popover.
  const modals = new MutationObserver((records) => {
    if (shown.stop !== remove) return;
    const opened = records.some(
      (record) => record.target !== frame && (record.target as Element).matches(':modal'),
    );
    if (opened) raise();
  });
  // Taken off, with the page's root or by itself; restyled, hidden or
  // made inert; closed or hidden from the top layer (its events too).
  const watch = new MutationObserver(look);
  function observe() {
    watch.disconnect();
    watch.observe(document, { childList: true });
    watch.observe(document.documentElement, { childList: true, attributes: true });
    watch.observe(frame, { childList: true, attributes: true, subtree: true });
  }

  function remove() {
    clearTimeout(timer);
    removeEventListener('keydown', key, true);
    watch.disconnect();
    modals.disconnect();
    if (shown.look === look) shown.look = null;
    if (shown.stop === remove) shown.stop = null;
    frame.remove();
  }
  async function finish(chosen: Area | null, blocked = false) {
    if (shown.stop !== remove) return;
    const view = { width: innerWidth, height: innerHeight };
    shown.telling = true;
    try {
      remove();
      await drawn();
      const message: AreaMessage = {
        type: 'wikistow-area',
        nonce,
        area: chosen,
        view,
        ...(blocked ? { blocked } : {}),
      };
      await api.runtime.sendMessage(message).catch(() => {});
    } finally {
      shown.telling = false;
    }
  }
  shown.stop = remove;
  shown.look = look;

  document.documentElement.append(frame);
  raise();
  // Keys pressed in a frame of another document don't reach this one:
  // Escape has to, so focus comes here from one.
  if (layer !== 'modal' && document.activeElement?.matches(ELSEWHERE)) {
    frame.focus({ preventScroll: true });
  }
  observe();
  modals.observe(document, { subtree: true, attributes: true, attributeFilter: ['open'] });
  return { view: opened };
}

/** Take the overlay off, once the page is drawn again without it, so a screenshot after doesn't show it. */
async function stopChoosing() {
  if (!shown.stop) return;
  shown.stop();
  await drawn();
}

declare global {
  var wikistowArea: typeof choose | undefined;
  var wikistowAreaStop: typeof stopChoosing | undefined;
  var wikistowAreaShown: (() => boolean) | undefined;
}

// Reached through a second injection (background.ts), in this extension's
// own world: the page's scripts can't see them.
globalThis.wikistowArea = choose;
globalThis.wikistowAreaStop = stopChoosing;
// An overlay the page hid goes now, and says so.
globalThis.wikistowAreaShown = () => {
  shown.look?.();
  return shown.stop !== null || shown.telling;
};
