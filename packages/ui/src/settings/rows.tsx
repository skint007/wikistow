import {
  Children,
  createContext,
  use,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Button } from '@/components/ui/button';
import { desktop } from '../desktop';

/** The pill on a setting kept on this device only. Unmarked settings follow the account. */
export const THIS_DEVICE = desktop ? 'This computer' : 'This browser';

export function ScopePill({ children = THIS_DEVICE }: { children?: ReactNode }) {
  return (
    <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-bold whitespace-nowrap text-subtle-foreground">
      {children}
    </span>
  );
}

/**
 * One group of Settings: its heading, which other places link to as
 * `/settings#<id>`, a short note, and a card of rows.
 */
export function SettingsGroup({
  id,
  title,
  note,
  children,
}: {
  id: string;
  title: string;
  note: string;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby={id} className="grid gap-2">
      <div className="flex flex-wrap items-baseline gap-x-2.5 px-1.5">
        <h2 id={id} className="scroll-mt-4 text-lg font-extrabold max-[899px]:scroll-mt-16">
          {title}
        </h2>
        <p className="text-sm text-muted-foreground">{note}</p>
      </div>
      <div className="divide-y divide-border rounded-card bg-card shadow-card">{children}</div>
    </section>
  );
}

type RowProps = {
  name: ReactNode;
  /** The ScopePill's text, for a setting kept on this device only. */
  scope?: string;
  state?: ReactNode;
  /** Drawn before the name, such as the avatar. */
  icon?: ReactNode;
  action?: ReactNode;
  children?: ReactNode;
};

/**
 * One setting in a group: its name with any scope pill, its current state
 * in muted text, which describes the name's heading, and its action.
 * `children` go under it, such as a form that is open.
 */
export function SettingRow({ name, scope, state, icon, action, children }: RowProps) {
  const stateId = useId();
  return (
    <div>
      <div className="flex flex-wrap items-center gap-x-3.5 gap-y-2 px-4 py-3">
        {icon}
        <div className="min-w-48 flex-1">
          <h3
            aria-describedby={state ? stateId : undefined}
            className="flex flex-wrap items-center gap-2 font-bold"
          >
            {name}
            {scope && <ScopePill>{scope}</ScopePill>}
          </h3>
          {state && (
            <div id={stateId} className="text-[13px] text-muted-foreground">
              {state}
            </div>
          )}
        </div>
        {action && <div className="flex flex-wrap items-center gap-2">{action}</div>}
      </div>
      {/* Not for children that are all false, as a row's conditional notes can be. */}
      {Children.toArray(children).length > 0 && (
        <div className="grid gap-3 px-4 pb-4">{children}</div>
      )}
    </div>
  );
}

type Opened = { open: string | null; setOpen: (id: string | null) => void };

const OpenedContext = createContext<Opened>({ open: null, setOpen: () => {} });

/** Around the rows whose forms open in place, so only one is open at a time. */
export function OneOpen({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState<string | null>(null);
  const value = useMemo(() => ({ open, setOpen }), [open]);
  return <OpenedContext value={value}>{children}</OpenedContext>;
}

const FOCUSABLE = 'input, select, textarea, button, a[href], [tabindex]:not([tabindex="-1"])';

/**
 * A row whose form opens under it on demand, one at a time inside
 * `OneOpen`. `label` opens it and moves the focus into it; the same button,
 * now `close`, or Escape closes it and puts the focus back on the button.
 * The form is drawn only while open, so closing it starts it afresh.
 */
export function FormRow({
  id,
  name,
  label = 'Change',
  close = 'Cancel',
  children,
  ...row
}: {
  /** Unique on the page. */
  id: string;
  name: string;
  label?: string;
  close?: string;
  children: ReactNode;
} & Omit<RowProps, 'name' | 'action' | 'children'>) {
  const { open, setOpen } = use(OpenedContext);
  const shown = open === id;
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const panelId = useId();
  useEffect(() => {
    if (!shown || !panel.current) return;
    (panel.current.querySelector<HTMLElement>(FOCUSABLE) ?? panel.current).focus();
  }, [shown]);
  const hide = () => {
    setOpen(null);
    button.current?.focus();
  };
  return (
    <SettingRow
      {...row}
      name={name}
      action={
        <Button
          ref={button}
          // "Change email", read where the row's name isn't seen with it.
          aria-label={shown ? undefined : `${label} ${name.toLowerCase()}`}
          size="sm"
          variant={shown ? 'ghost' : 'outline'}
          aria-expanded={shown}
          aria-controls={shown ? panelId : undefined}
          onClick={() => (shown ? hide() : setOpen(id))}
        >
          {shown ? close : label}
        </Button>
      }
    >
      {shown && (
        <div
          ref={panel}
          id={panelId}
          tabIndex={-1}
          className="outline-none"
          onKeyDown={(event) => {
            // Not one a menu inside already took.
            if (event.key !== 'Escape' || event.defaultPrevented) return;
            event.preventDefault();
            hide();
          }}
        >
          {children}
        </div>
      )}
    </SettingRow>
  );
}
