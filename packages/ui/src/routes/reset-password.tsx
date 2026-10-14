import { zodResolver } from '@hookform/resolvers/zod';
import { createFileRoute, Link } from '@tanstack/react-router';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { accountRoutes } from '@wikistow/contracts';
import { ApiError } from '@wikistow/client/api';
import { z } from 'zod';
import { Field } from '@/components/form/field';
import { AuthCard, FormMessage } from '@/components/layout/auth-card';
import { Button } from '@/components/ui/button';
import { api } from '../api';
import { authClient } from '../auth/client';
import { errorMessage, unwrap } from '../errors';

export const Route = createFileRoute('/reset-password')({
  // Query values arrive JSON-parsed, so an all-digit token would be a number.
  validateSearch: z.object({
    token: z.union([z.string(), z.number()]).transform(String).optional().catch(undefined),
    error: z.string().optional().catch(undefined),
    /** `setup=1`, on the link that finishes an account nobody has signed in to yet. */
    setup: z.literal(1).optional().catch(undefined),
  }),
  component: ResetPassword,
});

const Passwords = z.object({
  password: z.string().min(12, 'Use at least 12 characters').max(256),
  confirm: z.string(),
});
const matching = (v: z.infer<typeof Passwords>) => v.password === v.confirm;
const mismatch = { path: ['confirm'], message: 'The passwords don’t match' };
const Values = Passwords.refine(matching, mismatch);
const SetupValues = Passwords.extend({ name: accountRoutes.DisplayName }).refine(
  matching,
  mismatch,
);

function ResetPassword() {
  const { token, error: linkError, setup } = Route.useSearch();
  const [expired, setExpired] = useState(false);
  if (!token || linkError || expired)
    return (
      <AuthCard title="This link has expired">
        <Link to="/forgot-password" className="text-sm font-bold text-primary">
          Ask for a new link
        </Link>
      </AuthCard>
    );
  return setup === 1 ? (
    <FinishSetup token={token} onExpired={() => setExpired(true)} />
  ) : (
    <NewPassword token={token} />
  );
}

/** The first password, and the name, of an account nobody has signed in to yet. */
function FinishSetup({ token, onExpired }: { token: string; onExpired: () => void }) {
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const form = useForm({
    resolver: zodResolver(SetupValues),
    defaultValues: { name: '', password: '', confirm: '' },
  });
  const { errors, isSubmitting } = form.formState;

  const submit = form.handleSubmit(async ({ name, password }) => {
    setError(null);
    try {
      await api.call(accountRoutes.finishAccountSetup, { body: { token, name, password } });
      setDone(true);
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === 'setup-link-invalid') onExpired();
      else setError(errorMessage(caught));
    }
  });

  return (
    <AuthCard title="Finish setting up your account" description="Choose your name and password.">
      {done ? (
        <div className="grid gap-4">
          <FormMessage tone="notice">
            Your account is ready, and your email address is confirmed.
          </FormMessage>
          <Link to="/sign-in" className="text-sm font-bold text-primary">
            Sign in
          </Link>
        </div>
      ) : (
        <form onSubmit={submit} className="grid gap-4" noValidate>
          <Field
            id="name"
            label="Your name"
            autoComplete="name"
            error={errors.name?.message}
            {...form.register('name')}
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
            Finish setup
          </Button>
        </form>
      )}
    </AuthCard>
  );
}

function NewPassword({ token }: { token: string }) {
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const form = useForm({
    resolver: zodResolver(Values),
    defaultValues: { password: '', confirm: '' },
  });
  const { errors, isSubmitting } = form.formState;

  const submit = form.handleSubmit(async ({ password }) => {
    setError(null);
    try {
      unwrap(await authClient.resetPassword({ newPassword: password, token }));
      setDone(true);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  });

  return (
    <AuthCard title="Choose a new password" description="This signs you out on every device.">
      {done ? (
        <div className="grid gap-4">
          <FormMessage tone="notice">Your password is changed.</FormMessage>
          <Link to="/sign-in" className="text-sm font-bold text-primary">
            Sign in
          </Link>
        </div>
      ) : (
        <form onSubmit={submit} className="grid gap-4" noValidate>
          <Field
            id="password"
            label="New password"
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
            Change password
          </Button>
        </form>
      )}
    </AuthCard>
  );
}
