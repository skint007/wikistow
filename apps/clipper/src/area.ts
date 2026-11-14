// The overlay for a screenshot of an area (ADR 0017, step 6). The
// background injects it into the tab only when the person asks, through
// `activeTab` and `scripting`, then calls `choose` there with a nonce of
// its own. The person drags out a rectangle over the page; the overlay
// goes, the page is drawn again without it, and it tells the background
// the area in the tab's CSS pixels, by a message naming the nonce, which
// takes the screenshot and cuts it (shot.ts). It answers by message, not as
// the injection's result, as the person may take minutes, and Chrome's
// service worker or Firefox's background may sleep meanwhile; a message
// wakes them.
//
// It takes only the person's own input (`isTrusted`), so the page's
// scripts can't drag one out for them; its elements are in a closed
// shadow root, so they can't read or restyle them. It's a modal dialog of
// its own, in the top layer, so the page can't cover it, and a dialog the
// page has open, which makes the rest of the page inert, doesn't take its
// input: the newest modal is the one that isn't inert.
import { api } from './api.ts';
import type { Area, AreaMessage } from './shot.ts';

/** How long the overlay waits for an area, as the background does. */
const WAIT_MS = 5 * 60_000;
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
 * an earlier one showed, to take it off. `telling`: one that's gone from
 * the page, whose area is on its way to the background.
 */
type Shown = { stop: (() => void) | null; telling: boolean };
// Under a symbol, which no element's name or ID can stand in for, as a
// name can on the window.
const SHOWN = Symbol.for('wikistow.area');
const held = globalThis as unknown as { [SHOWN]?: Shown };
const shown: Shown = (held[SHOWN] ??= { stop: null, telling: false });

/** Styles that win over the page's, even its `!important` ones. */
function style(element: HTMLElement, rules: Record<string, string>) {
  for (const [property, value] of Object.entries(rules)) {
    element.style.setProperty(property, value, 'important');
  }
}

/** How long to wait for the page to be drawn again, at most: a hidden tab draws no frames. */
const DRAWN_MS = 500;

/** Two frames: the page is drawn without the overlay by then. Not in a hidden tab, which isn't shown. */
const drawn = () =>
  new Promise<void>((resolve) => {
    if (document.hidden) return resolve();
    setTimeout(resolve, DRAWN_MS);
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });

/**
 * Show the overlay, and wait for an area. `zoomed` when the page is pinch
 * zoomed, where what's shown isn't the tab's CSS pixels, so it can't be
 * cut to match.
 */
function choose(nonce: string): 'choosing' | 'zoomed' {
  shown.stop?.();
  if (visualViewport && Math.abs(visualViewport.scale - 1) > 0.001) return 'zoomed';

  const frame = document.createElement('dialog');
  // The page's own CSS zoom on its root, which the overlay would inherit,
  // undone: the pointer's place is in the tab's pixels, and so is the box.
  const zoom = Number.parseFloat(getComputedStyle(document.documentElement).zoom) || 1;
  style(frame, {
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
  const timer = setTimeout(() => void finish(null), WAIT_MS);

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
    if (SCROLL_KEYS.has(event.key)) event.preventDefault();
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
  // A modal dialog's own Escape, should the key reach it first.
  frame.addEventListener('cancel', (event) => {
    event.preventDefault();
    void finish(null);
  });
  frame.append(host);

  function remove() {
    clearTimeout(timer);
    removeEventListener('keydown', key, true);
    frame.remove();
    if (shown.stop === remove) shown.stop = null;
  }
  async function finish(chosen: Area | null) {
    if (shown.stop !== remove) return;
    const view = { width: innerWidth, height: innerHeight };
    shown.telling = true;
    try {
      remove();
      await drawn();
      const message: AreaMessage = { type: 'wikistow-area', nonce, area: chosen, view };
      await api.runtime.sendMessage(message).catch(() => {});
    } finally {
      shown.telling = false;
    }
  }
  shown.stop = remove;

  document.documentElement.append(frame);
  // The top layer, above the page's own dialogs and full-screen elements,
  // and modal, so a dialog the page has open doesn't take the person's input.
  try {
    frame.showModal();
  } catch {
    // Where it can't be modal, its z-index alone.
  }
  return 'choosing';
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
globalThis.wikistowAreaShown = () => shown.stop !== null || shown.telling;
