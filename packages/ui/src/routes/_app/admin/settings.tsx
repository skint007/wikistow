import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { adminRoutes } from '@wikistow/contracts';
import { createFileRoute } from '@tanstack/react-router';
import { useId, useState, type ReactNode } from 'react';
import type { z } from 'zod';
import { FormMessage } from '@/components/layout/auth-card';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Picker, type PickerOption } from '@/components/ui/picker';
import { Switch } from '@/components/ui/switch';
import { api } from '../../../api';
import { useReauth } from '../../../auth/reauth';
import { errorMessage } from '../../../errors';

export const Route = createFileRoute('/_app/admin/settings')({ component: AdminSettings });

const settingsQuery = queryOptions({
  queryKey: ['admin', 'settings'],
  queryFn: () => api.call(adminRoutes.getSettings),
});

const mailQuery = queryOptions({
  queryKey: ['admin', 'mail-settings'],
  queryFn: () => api.call(adminRoutes.getMailSettings),
});

function AdminSettings() {
  const { data } = useQuery(settingsQuery);
  const { data: mail } = useQuery(mailQuery);
  return (
    <div className="grid gap-3.5">
      <Registration open={data?.publicRegistration} />
      {mail && <MailSettings mail={mail} />}
    </div>
  );
}

function Registration({ open }: { open: boolean | undefined }) {
  const queryClient = useQueryClient();
  const withReauth = useReauth();
  const [error, setError] = useState<string | null>(null);
  const update = useMutation({
    mutationFn: (open: boolean) =>
      withReauth(() =>
        api.call(adminRoutes.updateSettings, { body: { publicRegistration: open } }),
      ),
    onMutate: () => setError(null),
    onError: (caught) => setError(errorMessage(caught)),
    onSettled: () => queryClient.invalidateQueries({ queryKey: settingsQuery.queryKey }),
  });

  return (
    <Card className="rounded-card shadow-card">
      <CardHeader>
        <CardTitle className="text-lg font-extrabold">Registration</CardTitle>
        <CardDescription>
          Closed by default: people join only with an invitation. Open it to let anyone with the
          address create an account.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        <div className="flex items-center gap-3">
          <Switch
            id="public-registration"
            checked={open ?? false}
            disabled={open === undefined || update.isPending}
            onCheckedChange={(open) => update.mutate(open)}
          />
          <Label htmlFor="public-registration">Anyone can create an account</Label>
        </div>
        {error && <FormMessage>{error}</FormMessage>}
      </CardContent>
    </Card>
  );
}

type Mail = z.output<typeof adminRoutes.AdminMailSettings>;
type Security = z.output<typeof adminRoutes.SmtpSecurity>;

const SECURITY: readonly PickerOption<Security>[] = [
  { value: 'starttls', label: 'STARTTLS' },
  { value: 'tls', label: 'TLS' },
  { value: 'none', label: 'None' },
];

const MAIL_FIELDS = adminRoutes.MailField.options.length;

/** A setting the server's environment makes, which this page can't change. */
function FromEnvironment({ label, variable }: { label: string; variable: string }) {
  return (
    <div className="grid gap-2">
      <span className="text-sm leading-none font-medium">{label}</span>
      <p className="text-sm text-muted-foreground">
        Set in the server’s environment (<code>{variable}</code>)
      </p>
    </div>
  );
}

/** A saved password stays unless it's replaced or removed. */
type Password = { kind: 'keep' } | { kind: 'remove' } | { kind: 'enter'; value: string };

/**
 * Outgoing mail. Fields the server's environment sets are read-only. The
 * password is write-only: a saved one shows as Saved. Save and Send test
 * email both use what the form holds now.
 */
function MailSettings({ mail }: { mail: Mail }) {
  const id = useId();
  const queryClient = useQueryClient();
  const withReauth = useReauth();
  const fixed = (field: Mail['environment'][number]) => mail.environment.includes(field);
  const [host, setHost] = useState(mail.host ?? '');
  const [port, setPort] = useState(String(mail.port ?? 587));
  const [security, setSecurity] = useState<Security>(mail.security ?? 'starttls');
  const [username, setUsername] = useState(mail.username ?? '');
  const [password, setPassword] = useState<Password>(
    mail.passwordSaved ? { kind: 'keep' } : { kind: 'enter', value: '' },
  );
  const [from, setFrom] = useState(mail.from ?? '');
  const [message, setMessage] = useState<{ tone: 'error' | 'notice'; text: ReactNode } | null>(
    null,
  );

  const portNumber = port.trim() === '' ? null : Number(port);
  const portInvalid =
    portNumber !== null &&
    !(Number.isInteger(portNumber) && portNumber >= 1 && portNumber <= 65535);

  /** The form's values; the server ignores fields the environment sets. */
  const form = () => ({
    host: host.trim() || null,
    port: portNumber,
    security,
    username: username.trim() || null,
    from: from.trim() || null,
    ...(password.kind === 'remove' && { password: null }),
    ...(password.kind === 'enter' && password.value !== '' && { password: password.value }),
  });

  const save = useMutation({
    mutationFn: () => withReauth(() => api.call(adminRoutes.updateMailSettings, { body: form() })),
    onMutate: () => setMessage(null),
    onSuccess: (saved) => {
      queryClient.setQueryData(mailQuery.queryKey, saved);
      setPassword(saved.passwordSaved ? { kind: 'keep' } : { kind: 'enter', value: '' });
      setMessage({ tone: 'notice', text: 'Saved.' });
    },
    onError: (caught) => setMessage({ tone: 'error', text: errorMessage(caught) }),
  });
  const test = useMutation({
    mutationFn: () => withReauth(() => api.call(adminRoutes.sendTestMail, { body: form() })),
    onMutate: () => setMessage(null),
    onSuccess: ({ sentTo }) =>
      setMessage({
        tone: 'notice',
        text: (
          <>
            Sent a test email to <strong>{sentTo}</strong>. Check that it arrived.
          </>
        ),
      }),
    onError: (caught) => setMessage({ tone: 'error', text: errorMessage(caught) }),
  });
  const busy = save.isPending || test.isPending;

  return (
    <Card className="rounded-card shadow-card">
      <CardHeader>
        <CardTitle className="text-lg font-extrabold">Mail</CardTitle>
        <CardDescription>
          {mail.ready
            ? 'WikiStow sends invitations, email confirmations and password resets with these settings.'
            : 'Mail isn’t set up, so WikiStow can’t send invitations, email confirmations or password resets. You can still share invitations with Copy link.'}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="grid max-w-md gap-4"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            if (!portInvalid) save.mutate();
          }}
        >
          {fixed('host') ? (
            // SMTP_URL sets the whole connection.
            <FromEnvironment label="Connection" variable="SMTP_URL" />
          ) : (
            <>
              <div className="grid grid-cols-[1fr_6rem] gap-3">
                <TextField
                  id={`${id}-host`}
                  label="SMTP server"
                  value={host}
                  onChange={setHost}
                  placeholder="smtp.example.com"
                  autoComplete="off"
                />
                <TextField
                  id={`${id}-port`}
                  label="Port"
                  value={port}
                  onChange={setPort}
                  inputMode="numeric"
                  error={portInvalid ? 'Use 1 to 65535' : undefined}
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor={`${id}-security`}>Security</Label>
                <Picker
                  id={`${id}-security`}
                  label="Security"
                  value={security}
                  options={SECURITY}
                  onChange={setSecurity}
                />
                <p className="text-sm text-muted-foreground">
                  STARTTLS usually uses port 587, TLS port 465.
                </p>
              </div>
              <TextField
                id={`${id}-username`}
                label="Username"
                value={username}
                onChange={setUsername}
                autoComplete="off"
              />
              <PasswordField
                id={`${id}-password`}
                saved={mail.passwordSaved}
                value={password}
                onChange={setPassword}
              />
            </>
          )}
          {fixed('from') ? (
            <FromEnvironment label="From" variable="SMTP_FROM" />
          ) : (
            <TextField
              id={`${id}-from`}
              label="From"
              value={from}
              onChange={setFrom}
              placeholder="WikiStow <wiki@example.com>"
              autoComplete="off"
            />
          )}
          {message && <FormMessage tone={message.tone}>{message.text}</FormMessage>}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={busy || mail.environment.length === MAIL_FIELDS}>
              Save
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={busy || portInvalid}
              onClick={() => test.mutate()}
            >
              Send test email
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function TextField({
  id,
  label,
  value,
  onChange,
  error,
  ...input
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  error?: string | undefined;
  placeholder?: string;
  autoComplete?: string;
  inputMode?: 'numeric';
}) {
  return (
    <div className="grid content-start gap-2">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : undefined}
        {...input}
      />
      {error && (
        <p id={`${id}-error`} className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

/** Write-only: a saved password shows as Saved, with Replace and Remove. */
function PasswordField({
  id,
  saved,
  value,
  onChange,
}: {
  id: string;
  saved: boolean;
  value: Password;
  onChange: (value: Password) => void;
}) {
  if (value.kind === 'enter') {
    return (
      <div className="grid gap-2">
        <Label htmlFor={id}>Password</Label>
        <div className="flex gap-2">
          <Input
            id={id}
            type="password"
            autoComplete="new-password"
            value={value.value}
            onChange={(event) => onChange({ kind: 'enter', value: event.target.value })}
          />
          {saved && (
            <Button type="button" variant="ghost" onClick={() => onChange({ kind: 'keep' })}>
              Cancel
            </Button>
          )}
        </div>
      </div>
    );
  }
  return (
    <div className="grid gap-2">
      <span className="text-sm leading-none font-medium">Password</span>
      <div className="flex items-center gap-2">
        <span className="text-sm text-muted-foreground">
          {value.kind === 'keep' ? 'Saved' : 'Removed when you save'}
        </span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => onChange({ kind: 'enter', value: '' })}
        >
          Replace
        </Button>
        {value.kind === 'keep' ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => onChange({ kind: 'remove' })}
          >
            Remove
          </Button>
        ) : (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => onChange({ kind: 'keep' })}
          >
            Keep
          </Button>
        )}
      </div>
    </div>
  );
}
