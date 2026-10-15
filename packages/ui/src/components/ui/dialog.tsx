import { XIcon } from 'lucide-react';
import * as React from 'react';
import { cn } from '@/lib/utils';
import { PortalContainer } from './portal-container';

/*
 * Dialogs on the native <dialog> element. Radix's Dialog locks scrolling by
 * injecting a <style> element, which the strict CSP forbids; showModal()
 * gives the same focus trapping, Escape handling, and inert background
 * without it. The API matches the shadcn components it replaces.
 */

type DialogState = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  titleId: string;
  descriptionId: string;
};
const DialogContext = React.createContext<DialogState | null>(null);

function useDialog(): DialogState {
  const state = React.use(DialogContext);
  if (!state) throw new Error('Dialog parts must be inside <Dialog>');
  return state;
}

function Dialog({
  open,
  onOpenChange,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: React.ReactNode;
}) {
  const titleId = React.useId();
  const descriptionId = React.useId();
  return (
    <DialogContext value={{ open, onOpenChange, titleId, descriptionId }}>{children}</DialogContext>
  );
}

/** The modal itself. `side` makes it a sheet along that edge instead of a centered box. */
function DialogContent({
  className,
  children,
  side,
  showCloseButton = true,
  dialogClassName,
  labelledBy,
  describedBy,
  locked = false,
}: {
  className?: string;
  /** Classes for the dialog box itself, such as its width; `className` styles its padded body. */
  dialogClassName?: string;
  children: React.ReactNode;
  side?: 'right' | 'left';
  showCloseButton?: boolean;
  /** What names and describes the dialog instead of its title and description, while it shows something else. */
  labelledBy?: string | undefined;
  describedBy?: string | undefined;
  /** While work in it runs: Escape, the backdrop and the close button don't close it. */
  locked?: boolean;
}) {
  const { open, onOpenChange, titleId, descriptionId } = useDialog();
  const [dialog, setDialog] = React.useState<HTMLDialogElement | null>(null);

  React.useEffect(() => {
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open, dialog]);

  return (
    <dialog
      ref={setDialog}
      data-slot="dialog-content"
      aria-labelledby={labelledBy ?? titleId}
      aria-describedby={describedBy ?? descriptionId}
      onCancel={(event) => {
        if (locked) event.preventDefault();
      }}
      // Escape and form[method=dialog] close it natively; keep React in step.
      // A browser may close it past a refused Escape, so a locked one reopens.
      // The event comes a task after close(), so it's stale if the dialog has
      // opened again since, as when New page follows Create folder at once.
      onClose={(event) => {
        if (event.currentTarget.open) return;
        if (locked && open) event.currentTarget.showModal();
        else onOpenChange(false);
      }}
      // A click on the backdrop lands on the <dialog> itself.
      onClick={(event) => {
        if (event.target === event.currentTarget && !locked) onOpenChange(false);
      }}
      className={cn(
        // Its body scrolls, not the box: a menu in it, positioned against the
        // box, would be cut off at its edge.
        'overflow-visible bg-card text-card-foreground border shadow-card backdrop:bg-black/50',
        side
          ? cn('m-0 h-dvh max-h-dvh w-full max-w-md', side === 'right' ? 'ml-auto' : 'mr-auto')
          : 'm-auto w-full max-w-[calc(100%-2rem)] rounded-card sm:max-w-lg',
        dialogClassName,
      )}
    >
      {/* Padding lives here, so only a click outside this box closes the dialog. */}
      {open && (
        <PortalContainer value={dialog}>
          <div
            className={cn(
              'h-full overflow-y-auto rounded-[inherit] p-6',
              !side && 'max-h-[calc(100dvh-2em-8px)]',
              className,
            )}
          >
            {children}
          </div>
        </PortalContainer>
      )}
      {open && showCloseButton && !locked && (
        <button
          type="button"
          onClick={() => onOpenChange(false)}
          className="absolute top-2.5 right-2.5 grid size-7 place-items-center rounded-control text-muted-foreground hover:tint hover:text-foreground active:tint-strong [&_svg]:size-4"
        >
          <XIcon />
          <span className="sr-only">Close</span>
        </button>
      )}
    </dialog>
  );
}

function DialogHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="dialog-header"
      className={cn('flex flex-col gap-2 text-center sm:text-left', className)}
      {...props}
    />
  );
}

function DialogFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn('flex flex-col-reverse gap-2 sm:flex-row sm:justify-end', className)}
      {...props}
    />
  );
}

function DialogTitle({ className, ...props }: React.ComponentProps<'h2'>) {
  const { titleId } = useDialog();
  return (
    <h2
      id={titleId}
      data-slot="dialog-title"
      // Clear of the close button: both sides on phones, where it's centred.
      className={cn('px-6 text-lg leading-none font-extrabold sm:pl-0', className)}
      {...props}
    />
  );
}

function DialogDescription({ className, ...props }: React.ComponentProps<'p'>) {
  const { descriptionId } = useDialog();
  return (
    <p
      id={descriptionId}
      data-slot="dialog-description"
      className={cn('text-sm text-muted-foreground', className)}
      {...props}
    />
  );
}

export { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle };
