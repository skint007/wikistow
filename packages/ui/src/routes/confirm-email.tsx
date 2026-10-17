import { createFileRoute, Link } from '@tanstack/react-router';
import { useMutation } from '@tanstack/react-query';
import { accountRoutes } from '@wikistow/contracts';
import { ApiError } from '@wikistow/client/api';
import { z } from 'zod';
import { AuthCard, FormMessage } from '@/components/layout/auth-card';
import { Button } from '@/components/ui/button';
import { api } from '../api';
import { errorMessage } from '../errors';

export const Route = createFileRoute('/confirm-email')({
  // Query values arrive JSON-parsed, so an all-digit token would be a number.
  validateSearch: z.object({
    token: z.union([z.string(), z.number()]).transform(String).optional().catch(undefined),
  }),
  component: ConfirmEmail,
});

const home = (
  <Link to="/" className="text-sm font-bold text-primary">
    Go to WikiStow
  </Link>
);

/**
 * The link mailed to a new address (Settings → Email). Opening the page
 * changes nothing; the button does, so a mail scanner that follows the link
 * can't confirm it. It needs no session, so the link works in any browser,
 * also for someone who uses the desktop app.
 */
function ConfirmEmail() {
  const { token } = Route.useSearch();
  const confirm = useMutation({
    mutationFn: (token: string) => api.call(accountRoutes.confirmEmailChange, { body: { token } }),
  });
  const failed = confirm.error instanceof ApiError ? confirm.error.code : null;

  if (!token || failed === 'email-link-invalid')
    return (
      <AuthCard
        title="This link has expired"
        description="It was already used, or it’s too old. Ask for a new one in Settings."
      >
        {home}
      </AuthCard>
    );
  if (failed === 'email-taken')
    return (
      <AuthCard
        title="This address can’t be used"
        description="Another WikiStow account uses it, so nothing changed."
      >
        {home}
      </AuthCard>
    );
  if (confirm.data)
    return (
      <AuthCard title="Your email is changed">
        <div className="grid gap-4">
          <FormMessage tone="notice">
            Your account now uses <strong>{confirm.data.email}</strong>. Sign in with it from now
            on.
          </FormMessage>
          {home}
        </div>
      </AuthCard>
    );
  return (
    <AuthCard
      title="Confirm your new email"
      description="Your WikiStow account will sign in with this address and get its mail here."
    >
      <div className="grid gap-4">
        {confirm.error && <FormMessage>{errorMessage(confirm.error)}</FormMessage>}
        <Button disabled={confirm.isPending} onClick={() => confirm.mutate(token)}>
          Confirm email
        </Button>
      </div>
    </AuthCard>
  );
}
