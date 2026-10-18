import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { accountRoutes, desktopRoutes } from '@wikistow/contracts';
import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useForm } from 'react-hook-form';
import QRCode from 'react-qr-code';
import { z } from 'zod';
import { Field } from '@/components/form/field';
import { FormMessage } from '@/components/layout/auth-card';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Picker } from '@/components/ui/picker';
import { AvatarSettings } from '../../../account/avatar-settings';
import { AiSettings } from '../../../ai/ai-settings';
import { api, meQuery } from '../../../api';
import { authClient } from '../../../auth/client';
import { useReauth } from '../../../auth/reauth';
import { errorMessage, unwrap } from '../../../errors';
import { TableOfContents, type Heading } from '../../../page/table-of-contents';
import { PluginsSummary } from '../../../plugins/plugin-settings';
import { FormRow, OneOpen, SettingRow, SettingsGroup, THIS_DEVICE } from '../../../settings/rows';
import { ThemePicker } from '../../../theme/theme-picker';
import { IDLE_DELAYS, idleLockDelay, useIdleLockDelay } from '../../../vault/idle-lock';

export const Route = createFileRoute('/_app/settings/')({ component: Settings });

/** The groups, in order, for the side nav. Each is linkable as `/settings#<id>`. */
const GROUPS: Heading[] = [
  { id: 'account', text: 'Account', level: 2 },
  { id: 'security', text: 'Security', level: 2 },
  { id: 'appearance', text: 'Appearance', level: 2 },
  { id: 'plugins', text: 'Plugins', level: 2 },
  { id: 'ai', text: 'AI assistant', level: 2 },
];

/**
 * One page of grouped rows, each with its state and one action. Forms open
 * under their row on demand, one at a time. Beside the groups, from 900px,
 * "On this page" follows the scroll; narrower, it's a row of links above.
 */
function Settings() {
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  return (
    <div ref={setScroller} data-region="settings" className="h-full overflow-y-auto">
      <div className="mx-auto grid max-w-4xl content-start gap-x-6 gap-y-3.5 pb-10 min-[900px]:grid-cols-[minmax(0,1fr)_10rem]">
        <h1 className="px-1.5 pt-1 text-[32px] leading-tight font-extrabold min-[900px]:col-span-2">
          Settings
        </h1>
        <nav aria-label="On this page" className="flex flex-wrap gap-1 min-[900px]:hidden">
          {GROUPS.map(({ id, text }) => (
            <a
              key={id}
              href={`#${id}`}
              className="rounded-row px-3 py-1.5 text-sm font-bold text-subtle-foreground outline-offset-[-2px] hover:tint active:tint-strong"
            >
              {text}
            </a>
          ))}
        </nav>
        <OneOpen>
          <div className="grid content-start gap-6">
            <SettingsGroup id="account" title="Account" note="How people see you, and your email">
              <AvatarSettings />
              <ChangeEmail />
            </SettingsGroup>
            <SettingsGroup id="security" title="Security" note="How you sign in, and where">
              <ChangePassword />
              <TwoFactor />
              <IdleLock />
              <DesktopApps />
            </SettingsGroup>
            <SettingsGroup id="appearance" title="Appearance" note="Follows your account">
              <ThemePicker />
            </SettingsGroup>
            <SettingsGroup id="plugins" title="Plugins" note="What plugins add to WikiStow">
              <PluginsSummary />
            </SettingsGroup>
            <SettingsGroup id="ai" title="AI assistant" note="Set up by whoever runs the server">
              <AiSettings />
            </SettingsGroup>
          </div>
        </OneOpen>
        <TableOfContents
          headings={GROUPS}
          card={scroller}
          className="sticky top-0 hidden self-start min-[900px]:grid"
        />
      </div>
    </div>
  );
}

const IDLE_OPTIONS = [
  { value: 'off', label: 'Off' },
  ...IDLE_DELAYS.map((minutes) => ({
    value: String(minutes),
    label: minutes === 60 ? '1 hour' : `${minutes} minutes`,
  })),
];

function IdleLock() {
  const minutes = useIdleLockDelay();
  return (
    <SettingRow
      name="Lock when idle"
      scope={THIS_DEVICE}
      state="Locks the vault with nobody using WikiStow. Typing is saved first."
      action={
        <Picker
          label="Lock after"
          className="w-36"
          value={minutes === null ? 'off' : String(minutes)}
          options={IDLE_OPTIONS}
          onChange={(value) => idleLockDelay.set(value === 'off' ? null : Number(value))}
        />
      }
    />
  );
}

const NewEmail = z.object({ email: z.string().trim().email('Enter an email address') });

/**
 * The account's address, and asking to change it after confirming it's
 * you. Nothing changes until the link mailed to the new address is opened
 * (`/confirm-email`).
 */
function ChangeEmail() {
  const { data: me } = useQuery(meQuery);
  return (
    <FormRow id="email" name="Email" state={me?.account.email}>
      <EmailForm current={me?.account.email} />
    </FormRow>
  );
}

function EmailForm({ current }: { current: string | undefined }) {
  const withReauth = useReauth();
  const [message, setMessage] = useState<{ tone: 'error' | 'notice'; text: ReactNode } | null>(
    null,
  );
  const form = useForm({ resolver: zodResolver(NewEmail), defaultValues: { email: '' } });
  const { errors, isSubmitting } = form.formState;

  const submit = form.handleSubmit(async ({ email }) => {
    setMessage(null);
    if (email.toLowerCase() === current) {
      form.setError('email', { message: 'That’s already your email' });
      return;
    }
    try {
      await withReauth(() => api.call(accountRoutes.requestEmailChange, { body: { email } }));
      form.reset();
      setMessage({
        tone: 'notice',
        text: (
          <>
            We sent a link to <strong>{email}</strong>. Your email changes when you open it. Until
            then, keep using {current}.
          </>
        ),
      });
    } catch (caught) {
      setMessage({ tone: 'error', text: errorMessage(caught) });
    }
  });

  return (
    <form onSubmit={submit} className="grid max-w-sm gap-4" noValidate>
      <p className="text-sm text-muted-foreground">
        You sign in with it, and mail about your account goes there. A new address works once you
        open the link we send to it.
      </p>
      <Field
        id="new-email"
        label="New email"
        type="email"
        autoComplete="email"
        error={errors.email?.message}
        {...form.register('email')}
      />
      {message && <FormMessage tone={message.tone}>{message.text}</FormMessage>}
      <Button type="submit" disabled={isSubmitting} className="justify-self-start">
        Change email
      </Button>
    </form>
  );
}

const NewPassword = z
  .object({
    current: z.string().min(1, 'Enter your current password'),
    password: z.string().min(12, 'Use at least 12 characters').max(256),
    confirm: z.string(),
  })
  .refine((v) => v.password === v.confirm, {
    path: ['confirm'],
    message: 'The passwords don’t match',
  });

function ChangePassword() {
  return (
    <FormRow
      id="password"
      name="Password"
      state="Changing it signs you out everywhere else. Your vault passphrase stays the same."
    >
      <PasswordForm />
    </FormRow>
  );
}

function PasswordForm() {
  const [message, setMessage] = useState<{ tone: 'error' | 'notice'; text: string } | null>(null);
  const form = useForm({
    resolver: zodResolver(NewPassword),
    defaultValues: { current: '', password: '', confirm: '' },
  });
  const { errors, isSubmitting } = form.formState;

  const submit = form.handleSubmit(async ({ current, password }) => {
    setMessage(null);
    try {
      unwrap(
        await authClient.changePassword({
          currentPassword: current,
          newPassword: password,
          revokeOtherSessions: true,
        }),
      );
      form.reset();
      setMessage({ tone: 'notice', text: 'Password changed. Other devices are signed out.' });
    } catch (caught) {
      setMessage({ tone: 'error', text: errorMessage(caught) });
    }
  });

  return (
    <form onSubmit={submit} className="grid max-w-sm gap-4" noValidate>
      <Field
        id="current"
        label="Current password"
        type="password"
        autoComplete="current-password"
        error={errors.current?.message}
        {...form.register('current')}
      />
      <Field
        id="new-password"
        label="New password"
        type="password"
        autoComplete="new-password"
        error={errors.password?.message}
        {...form.register('password')}
      />
      <Field
        id="confirm-password"
        label="Repeat new password"
        type="password"
        autoComplete="new-password"
        error={errors.confirm?.message}
        {...form.register('confirm')}
      />
      {message && <FormMessage tone={message.tone}>{message.text}</FormMessage>}
      <Button type="submit" disabled={isSubmitting} className="justify-self-start">
        Change password
      </Button>
    </form>
  );
}

type Setup = { uri: string; backupCodes: string[] };

function TwoFactor() {
  const { data: session } = authClient.useSession();
  const enabled = session?.user.twoFactorEnabled === true;
  // Kept here, so a setup under way and new backup codes show again if the
  // flow is closed before they're finished or saved.
  const [setup, setSetup] = useState<Setup | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  return (
    <FormRow
      id="two-factor"
      name="Two-factor sign-in"
      state={enabled ? 'On: a code from an authenticator app at every sign-in' : 'Off'}
      label="Manage"
      close="Close"
    >
      <TwoFactorFlow setup={setup} setSetup={setSetup} codes={codes} setCodes={setCodes} />
    </FormRow>
  );
}

/** Set it up, new backup codes, or turn it off. */
function TwoFactorFlow({
  setup,
  setSetup,
  codes,
  setCodes,
}: {
  setup: Setup | null;
  setSetup: (setup: Setup | null) => void;
  codes: string[] | null;
  setCodes: (codes: string[] | null) => void;
}) {
  const { data: session, refetch } = authClient.useSession();
  const withReauth = useReauth();
  const [error, setError] = useState<string | null>(null);
  const enabled = session?.user.twoFactorEnabled === true;
  // Each step replaces the button that led to it: the focus goes to the
  // step's first field, so it stays in the row and Escape still closes it.
  const step = useRef<HTMLDivElement>(null);
  useEffect(() => {
    step.current?.querySelector('input')?.focus();
  }, [setup, enabled]);

  const run = (action: () => Promise<void>) => async () => {
    setError(null);
    try {
      await action();
    } catch (caught) {
      setError(errorMessage(caught));
    }
  };
  // Every two-factor change also asks for the password.
  const password = useForm({ defaultValues: { password: '' } });
  const passwordValue = () => password.getValues('password');

  const start = run(async () => {
    const result = await withReauth(async () =>
      unwrap(await authClient.twoFactor.enable({ password: passwordValue() })),
    );
    // Email codes aren't configured, so the server always answers with TOTP setup.
    if ('totpURI' in result) setSetup({ uri: result.totpURI, backupCodes: result.backupCodes });
  });
  const disable = run(async () => {
    await withReauth(async () =>
      unwrap(await authClient.twoFactor.disable({ password: passwordValue() })),
    );
    password.reset();
    await refetch();
  });
  const regenerate = run(async () => {
    const result = await withReauth(async () =>
      unwrap(await authClient.twoFactor.generateBackupCodes({ password: passwordValue() })),
    );
    setCodes(result.backupCodes);
  });

  if (setup)
    return (
      <div ref={step}>
        <ConfirmSetup
          setup={setup}
          onDone={async () => {
            setCodes(setup.backupCodes);
            setSetup(null);
            password.reset();
            await refetch();
          }}
        />
      </div>
    );

  return (
    <div ref={step} className="grid max-w-sm gap-4">
      {codes && <BackupCodes codes={codes} />}
      <Field
        id="2fa-password"
        label="Password"
        type="password"
        autoComplete="current-password"
        {...password.register('password')}
      />
      {error && <FormMessage>{error}</FormMessage>}
      <div className="flex flex-wrap gap-2">
        {enabled ? (
          <>
            <Button variant="outline" onClick={regenerate}>
              New backup codes
            </Button>
            <Button variant="destructive" onClick={disable}>
              Turn off
            </Button>
          </>
        ) : (
          <Button onClick={start}>Set up two-factor</Button>
        )}
      </div>
    </div>
  );
}

function ConfirmSetup({ setup, onDone }: { setup: Setup; onDone: () => Promise<void> }) {
  const withReauth = useReauth();
  const [error, setError] = useState<string | null>(null);
  const form = useForm({
    resolver: zodResolver(
      z.object({
        code: z
          .string()
          .trim()
          .regex(/^\d{6}$/, 'Enter the 6-digit code'),
      }),
    ),
    defaultValues: { code: '' },
  });
  const { errors, isSubmitting } = form.formState;
  const secret = new URL(setup.uri).searchParams.get('secret');

  const submit = form.handleSubmit(async ({ code }) => {
    setError(null);
    try {
      await withReauth(async () => unwrap(await authClient.twoFactor.verifyTotp({ code })));
      await onDone();
    } catch (caught) {
      setError(errorMessage(caught));
    }
  });

  return (
    <form onSubmit={submit} className="grid max-w-sm gap-4" noValidate>
      <p className="text-sm">
        Scan this with your authenticator app, then enter the code it shows.
      </p>
      <div className="w-48 rounded-control bg-white p-3">
        <QRCode value={setup.uri} size={168} title="Authenticator setup code" />
      </div>
      {secret && (
        <p className="text-sm text-muted-foreground">
          Or enter this key: <code className="font-mono text-foreground">{secret}</code>
        </p>
      )}
      <Field
        id="totp-code"
        label="Code"
        inputMode="numeric"
        autoComplete="one-time-code"
        error={errors.code?.message}
        {...form.register('code')}
      />
      {error && <FormMessage>{error}</FormMessage>}
      <Button type="submit" disabled={isSubmitting} className="justify-self-start">
        Turn on
      </Button>
    </form>
  );
}

function BackupCodes({ codes }: { codes: string[] }) {
  return (
    <div className="grid gap-2 rounded-control bg-muted p-3">
      <p className="text-sm font-bold">Backup codes</p>
      <p className="text-sm text-muted-foreground">
        Each works once if you lose your phone. Store them somewhere safe; they won’t be shown
        again.
      </p>
      <ul aria-label="Backup codes" className="grid grid-cols-2 gap-1 font-mono text-sm">
        {codes.map((code) => (
          <li key={code}>{code}</li>
        ))}
      </ul>
    </div>
  );
}

const desktopSessionsQuery = {
  queryKey: ['desktop-sessions'],
  queryFn: () => api.call(desktopRoutes.listDesktopSessions),
};

const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium' });

/** How many desktop apps are signed in, with Review opening the list to sign each out. */
function DesktopApps() {
  const { data, error } = useQuery(desktopSessionsQuery);
  const [reviewing, setReviewing] = useState(false);
  const sessions = data?.sessions;
  const count = sessions?.length ?? 0;
  return (
    <>
      <SettingRow
        name="Desktop apps"
        state={
          error ? (
            <span className="text-destructive">{errorMessage(error)}</span>
          ) : !sessions ? null : count === 0 ? (
            'None'
          ) : (
            `${count} signed in${sessions.some((session) => session.current) ? ', including this app' : ''}`
          )
        }
        action={
          count > 0 && (
            <Button size="sm" variant="outline" onClick={() => setReviewing(true)}>
              Review
            </Button>
          )
        }
      />
      <Dialog open={reviewing} onOpenChange={setReviewing}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Desktop apps</DialogTitle>
            <DialogDescription>
              Computers signed in with the WikiStow desktop app. Signing one out here ends its
              session there.
            </DialogDescription>
          </DialogHeader>
          {sessions && <DesktopSessions sessions={sessions} />}
        </DialogContent>
      </Dialog>
    </>
  );
}

function DesktopSessions({ sessions }: { sessions: desktopRoutes.DesktopSession[] }) {
  const queryClient = useQueryClient();
  const signOut = useMutation({
    mutationFn: (sessionId: string) =>
      api.call(desktopRoutes.revokeDesktopSession, { params: { sessionId } }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: desktopSessionsQuery.queryKey }),
  });
  if (sessions.length === 0)
    return <p className="text-sm text-muted-foreground">No desktop app is signed in.</p>;
  return (
    <div className="grid gap-3">
      <ul className="grid gap-2" data-testid="desktop-sessions">
        {sessions.map((session) => (
          <li key={session.id} className="flex items-center justify-between gap-3 text-sm">
            <span>
              Signed in {day(session.createdAt)}
              {session.current && <strong> (this app)</strong>}
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={signOut.isPending}
              onClick={() => signOut.mutate(session.id)}
            >
              Sign out
            </Button>
          </li>
        ))}
      </ul>
      {signOut.error && <FormMessage>{errorMessage(signOut.error)}</FormMessage>}
    </div>
  );
}
