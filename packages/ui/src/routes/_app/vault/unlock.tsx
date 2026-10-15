import { CryptoError } from '@wikistow/client';
import { useQuery } from '@tanstack/react-query';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { Field } from '@/components/form/field';
import { submitData } from '@/components/form/submit';
import { AuthCard, FormMessage } from '@/components/layout/auth-card';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { safeRedirect } from '@/lib/redirect';
import { meQuery } from '../../../api';
import { desktop } from '../../../desktop';
import { tabSafeMode } from '../../../plugins/safe-mode';
import { vaultMessage } from '../../../vault/messages';
import { unlockWith } from '../../../vault/open';
import { vaultStore } from '../../../vault/store';

export const Route = createFileRoute('/_app/vault/unlock')({
  validateSearch: z.object({ redirect: z.string().optional().catch(undefined) }),
  onLeave: () => vaultStore.dropStaged(),
  component: Unlock,
});

function Unlock() {
  const { redirect } = Route.useSearch();
  const navigate = useNavigate();
  const { data: me } = useQuery(meQuery);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [remember, setRemember] = useState(false);
  // The desktop app can keep the unlock only in a secret store it trusts.
  const { data: canRemember } = useQuery({
    queryKey: ['desktop-secure-storage'],
    queryFn: () => desktop?.secureStorage() ?? false,
  });
  const accountId = me?.account.id;
  const [checkedRemembered, setCheckedRemembered] = useState(!desktop);
  // Once per page: React may run the effect twice, and two unlocks at once
  // would trip over each other's staged keys.
  const tried = useRef(false);
  // Pressed Open without plugins: this tab unlocks in safe mode.
  const withoutPlugins = useRef(false);

  // At launch, a remembered unlock opens the vault without asking.
  useEffect(() => {
    if (!desktop || !accountId || tried.current) return;
    tried.current = true;
    void (async () => {
      const started = vaultStore.epoch();
      const vaultKey = await desktop.rememberedVault(accountId).catch(() => null);
      try {
        if (vaultKey) {
          await unlockWith({ kind: 'vault-key', vaultKey }, started);
          await navigate({ to: safeRedirect(redirect) });
          return;
        }
      } catch (caught) {
        // A key that no longer opens this vault is no use to keep. Anything
        // else, such as the server being away, leaves it for next time.
        if (caught instanceof CryptoError) await desktop.forgetVault().catch(() => {});
      } finally {
        vaultKey?.fill(0);
      }
      setCheckedRemembered(true);
    })();
  }, [accountId, navigate, redirect]);

  async function submit(form: FormData) {
    const passphrase = form.get('passphrase');
    if (typeof passphrase !== 'string' || !passphrase) return;
    const started = vaultStore.epoch();
    // Before unlocking, which starts the plugins; only if it opens.
    const safe = withoutPlugins.current && !tabSafeMode.on();
    withoutPlugins.current = false;
    if (safe) tabSafeMode.set(true);
    setBusy(true);
    setError(null);
    try {
      const vault = await unlockWith({ kind: 'passphrase', passphrase }, started);
      // The switch says what happens at the next launch, whatever was kept before.
      if (remember) await desktop?.rememberVault(vault.accountId, vault.vaultKey);
      else await desktop?.forgetVault();
      await navigate({ to: safeRedirect(redirect) });
    } catch (caught) {
      if (safe) tabSafeMode.set(false);
      setError(vaultMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  if (!checkedRemembered) return null;
  return (
    <AuthCard
      title="Unlock your vault"
      description="Your pages are encrypted with keys only your passphrase opens."
    >
      <form onSubmit={submitData(submit)} className="grid gap-4">
        <Field
          id="passphrase"
          name="passphrase"
          label="Vault passphrase"
          type="password"
          autoComplete="off"
          required
          autoFocus
        />
        {canRemember && (
          <div className="grid gap-1.5">
            <div className="flex items-center gap-3">
              <Switch id="remember" checked={remember} onCheckedChange={setRemember} />
              <Label htmlFor="remember">Remember on this computer</Label>
            </div>
            <p className="text-sm text-muted-foreground">
              Unlocks when WikiStow starts, until you lock it or sign out. Your keyring keeps the
              key.
            </p>
          </div>
        )}
        {error && <FormMessage>{error}</FormMessage>}
        <Button type="submit" disabled={busy}>
          {busy ? 'Unlocking…' : 'Unlock'}
        </Button>
        {!desktop && (
          <Button
            type="submit"
            variant="outline"
            disabled={busy}
            onClick={() => (withoutPlugins.current = true)}
          >
            Open without plugins
          </Button>
        )}
        <Link to="/vault/recover" className="text-sm quiet-link">
          Use your recovery key instead
        </Link>
      </form>
    </AuthCard>
  );
}
