import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient } from '@tanstack/react-query';
import { accountRoutes } from '@wikistow/contracts';
import { createFileRoute, redirect, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { AccountDetails } from '@/components/form/account-form';
import { Field } from '@/components/form/field';
import { AuthCard, FormMessage } from '@/components/layout/auth-card';
import { Button } from '@/components/ui/button';
import { api, installationQuery, meQuery } from '../api';
import { authClient } from '../auth/client';
import { errorMessage, unwrap } from '../errors';

/** A new server's first account, its administrator. Gone once any account exists. */
export const Route = createFileRoute('/setup')({
  beforeLoad: async ({ context }) => {
    const { setup } = await context.queryClient.ensureQueryData(installationQuery);
    if (!setup) throw redirect({ to: '/sign-in' });
  },
  component: Setup,
});

function Setup() {
  const [error, setError] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const form = useForm({
    resolver: zodResolver(AccountDetails),
    defaultValues: { name: '', email: '', password: '', confirm: '' },
  });
  const { errors, isSubmitting } = form.formState;

  const submit = form.handleSubmit(async ({ name, email, password }) => {
    setError(null);
    try {
      await api.call(accountRoutes.createFirstAccount, { body: { name, email, password } });
      // The address counts as verified, so the account signs in at once.
      unwrap(await authClient.signIn.email({ email, password }));
      await queryClient.invalidateQueries({ queryKey: installationQuery.queryKey });
      await queryClient.invalidateQueries({ queryKey: meQuery.queryKey });
      await navigate({ to: '/' });
    } catch (caught) {
      setError(errorMessage(caught));
    }
  });

  return (
    <AuthCard
      title="Set up WikiStow"
      description="This server has no accounts yet. The account you create here is its administrator. You can invite everyone else once you’re in."
    >
      <form onSubmit={submit} className="grid gap-4" noValidate>
        <Field
          id="name"
          label="Your name"
          autoComplete="name"
          error={errors.name?.message}
          {...form.register('name')}
        />
        <Field
          id="email"
          label="Email"
          type="email"
          autoComplete="email"
          error={errors.email?.message}
          {...form.register('email')}
        />
        <Field
          id="password"
          label="Password"
          type="password"
          autoComplete="new-password"
          error={errors.password?.message}
          {...form.register('password')}
        />
        <Field
          id="confirm"
          label="Repeat password"
          type="password"
          autoComplete="new-password"
          error={errors.confirm?.message}
          {...form.register('confirm')}
        />
        {error && <FormMessage>{error}</FormMessage>}
        <Button type="submit" disabled={isSubmitting}>
          Create administrator
        </Button>
      </form>
    </AuthCard>
  );
}
