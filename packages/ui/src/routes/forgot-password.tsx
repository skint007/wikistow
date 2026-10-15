import { zodResolver } from '@hookform/resolvers/zod';
import { createFileRoute, Link } from '@tanstack/react-router';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { Field } from '@/components/form/field';
import { AuthCard, FormMessage } from '@/components/layout/auth-card';
import { Button } from '@/components/ui/button';
import { authClient } from '../auth/client';
import { errorMessage, unwrap } from '../errors';

export const Route = createFileRoute('/forgot-password')({ component: ForgotPassword });

function ForgotPassword() {
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const form = useForm({
    resolver: zodResolver(z.object({ email: z.string().trim().email('Enter your email address') })),
    defaultValues: { email: '' },
  });
  const { errors, isSubmitting } = form.formState;

  const submit = form.handleSubmit(async ({ email }) => {
    setError(null);
    try {
      unwrap(await authClient.requestPasswordReset({ email, redirectTo: '/reset-password' }));
      setSent(true);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  });

  return (
    <AuthCard
      title="Reset your password"
      description="Your vault passphrase is separate and stays the same."
    >
      {sent ? (
        <FormMessage tone="notice">
          If that address has an account, a reset link is on its way. It expires in 30 minutes.
        </FormMessage>
      ) : (
        <form onSubmit={submit} className="grid gap-4" noValidate>
          <Field
            id="email"
            label="Email"
            type="email"
            autoComplete="email"
            error={errors.email?.message}
            {...form.register('email')}
          />
          {error && <FormMessage>{error}</FormMessage>}
          <Button type="submit" disabled={isSubmitting}>
            Send reset link
          </Button>
          <Link to="/sign-in" className="text-sm quiet-link">
            Back to sign in
          </Link>
        </form>
      )}
    </AuthCard>
  );
}
