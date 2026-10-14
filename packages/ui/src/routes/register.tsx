import { useQuery } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import { AccountForm } from '@/components/form/account-form';
import { AuthCard, FormMessage } from '@/components/layout/auth-card';
import { installationQuery } from '../api';

export const Route = createFileRoute('/register')({ component: Register });

function Register() {
  const { data } = useQuery(installationQuery);
  if (!data) return <AuthCard title="Create an account">{null}</AuthCard>;
  if (!data.publicRegistration)
    return (
      <AuthCard title="Registration is closed">
        <div className="grid gap-4">
          <FormMessage tone="notice">
            You need an invitation to join. Ask an administrator to send you one.
          </FormMessage>
          <Link to="/sign-in" className="text-sm font-bold text-primary">
            Back to sign in
          </Link>
        </div>
      </AuthCard>
    );
  return (
    <AuthCard title="Create an account">
      <AccountForm />
    </AuthCard>
  );
}
