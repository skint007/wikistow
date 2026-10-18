import { changeVaultPassphrase, openVault, type UnlockedVault } from '@wikistow/client';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { Field } from '@/components/form/field';
import { submitData } from '@/components/form/submit';
import { AuthCard, FormMessage } from '@/components/layout/auth-card';
import { Button } from '@/components/ui/button';
import { api } from '../../../api';
import { useReauth } from '../../../auth/reauth';
import { desktop } from '../../../desktop';
import { vaultMessage } from '../../../vault/messages';
import { startSession } from '../../../vault/open';
import { vaultStore } from '../../../vault/store';
import { forgetInBrowser } from '../../../vault/tab-unlock';
import { workerVaultCrypto } from '../../../vault/worker-crypto';
import { PassphraseFields, readPassphrase } from './setup';

export const Route = createFileRoute('/_app/vault/recover')({
  // Leaving before a new passphrase is saved drops the keys the recovery key opened.
  onLeave: () => vaultStore.dropStaged(),
  component: Recover,
});

/** Open the vault with the recovery key, then choose a new passphrase before going on. */
function Recover() {
  const [vault, setVault] = useState<UnlockedVault | null>(null);
  return vault ? <NewPassphrase vault={vault} /> : <RecoveryKey onOpened={setVault} />;
}

function RecoveryKey({ onOpened }: { onOpened: (vault: UnlockedVault) => void }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(form: FormData) {
    const recoveryKey = form.get('recovery-key');
    if (typeof recoveryKey !== 'string' || !recoveryKey.trim()) return;
    setBusy(true);
    setError(null);
    try {
      onOpened(
        vaultStore.stage(
          await openVault({
            api,
            crypto: workerVaultCrypto,
            secret: { kind: 'recovery-key', recoveryKey: recoveryKey.trim() },
          }),
        ),
      );
    } catch (caught) {
      setError(vaultMessage(caught));
    } finally {
      setBusy(false);
    }
  }
  return (
    <AuthCard
      title="Recover your vault"
      description="Enter the recovery key you saved when you set up the vault."
    >
      <form onSubmit={submitData(submit)} className="grid gap-4">
        <Field
          id="recovery-key"
          name="recovery-key"
          label="Recovery key"
          autoComplete="off"
          spellCheck={false}
          required
          autoFocus
        />
        {error && <FormMessage>{error}</FormMessage>}
        <Button type="submit" disabled={busy}>
          {busy ? 'Opening…' : 'Continue'}
        </Button>
      </form>
    </AuthCard>
  );
}

function NewPassphrase({ vault }: { vault: UnlockedVault }) {
  const navigate = useNavigate();
  const withReauth = useReauth();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(form: FormData) {
    setBusy(true);
    setError(null);
    try {
      const passphrase = await readPassphrase(form);
      if ('error' in passphrase) return setError(passphrase.error);
      await withReauth(() =>
        changeVaultPassphrase({
          api,
          crypto: workerVaultCrypto,
          vault,
          passphrase: passphrase.value,
        }),
      );
      // A browser remembering the unlock asks for the new passphrase next visit.
      if (!desktop) await forgetInBrowser();
      vaultStore.unlock(await startSession(vault), vault);
      await navigate({ to: '/' });
    } catch (caught) {
      setError(vaultMessage(caught));
    } finally {
      setBusy(false);
    }
  }
  return (
    <AuthCard
      title="Choose a new passphrase"
      description="Not your account password: it’s asked for to make sure the two differ. Your recovery key still works too."
    >
      <form onSubmit={submitData(submit)} className="grid gap-4">
        <PassphraseFields />
        {error && <FormMessage>{error}</FormMessage>}
        <Button type="submit" disabled={busy}>
          {busy ? 'Saving…' : 'Save passphrase'}
        </Button>
      </form>
    </AuthCard>
  );
}
