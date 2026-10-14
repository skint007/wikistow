import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { desktopRoutes } from '@wikistow/contracts';
import { createFileRoute } from '@tanstack/react-router';
import { useId, useState, type ReactNode } from 'react';
import { useForm } from 'react-hook-form';
import QRCode from 'react-qr-code';
import { z } from 'zod';
import { Field } from '@/components/form/field';
import { FormMessage } from '@/components/layout/auth-card';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Picker } from '@/components/ui/picker';
import { AiSettings } from '../../ai/ai-settings';
import { api } from '../../api';
import { authClient } from '../../auth/client';
import { useReauth } from '../../auth/reauth';
import { errorMessage, unwrap } from '../../errors';
import { ThemePicker } from '../../theme/theme-picker';
import { desktop } from '../../desktop';
import { IDLE_DELAYS, idleLockDelay, useIdleLockDelay } from '../../vault/idle-lock';
import { PluginSettings } from '../../plugins/plugin-settings';
import { pluginName } from '../../plugins/regions';
import { usePlugins } from '../../plugins/runtime';
import { PluginView } from '../../plugins/views';
import type { SettingsViewProps } from '@wikistow/plugin-sdk';

export const Route = createFileRoute('/_app/settings')({ component: Settings });

function Settings() {
  return (
    <div
      data-region="settings"
      className="mx-auto grid h-full max-w-4xl content-start gap-3.5 overflow-y-auto"
    >
      <Section
        title="Appearance"
        description={
          desktop
            ? 'Palettes are synced to your account on every device. Plugin themes stay on this computer.'
            : 'Synced to your account on every device.'
        }
      >
        <ThemePicker />
      </Section>
      <Section
        title="Password"
        description="Changing it signs you out everywhere else. Your vault passphrase stays the same."
      >
        <ChangePassword />
      </Section>
      <Section
        title="Two-factor sign-in"
        description="Ask for a code from an authenticator app at every sign-in."
      >
        <TwoFactor />
      </Section>
      <Section
        title="Lock when idle"
        description={`Lock the vault after this long with nobody using WikiStow. Typing is saved first. Kept on this ${desktop ? 'computer' : 'browser'} only.`}
      >
        <IdleLock />
      </Section>
      {desktop && (
        <Section
          title="Plugins"
          description="Installed on this computer only. They never come from the server or from a page. If one breaks the app, Ctrl+Shift+Alt+P restarts it without plugins."
        >
          <PluginSettings />
        </Section>
      )}
      <PluginSections />
      <Section
        title="Desktop apps"
        description="Computers signed in with the WikiStow desktop app. Signing one out here ends its session there."
      >
        <DesktopApps />
      </Section>
      <Section title="AI assistant" description="The AI provider this server connects to.">
        <AiSettings />
      </Section>
    </div>
  );
}

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <Card className="rounded-card shadow-card">
      <CardHeader>
        <CardTitle className="text-lg font-extrabold">{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

const NO_PROPS: SettingsViewProps = {};

/** Plugins' own sections (`settings.section`), each as a card of its own. */
function PluginSections() {
  const { regions, plugins } = usePlugins();
  return regions['settings.section'].map(({ pluginId, id, title, view }) => {
    const name = pluginName(plugins, pluginId);
    return (
      <Section key={`${pluginId}:${id}`} title={title} description={`From ${name}.`}>
        <PluginView pluginId={pluginId} name={name} view={view} props={NO_PROPS} />
      </Section>
    );
  });
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
  const id = useId();
  return (
    <div className="grid max-w-60 gap-1.5">
      <Label htmlFor={id}>Lock after</Label>
      <Picker
        id={id}
        label="Lock after"
        value={minutes === null ? 'off' : String(minutes)}
        options={IDLE_OPTIONS}
        onChange={(value) => idleLockDelay.set(value === 'off' ? null : Number(value))}
      />
    </div>
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
  const { data: session, refetch } = authClient.useSession();
  const withReauth = useReauth();
  const [setup, setSetup] = useState<Setup | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const enabled = session?.user.twoFactorEnabled === true;

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
      <ConfirmSetup
        setup={setup}
        onDone={async () => {
          setCodes(setup.backupCodes);
          setSetup(null);
          password.reset();
          await refetch();
        }}
      />
    );

  return (
    <div className="grid max-w-sm gap-4">
      <p className="text-sm">
        Two-factor sign-in is <strong>{enabled ? 'on' : 'off'}</strong>.
      </p>
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

function DesktopApps() {
  const queryClient = useQueryClient();
  const { data, error } = useQuery(desktopSessionsQuery);
  const signOut = useMutation({
    mutationFn: (sessionId: string) =>
      api.call(desktopRoutes.revokeDesktopSession, { params: { sessionId } }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: desktopSessionsQuery.queryKey }),
  });

  if (error) return <FormMessage>{errorMessage(error)}</FormMessage>;
  if (!data) return null;
  if (data.sessions.length === 0) {
    return <p className="text-sm text-muted-foreground">No desktop app is signed in.</p>;
  }
  return (
    <div className="grid gap-3">
      <ul className="grid gap-2" data-testid="desktop-sessions">
        {data.sessions.map((session) => (
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
