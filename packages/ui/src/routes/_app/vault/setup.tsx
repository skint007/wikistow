import {
  AccountId,
  MIN_PASSPHRASE,
  prepareVault,
  registerVault,
  spaceOperations,
  type PreparedVault,
} from '@wikistow/client';
import { accountRoutes } from '@wikistow/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute, redirect, useNavigate } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { Field } from '@/components/form/field';
import { submitData } from '@/components/form/submit';
import { AuthCard, FormMessage } from '@/components/layout/auth-card';
import { Button } from '@/components/ui/button';
import { api, meQuery } from '../../../api';
import { vaultMessage } from '../../../vault/messages';
import { startSession } from '../../../vault/open';
import { confirmPassphrase } from '../../../vault/passphrase';
import { vaultStore } from '../../../vault/store';
import { workerVaultCrypto } from '../../../vault/worker-crypto';

export const Route = createFileRoute('/_app/vault/setup')({
  beforeLoad: async ({ context }) => {
    const me = await context.queryClient.ensureQueryData(meQuery);
    if (me?.identity) throw redirect({ to: '/vault/unlock' });
  },
  // Keys made here but never registered are of no use to anyone.
  onLeave: () => vaultStore.dropStaged(),
  component: Setup,
});

const fieldText = (form: FormData, name: string) => {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
};

/**
 * The passphrase, its repeat, and the account password, compared with it on
 * this device and checked with the server. Shared with recovery.
 */
export function PassphraseFields() {
  return (
    <>
      <Field
        id="passphrase"
        name="passphrase"
        label="Vault passphrase"
        type="password"
        autoComplete="new-password"
        minLength={MIN_PASSPHRASE}
        required
        autoFocus
      />
      <Field
        id="passphrase-repeat"
        name="passphrase-repeat"
        label="Repeat passphrase"
        type="password"
        autoComplete="new-password"
        required
      />
      <Field
        id="account-password"
        name="account-password"
        label="Account password"
        type="password"
        autoComplete="current-password"
        required
      />
    </>
  );
}

/** The passphrase chosen, once it's checked against the account password (see `confirmPassphrase`). */
export const readPassphrase = (form: FormData) =>
  confirmPassphrase(
    {
      passphrase: fieldText(form, 'passphrase'),
      repeat: fieldText(form, 'passphrase-repeat'),
      accountPassword: fieldText(form, 'account-password'),
    },
    // Without a code, a right password answers `code-required` when two-factor is on.
    (password) => api.call(accountRoutes.reauthenticate, { body: { password } }),
  );

/**
 * The vault is made on this device first and registered only once the
 * recovery key is confirmed. The prepared vault is kept until registration
 * succeeds, so a retry sends the same one and the key shown stays valid.
 */
function Setup() {
  const [prepared, setPrepared] = useState<PreparedVault | null>(null);
  return prepared ? (
    <SaveRecoveryKey prepared={prepared} />
  ) : (
    <ChoosePassphrase onPrepared={setPrepared} />
  );
}

function ChoosePassphrase({ onPrepared }: { onPrepared: (prepared: PreparedVault) => void }) {
  const { data: me } = useQuery(meQuery);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(form: FormData) {
    if (!me) return;
    setBusy(true);
    setError(null);
    try {
      const passphrase = await readPassphrase(form);
      if ('error' in passphrase) return setError(passphrase.error);
      const prepared = await prepareVault({
        crypto: workerVaultCrypto,
        accountId: AccountId.parse(me.account.id),
        passphrase: passphrase.value,
      });
      vaultStore.stage(prepared.vault);
      onPrepared(prepared);
    } catch (caught) {
      setError(vaultMessage(caught));
    } finally {
      setBusy(false);
    }
  }
  return (
    <AuthCard
      title="Set up your vault"
      description="Your pages are encrypted on this device. Choose a passphrase that is not your account password: the server never sees it, and nobody can reset it for you. Your account password is asked for to make sure the two differ."
    >
      <form onSubmit={submitData(submit)} className="grid gap-4">
        <PassphraseFields />
        {error && <FormMessage>{error}</FormMessage>}
        <Button type="submit" disabled={busy}>
          {busy ? 'Creating your keys…' : 'Create vault'}
        </Button>
      </form>
    </AuthCard>
  );
}

/** Two groups of the key, chosen at random, to type back as proof it was saved. */
function pickGroups(count: number): [number, number] {
  const first = Math.floor(Math.random() * count);
  const second = (first + 1 + Math.floor(Math.random() * (count - 1))) % count;
  return first < second ? [first, second] : [second, first];
}

function SaveRecoveryKey({ prepared }: { prepared: PreparedVault }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const groups = prepared.recoveryKey.split('-');
  const [asked] = useState(() => pickGroups(groups.length));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const shown = useMemo(() => groups.join(' '), [groups]);

  async function submit(form: FormData) {
    const typed = asked.map((index) => fieldText(form, `group-${index}`).trim().toLowerCase());
    if (typed.some((value, i) => value !== groups[asked[i] ?? -1])) {
      return setError('Those groups don’t match. Check the key you saved.');
    }
    setBusy(true);
    setError(null);
    try {
      await registerVault(api, prepared);
      const ctx = await startSession(prepared.vault);
      await spaceOperations.createSpace(ctx, { name: 'Personal', emoji: '🏠' });
      vaultStore.unlock(ctx, prepared.vault);
      await queryClient.invalidateQueries({ queryKey: meQuery.queryKey });
      await navigate({ to: '/' });
    } catch (caught) {
      setError(vaultMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthCard
      title="Save your recovery key"
      description="If you forget your passphrase, this key is the only way back in. Write it down or store it in a password manager. It won’t be shown again."
    >
      <form onSubmit={submitData(submit)} className="grid gap-4">
        <p
          data-testid="recovery-key"
          className="rounded-control bg-muted p-3 font-mono text-sm break-words"
        >
          {shown}
        </p>
        <p className="text-sm">To confirm you saved it, type two of its groups.</p>
        <div className="grid grid-cols-2 gap-3">
          {asked.map((index) => (
            <Field
              key={index}
              id={`group-${index}`}
              name={`group-${index}`}
              label={`Group ${index + 1}`}
              autoComplete="off"
              spellCheck={false}
              required
            />
          ))}
        </div>
        {error && <FormMessage>{error}</FormMessage>}
        <Button type="submit" disabled={busy}>
          I saved it
        </Button>
      </form>
    </AuthCard>
  );
}
