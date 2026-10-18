import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Tooltip as TooltipPrimitive } from 'radix-ui';

/** How long the pointer rests on an element before its hint shows. */
const DELAY = 500;
/** How soon after one hint closes the next shows without the delay, as along a toolbar. */
const SKIP_DELAY = 300;

const SIDES = ['top', 'right', 'bottom', 'left'] as const;

type Shown = {
  /** Each hint its own tooltip, so one never shows in the last one's place. */
  id: number;
  hint: string;
  keys: string | undefined;
  side: (typeof SIDES)[number];
  /** Where the element is, in the viewport; hints close on scroll, so it stays true. */
  rect: DOMRect;
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
  const [open, setOpen] = useState(false);

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
        hint,
        keys: element.dataset['hintKeys'],
        side: SIDES.find((side) => side === element.dataset['hintSide']) ?? 'bottom',
        rect: element.getBoundingClientRect(),
        container: element.closest('dialog') ?? document.body,
      });
      setOpen(true);
    };
    // Hides the hint. The element's hint shows again only once the pointer has been elsewhere,
    // as with Radix's own tooltips after a press, a key or a scroll.
    const hide = () => {
      clearTimeout(timer);
      if (!showing) return;
      showing = false;
      closedAt = performance.now();
      setOpen(false);
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

  if (!shown) return null;
  const { rect } = shown;
  // The pointer goes through the hint, and its Radix wrapper, to what's under it.
  return createPortal(
    <div className="pointer-events-none contents">
      <TooltipPrimitive.Provider>
        {/* Opened and closed only by the listeners above, which cover what Radix would close it for. */}
        <TooltipPrimitive.Root key={shown.id} open={open}>
          {/* Radix places the hint against its trigger: a stand-in over the element. */}
          <TooltipPrimitive.Trigger asChild>
            <span
              aria-hidden
              className="pointer-events-none fixed"
              style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}
            />
          </TooltipPrimitive.Trigger>
          <TooltipPrimitive.Content
            data-slot="tooltip-content"
            side={shown.side}
            sideOffset={4}
            collisionPadding={8}
            className="z-50 max-w-80 origin-(--radix-tooltip-content-transform-origin) animate-in rounded-row border bg-popover px-2.5 py-1.5 text-xs text-balance text-popover-foreground shadow-md fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95"
          >
            {shown.hint}
            {shown.keys && <span className="ml-2 text-muted-foreground">{shown.keys}</span>}
          </TooltipPrimitive.Content>
        </TooltipPrimitive.Root>
      </TooltipPrimitive.Provider>
    </div>,
    shown.container,
  );
}
