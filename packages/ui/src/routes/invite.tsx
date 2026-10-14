import { useQuery } from '@tanstack/react-query';
import { accountRoutes } from '@wikistow/contracts';
import { createFileRoute, Link } from '@tanstack/react-router';
import { useState } from 'react';
import { AccountForm } from '@/components/form/account-form';
import { AuthCard, FormMessage } from '@/components/layout/auth-card';
import { api } from '../api';

export const Route = createFileRoute('/invite')({ component: Invite });

const PROBLEMS = {
  expired: 'This invitation has expired. Ask for a new one.',
  used: 'This invitation has already been used. Sign in instead.',
  revoked: 'This invitation was withdrawn.',
  'not-found': 'This invitation link is not valid.',
} as const;

/**
 * The token arrives in the URL fragment, which browsers never send to the
 * server or in a Referer. It is read once and removed from the address bar.
 */
let captured: string | null | undefined;
function readToken(): string | null {
  // Kept after the first read, since React may call initializers twice.
  if (captured !== undefined) return captured;
  const token = new URLSearchParams(window.location.hash.slice(1)).get('token');
  if (token) window.history.replaceState(window.history.state, '', window.location.pathname);
  captured = accountRoutes.InvitationToken.safeParse(token).success ? token : null;
  return captured;
}

function Invite() {
  const [token] = useState(readToken);
  const { data, isError } = useQuery({
    queryKey: ['invitation', token],
    queryFn: () => (token ? api.call(accountRoutes.inspectInvitation, { body: { token } }) : null),
    staleTime: Infinity,
  });

  if (!token || isError || data?.status === 'not-found')
    return <Problem message={PROBLEMS['not-found']} />;
  if (!data) return <AuthCard title="Join WikiStow">{null}</AuthCard>;
  if (data.status !== 'valid') return <Problem message={PROBLEMS[data.status]} />;
  return (
    <AuthCard title="Join WikiStow" description="You’ve been invited. Create your account.">
      <AccountForm token={token} email={data.email} />
    </AuthCard>
  );
}

function Problem({ message }: { message: string }) {
  return (
    <AuthCard title="Can’t use this invitation">
      <div className="grid gap-4">
        <FormMessage>{message}</FormMessage>
        <Link to="/sign-in" className="text-sm font-bold text-primary">
          Go to sign in
        </Link>
      </div>
    </AuthCard>
  );
}
