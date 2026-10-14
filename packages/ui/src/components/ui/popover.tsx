import * as React from 'react';
import { Popover as PopoverPrimitive } from 'radix-ui';
import { cn } from '@/lib/utils';
import { usePortalContainer } from './portal-container';

// Not modal: a modal popover locks scrolling with an injected <style>, which
// the CSP forbids.
function Popover(props: React.ComponentProps<typeof PopoverPrimitive.Root>) {
  return <PopoverPrimitive.Root data-slot="popover" {...props} />;
}

function PopoverTrigger(props: React.ComponentProps<typeof PopoverPrimitive.Trigger>) {
  return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />;
}

function PopoverAnchor(props: React.ComponentProps<typeof PopoverPrimitive.Anchor>) {
  return <PopoverPrimitive.Anchor data-slot="popover-anchor" {...props} />;
}

function PopoverContent({
  className,
  align = 'center',
  sideOffset = 4,
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Content>) {
  return (
    <PopoverPrimitive.Portal container={usePortalContainer()}>
      <PopoverPrimitive.Content
        data-slot="popover-content"
        align={align}
        sideOffset={sideOffset}
        className={cn(
          'z-50 max-h-(--radix-popover-content-available-height) w-72 origin-(--radix-popover-content-transform-origin) overflow-y-auto rounded-control border bg-popover p-3 text-popover-foreground shadow-md outline-hidden data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95',
          className,
        )}
        {...props}
      />
    </PopoverPrimitive.Portal>
  );
}

/**
 * For a popover opened from somewhere other than its trigger: set `opener`
 * as it opens and spread `content` on its content, so closing it puts
 * focus back there, as a trigger would, unless the person clicked elsewhere.
 */
function useReturnFocus() {
  const opener = React.useRef<HTMLElement | null>(null);
  const outside = React.useRef(false);
  return {
    opener,
    content: {
      onInteractOutside: (event: Event) => {
        if (!event.defaultPrevented) outside.current = true;
      },
      onCloseAutoFocus: (event: Event) => {
        const target = opener.current;
        opener.current = null;
        if (target && !outside.current) {
          event.preventDefault();
          target.focus();
        }
        outside.current = false;
      },
    },
  };
}

export { Popover, PopoverAnchor, PopoverContent, PopoverTrigger, useReturnFocus };
