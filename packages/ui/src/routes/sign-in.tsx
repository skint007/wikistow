import { zodResolver } from '@hookform/resolvers/zod';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { AuthCard, FormMessage } from '@/components/layout/auth-card';
import { Field } from '@/components/form/field';
import { Button } from '@/components/ui/button';
import { safeRedirect } from '@/lib/redirect';
import { installationQuery, meQuery } from '../api';
import { authClient } from '../auth/client';
import { desktop } from '../desktop';
import { errorMessage, unwrap } from '../errors';

// The router parses query values as JSON (`?verified=1` arrives as a number),
// and a malformed link should never break the page. Email confirmation comes
// back here with `verified`, plus Better Auth's `error` when the link failed.
const Search = z.object({
  verified: z.coerce.boolean().optional().catch(undefined),
  error: z.string().optional().catch(undefined),
  redirect: z.string().optional().catch(undefined),
});

export const Route = createFileRoute('/sign-in')({
  validateSearch: Search,
  component: SignIn,
});

const Credentials = z.object({
  email: z.string().trim().email('Enter your email address'),
  password: z.string().min(1, 'Enter your password'),
});

function SignIn() {
  const { verified, error, redirect } = Route.useSearch();
  const [step, setStep] = useState<'password' | 'code'>('password');
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  async function done() {
    await queryClient.invalidateQueries({ queryKey: meQuery.queryKey });
    await navigate({ to: safeRedirect(redirect) });
  }

  // Signing in with an unconfirmed address sends a fresh link.
  const confirmation = !verified ? undefined : error ? (
    <FormMessage>
      That confirmation link has expired or isn’t valid. Sign in and we’ll email you a new one.
    </FormMessage>
  ) : (
    'Your email is confirmed. Sign in to continue.'
  );

  if (desktop) return <DesktopSignIn onDone={done} />;
  return (
    <AuthCard
      title={step === 'password' ? 'Sign in' : 'Two-factor code'}
      description={step === 'code' ? 'Enter the code from your authenticator app.' : confirmation}
    >
      {step === 'password' ? (
        <PasswordStep onCode={() => setStep('code')} onDone={done} />
      ) : (
        <CodeStep onDone={done} onRestart={() => setStep('password')} />
      )}
    </AuthCard>
  );
}

function PasswordStep({ onCode, onDone }: { onCode: () => void; onDone: () => Promise<void> }) {
  const [error, setError] = useState<string | null>(null);
  const { data: installation } = useQuery(installationQuery);
  const form = useForm({
    resolver: zodResolver(Credentials),
    defaultValues: { email: '', password: '' },
  });
  const { errors, isSubmitting } = form.formState;

  const submit = form.handleSubmit(async (values) => {
    setError(null);
    try {
      const result = unwrap(await authClient.signIn.email(values));
      if ('twoFactorRedirect' in result && result.twoFactorRedirect) onCode();
      else await onDone();
    } catch (caught) {
      setError(errorMessage(caught));
    }
  });

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
      <Field
        id="password"
        label="Password"
        type="password"
        autoComplete="current-password"
        error={errors.password?.message}
        {...form.register('password')}
      />
      {error && <FormMessage>{error}</FormMessage>}
      <Button type="submit" disabled={isSubmitting}>
        Sign in
      </Button>
      <div className="flex justify-between text-sm">
        <Link to="/forgot-password" className="font-bold text-primary">
          Forgot password?
        </Link>
        {installation?.publicRegistration && (
          <Link to="/register" className="text-muted-foreground">
            Create an account
          </Link>
        )}
      </div>
    </form>
  );
}

function CodeStep({ onDone, onRestart }: { onDone: () => Promise<void>; onRestart: () => void }) {
  const [backup, setBackup] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const form = useForm({
    resolver: zodResolver(z.object({ code: z.string().trim().min(1, 'Enter the code') })),
    defaultValues: { code: '' },
  });
  const { errors, isSubmitting } = form.formState;

  const submit = form.handleSubmit(async ({ code }) => {
    setError(null);
    try {
      unwrap(
        backup
          ? await authClient.twoFactor.verifyBackupCode({ code })
          : await authClient.twoFactor.verifyTotp({ code }),
      );
      await onDone();
    } catch (caught) {
      setError(errorMessage(caught));
    }
  });

  return (
    <form onSubmit={submit} className="grid gap-4" noValidate>
      <Field
        id="code"
        label={backup ? 'Backup code' : 'Code'}
        inputMode={backup ? 'text' : 'numeric'}
        autoComplete="one-time-code"
        autoFocus
        error={errors.code?.message}
        {...form.register('code')}
      />
      {error && <FormMessage>{error}</FormMessage>}
      <Button type="submit" disabled={isSubmitting}>
        Verify
      </Button>
      <button
        type="button"
        className="text-sm text-muted-foreground"
        onClick={() => setBackup(!backup)}
      >
        {backup ? 'Use your authenticator app' : 'Use a backup code instead'}
      </button>
      {/* A sign-in ends after too many wrong codes, and its code step with it. */}
      <button type="button" className="text-sm text-muted-foreground" onClick={onRestart}>
        Start again
      </button>
    </form>
  );
}

const ServerAddress = z.object({ server: z.string().trim().min(1, 'Enter the server’s address') });

/**
 * The desktop app signs in through the system browser (`DesktopBridge`), so
 * passwords and codes are only ever typed into the server's own pages.
 */
function DesktopSignIn({ onDone }: { onDone: () => Promise<void> }) {
  const [error, setError] = useState<string | null>(null);
  // Which try is waiting on the browser; Cancel moves on, so a late answer
  // to an earlier try is ignored.
  const attempt = useRef(0);
  const [waiting, setWaiting] = useState(false);
  const { data: server } = useQuery({
    queryKey: ['desktop-server'],
    queryFn: () => desktop?.server() ?? null,
  });
  const form = useForm({
    resolver: zodResolver(ServerAddress),
    values: { server: server ?? '' },
  });
  const { errors } = form.formState;

  const submit = form.handleSubmit(async ({ server }) => {
    const mine = ++attempt.current;
    setError(null);
    setWaiting(true);
    const outcome = await desktop?.signIn(server).then(
      () => null,
      (caught: unknown) => (caught instanceof Error ? caught.message : errorMessage(caught)),
    );
    if (attempt.current !== mine) return;
    setWaiting(false);
    if (outcome) setError(outcome);
    else await onDone();
  });

  return (
    <AuthCard
      title="Sign in"
      description="WikiStow opens your browser to sign in, then brings you back here."
    >
      <form onSubmit={submit} noValidate className="grid gap-4">
        <Field
          id="server"
          label="Server"
          placeholder="https://wiki.example.com"
          autoComplete="url"
          disabled={waiting}
          error={errors.server?.message}
          {...form.register('server')}
        />
        {error && <FormMessage>{error}</FormMessage>}
        {waiting ? (
          <div className="grid gap-2">
            <FormMessage tone="notice">Finish signing in in your browser.</FormMessage>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                attempt.current += 1;
                setWaiting(false);
                void desktop?.cancelSignIn();
              }}
            >
              Cancel
            </Button>
          </div>
        ) : (
          <Button type="submit">Sign in with your browser</Button>
        )}
      </form>
    </AuthCard>
  );
}
