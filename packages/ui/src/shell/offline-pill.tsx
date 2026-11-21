import { CloudOff } from 'lucide-react';
import { useEffect, useSyncExternalStore } from 'react';
import { cn } from '@/lib/utils';
import { useConnection } from '../data/connection';

/** A time to say what's shown is as of: the time today, else the day and time. */
export function asOf(at: Date, now = new Date()): string {
  const time = at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  if (at.toDateString() === now.toDateString()) return time;
  return `${at.toLocaleDateString(undefined, { day: 'numeric', month: 'long' })}, ${time}`;
}

// How many app shells are up: the desktop's titlebar shows on every screen,
// sign-in and errors too, where nothing kept is shown and nothing is saved.
let shells = 0;
const shellListeners = new Set<() => void>();
const shellsChanged = () => {
  for (const listener of shellListeners) listener();
};

/** The app shell is up while the calling component is mounted. */
export function useShellShown() {
  useEffect(() => {
    shells++;
    shellsChanged();
    return () => {
      shells--;
      shellsChanged();
    };
  }, []);
}

/** The Offline pill, while an app shell is up (`useShellShown`): the titlebar's. */
export function ShellOfflinePill({ className }: { className: string }) {
  const shown = useSyncExternalStore(
    (listener) => {
      shellListeners.add(listener);
      return () => shellListeners.delete(listener);
    },
    () => shells > 0,
  );
  return shown && <OfflinePill className={className} />;
}

/**
 * **Offline** (ADR 0009, decision 4), in the desktop's titlebar, on phones
 * the top bar, and in a wide browser the rail (#693), while the server doesn't answer, with what that means as its hint:
 * what's shown is what this device kept, as of when the app last heard
 * from the server, and changes wait on the device until it answers.
 */
export function OfflinePill({ className }: { className?: string }) {
  const connection = useConnection();
  if (connection.online) return null;
  const hint = `Showing what this device kept${
    connection.heardAt ? `, as of ${asOf(connection.heardAt)}` : ''
  }. Changes are saved on this device and sent when you’re back online.`;
  return (
    <span
      role="status"
      tabIndex={0}
      data-hint={hint}
      aria-description={hint}
      className={cn(
        'flex items-center gap-1 rounded-full bg-muted px-2 py-[3px] text-[10px] font-bold text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring',
        className,
      )}
    >
      <CloudOff aria-hidden className="size-3" strokeWidth={2} />
      Offline
    </span>
  );
}
