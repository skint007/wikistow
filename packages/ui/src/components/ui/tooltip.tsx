import { flip, offset, shift, useFloating } from '@floating-ui/react-dom';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

/** How long the pointer rests on an element before its hint shows. */
const DELAY = 500;
/** How soon after one hint closes the next shows without the delay, as along a toolbar. */
const SKIP_DELAY = 300;

const SIDES = ['top', 'right', 'bottom', 'left'] as const;

type Shown = {
  /** Each hint its own box, last in its container, so it shows over popovers opened since. */
  id: number;
  element: HTMLElement;
  hint: string;
  keys: string | undefined;
  side: (typeof SIDES)[number];
  /** A modal <dialog> makes the rest of the page inert, so a hint in one renders in it. */
  container: HTMLElement;
};

/**
 * Where the event happened. Its path, not its target, which for an element
 * in a shadow root, as CodeMirror's are, is the root's host.
 */
const origin = (event: Event) => {
  const [first] = event.composedPath();
  return first instanceof Element ? first : null;
};

const hinted = (event: Event) => origin(event)?.closest<HTMLElement>('[data-hint]') ?? null;

/**
 * Hover and keyboard-focus hints, in the theme's popover colours, for every
 * element with a `data-hint` attribute: `<button data-hint="Bold">` in React,
 * `element.dataset.hint = …` in editor DOM. `data-hint-keys` adds a shortcut
 * beside it, and `data-hint-side` moves it from below the element (as along
 * the rail, where below would cover the next tile). One layer for the app,
 * so a hint costs an attribute, even on each of a grid's thousand buttons.
 * The hint isn't the element's name to screen readers: an icon-only control
 * needs an `aria-label` too.
 */
export function HintLayer() {
  const [shown, setShown] = useState<Shown | null>(null);

  useEffect(() => {
    let target: HTMLElement | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let closedAt = -Infinity;
    let showing = false;
    let shows = 0;

    const show = (element: HTMLElement) => {
      const hint = element.dataset['hint'];
      if (!hint || !element.isConnected) return;
      showing = true;
      setShown({
        id: ++shows,
        element,
        hint,
        keys: element.dataset['hintKeys'],
        side: SIDES.find((side) => side === element.dataset['hintSide']) ?? 'bottom',
        container: element.closest('dialog') ?? document.body,
      });
    };
    // Hides the hint. The element's hint shows again only once the pointer has been elsewhere,
    // as with Radix's tooltips after a press, a key or a scroll.
    const hide = () => {
      clearTimeout(timer);
      if (!showing) return;
      showing = false;
      closedAt = performance.now();
      setShown(null);
    };
    const close = () => {
      hide();
      target = null;
    };

    const over = (event: PointerEvent) => {
      // Touch has no hover; a tap would show a hint over what it opens.
      if (event.pointerType === 'touch') return;
      const element = hinted(event);
      if (element === target) return;
      hide();
      target = element;
      if (!element) return;
      const warm = performance.now() - closedAt < SKIP_DELAY;
      timer = setTimeout(() => show(element), warm ? 0 : DELAY);
    };
    const out = (event: PointerEvent) => {
      if (event.relatedTarget === null) close();
    };
    const focusIn = (event: FocusEvent) => {
      const element = hinted(event);
      if (!element || !origin(event)?.matches(':focus-visible')) return;
      hide();
      target = element;
      show(element);
    };
    const focusOut = (event: FocusEvent) => {
      if (target && hinted(event) === target) close();
    };
    const press = (event: PointerEvent) => {
      hide();
      target = hinted(event);
    };

    const stop = new AbortController();
    const options = { capture: true, passive: true, signal: stop.signal };
    document.addEventListener('pointerover', over, options);
    document.addEventListener('pointerout', out, options);
    document.addEventListener('pointerdown', press, options);
    document.addEventListener('focusin', focusIn, options);
    document.addEventListener('focusout', focusOut, options);
    document.addEventListener('keydown', hide, options);
    document.addEventListener('scroll', hide, options);
    // Not in capture, which would catch every element's blur too.
    window.addEventListener('blur', close, { signal: stop.signal });
    return () => {
      clearTimeout(timer);
      stop.abort();
    };
  }, []);

  return shown && <Hint key={shown.id} shown={shown} />;
}

/**
 * One hint, placed against its element by floating-ui, as Radix places its
 * own popups. Not a Radix tooltip, which would take the first Escape from
 * the popover or menu the element is in. The pointer goes through it.
 */
function Hint({ shown }: { shown: Shown }) {
  const { refs, floatingStyles, placement } = useFloating({
    elements: { reference: shown.element },
    placement: shown.side,
    strategy: 'fixed',
    // Placed by left and top, so the opening animation's transform doesn't move it.
    transform: false,
    middleware: [offset(4), flip(), shift({ padding: 8 })],
  });
  return createPortal(
    <div
      ref={refs.setFloating}
      data-slot="tooltip-content"
      data-side={placement}
      style={floatingStyles}
      className="pointer-events-none z-50 w-max max-w-80 animate-in rounded-row border bg-popover px-2.5 py-1.5 text-xs text-balance text-popover-foreground shadow-md fade-in-0 zoom-in-95"
    >
      {shown.hint}
      {shown.keys && <span className="ml-2 text-muted-foreground">{shown.keys}</span>}
    </div>,
    shown.container,
  );
}
