import { useQuery } from '@tanstack/react-query';
import { useRouter, type ErrorComponentProps } from '@tanstack/react-router';
import { useState } from 'react';
import { AuthCard } from '@/components/layout/auth-card';
import { Button } from '@/components/ui/button';
import { serverTrouble, type ServerTrouble } from '../api';
import { desktop, desktopServerQuery } from '../desktop';
import { errorMessage } from '../errors';
import { useSignOut } from './rail';
import { connection } from '../data/connection';

const TITLES: Record<ServerTrouble, string> = {
  unreachable: 'Can’t reach the server',
  'not-wikistow': 'The server didn’t answer as WikiStow',
  failing: 'The server is having trouble',
};

const describe = (trouble: ServerTrouble, server: string) =>
  ({
    unreachable: `${server} isn’t answering. Check your connection, then try again.`,
    'not-wikistow': `${server} answered, but not as a WikiStow server. Its address may have changed.`,
    failing: `${server} ran into a problem. It may be back in a moment.`,
  })[trouble];

/** The server this app talks to, as shown: the desktop app's choice, or this page's own. */
function useServerName(): string {
  const { data } = useQuery(desktopServerQuery);
  return desktop ? (data ?? 'The server') : window.location.origin;
}

/**
 * What `/_app` shows when it, or a page under it, couldn't load: most often
 * because the session check (`meQuery`) got no answer, or not WikiStow's
 * (#257). Try again runs the checks again. When the server is the trouble,
 * the desktop app can also sign out on this computer, to sign in to another.
 */
export function SessionError({ error }: ErrorComponentProps) {
  const router = useRouter();
  const server = useServerName();
  const trouble = serverTrouble(error);
  const { signOutHere } = useSignOut();
  const [trying, setTrying] = useState(false);
  return (
    <AuthCard
      title={trouble ? TITLES[trouble] : 'Something went wrong'}
      description={trouble ? describe(trouble, server) : errorMessage(error)}
    >
      <div className="grid gap-4">
        <Button
          type="button"
          disabled={trying}
          onClick={() => {
            setTrying(true);
            // Runs the routes' checks again, and clears this screen when they pass:
            // offline, once the server answers again (ADR 0009, decision 4).
            void connection
              .check()
              .then(() => router.invalidate())
              .finally(() => setTrying(false));
          }}
        >
          Try again
        </Button>
        {/* Only for the server's trouble: anything else isn't a reason to leave it. */}
        {trouble && signOutHere && <SignOutHere signOutHere={signOutHere} />}
      </div>
    </AuthCard>
  );
}

/**
 * The desktop app's way out when its server is gone: **Sign out on this
 * computer** (`useSignOut`), and what it leaves behind. A browser has none:
 * only the server can end its session cookie.
 */
export function SignOutHere({ signOutHere }: { signOutHere: () => Promise<void> }) {
  const [leaving, setLeaving] = useState(false);
  return (
    <div className="grid gap-2">
      <Button
        type="button"
        variant="outline"
        disabled={leaving}
        onClick={() => {
          setLeaving(true);
          void signOutHere().finally(() => setLeaving(false));
        }}
      >
        Sign out on this computer
      </Button>
      <p className="text-xs text-muted-foreground">
        Forgets your session, remembered unlock and this server here, so you can sign in to another.
        Your pages stay on the server, and so does the session until it expires, or you sign it out
        in a browser under Settings → Desktop apps.
      </p>
    </div>
  );
}
