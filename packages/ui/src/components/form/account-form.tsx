import { zodResolver } from '@hookform/resolvers/zod';
import { accountRoutes } from '@wikistow/contracts';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { FormMessage } from '@/components/layout/auth-card';
import { Button } from '@/components/ui/button';
import { api } from '../../api';
import { errorMessage } from '../../errors';
import { Field } from './field';

const Address = z.string().trim().email('Enter your email address');

const Details = z
  .object({
    name: accountRoutes.DisplayName,
    email: Address,
    password: z.string().min(12, 'Use at least 12 characters').max(256),
    confirm: z.string(),
  })
  .refine((v) => v.password === v.confirm, {
    path: ['confirm'],
    message: 'The passwords don’t match',
  });

/**
 * Create an account, with an invitation token or through open registration.
 * An invitation for one address takes the name and password here, and the
 * person then confirms the address. Otherwise only the address is asked for:
 * its owner chooses the name and password from the emailed link.
 */
export function AccountForm({ token, email }: { token?: string; email?: string | null }) {
  return email ? <DetailsForm token={token} email={email} /> : <AddressForm token={token} />;
}

function AddressForm({ token }: { token: string | undefined }) {
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const form = useForm({
    resolver: zodResolver(z.object({ email: Address })),
    defaultValues: { email: '' },
  });
  const { errors, isSubmitting } = form.formState;

  const submit = form.handleSubmit(async ({ email: address }) => {
    setError(null);
    try {
      await api.call(accountRoutes.createAccount, {
        body: { email: address, ...(token ? { token } : {}) },
      });
      setSentTo(address);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  });

  if (sentTo)
    return (
      <FormMessage tone="notice">
        Check your email. We sent a message to <strong className="text-foreground">{sentTo}</strong>
        . Use its link to choose your name and password.
      </FormMessage>
    );

  return (
    <form onSubmit={submit} className="grid gap-4" noValidate>
      <Field
        id="email"
        label="Email"
        type="email"
        autoComplete="email"
        error={errors.email?.message}
        {...form.register('email')}
      />
      <p className="text-sm text-muted-foreground">
        We’ll email you a link to choose your name and password.
      </p>
      {error && <FormMessage>{error}</FormMessage>}
      <Button type="submit" disabled={isSubmitting}>
        Continue
      </Button>
    </form>
  );
}

function DetailsForm({ token, email }: { token: string | undefined; email: string }) {
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const form = useForm({
    resolver: zodResolver(Details),
    defaultValues: { name: '', email, password: '', confirm: '' },
  });
  const { errors, isSubmitting } = form.formState;

  const submit = form.handleSubmit(async ({ name, email: address, password }) => {
    setError(null);
    try {
      await api.call(accountRoutes.createAccount, {
        body: { name, email: address, password, ...(token ? { token } : {}) },
      });
      setSentTo(address);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  });

  if (sentTo)
    return (
      <FormMessage tone="notice">
        Check your email. We sent a link to <strong className="text-foreground">{sentTo}</strong> to
        confirm the address. Then sign in.
      </FormMessage>
    );

  return (
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
        readOnly
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
        Create account
      </Button>
    </form>
  );
}
