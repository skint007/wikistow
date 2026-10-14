import { desktopRoutes } from '@wikistow/contracts';
import { useQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import { z } from 'zod';
import { AuthCard, FormMessage } from '@/components/layout/auth-card';
import { Button } from '@/components/ui/button';
import { api, meQuery } from '../../api';
import { useReauth } from '../../auth/reauth';
import { errorMessage } from '../../errors';

/**
 * Where the desktop app sends the system browser to sign in
 * (`desktopRoutes`). Approving hands a one-time code to the app through its
 * `wikistow://` link. The code is useless without the verifier the app kept,
 * so a link someone else sent can only sign in their own app, unless the
 * person is talked into passing the code back; the page says never to.
 * Approving needs a recent sign-in, so it asks for the password first.
 */
export const Route = createFileRoute('/_app/desktop-sign-in')({
  validateSearch: z.object({ challenge: desktopRoutes.Challenge.optional().catch(undefined) }),
  component: DesktopSignIn,
});

function DesktopSignIn() {
  const { challenge } = Route.useSearch();
  const { data: me } = useQuery(meQuery);
  const withReauth = useReauth();
  const [link, setLink] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!challenge) {
    return (
      <AuthCard title="Sign in to the desktop app">
        <FormMessage>
          This link is incomplete. Start signing in from the WikiStow desktop app again.
        </FormMessage>
      </AuthCard>
    );
  }

  async function approve(challenge: string) {
    setBusy(true);
    setError(null);
    try {
      const { code } = await withReauth(() =>
        api.call(desktopRoutes.approveHandoff, { body: { challenge } }),
      );
      const next = `${desktopRoutes.DESKTOP_LINK}?code=${code}`;
      setLink(next);
      window.location.assign(next);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  if (link) {
    return (
      <AuthCard
        title="Back to the desktop app"
        description="Your browser should have opened WikiStow. You can close this tab."
      >
        <div className="grid gap-2 text-sm">
          <a href={link} data-testid="desktop-link" className="text-primary underline">
            Open WikiStow
          </a>
          <p className="text-muted-foreground">
            Never share this link. It signs whoever started the sign-in into your account.
          </p>
        </div>
      </AuthCard>
    );
  }

  return (
    <AuthCard
      title="Sign in to the desktop app?"
      description="Continue only if you just started signing in from the WikiStow desktop app on this computer."
    >
      <div className="grid gap-4">
        {me && (
          <p className="text-sm">
            This signs the app in as <strong>{me.account.email}</strong>. If someone sent you here,
            stop: they would get into your account.
          </p>
        )}
        {error && <FormMessage>{error}</FormMessage>}
        <Button type="button" disabled={busy} onClick={() => void approve(challenge)}>
          {busy ? 'Signing in…' : 'Sign in to the desktop app'}
        </Button>
      </div>
    </AuthCard>
  );
}
