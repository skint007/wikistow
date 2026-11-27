import { CryptoError } from '@wikistow/client';
import { useQuery } from '@tanstack/react-query';
import { createFileRoute, Link, redirect, useNavigate } from '@tanstack/react-router';
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
import { useWaitingClips } from '../../../clip/clip-receiver';
import { desktop } from '../../../desktop';
import { tabSafeMode } from '../../../plugins/safe-mode';
import { isApple } from '../../../shell/search-model';
import { vaultMessage } from '../../../vault/messages';
import { checkKeptKeys, noLongerOpens, rememberOpenVault, unlockWith } from '../../../vault/open';
import { vaultStore } from '../../../vault/store';
import { forgetInBrowser } from '../../../vault/tab-unlock';

export const Route = createFileRoute('/_app/vault/unlock')({
  validateSearch: z.object({ redirect: z.string().optional().catch(undefined) }),
  // A browser's kept or remembered unlock may have opened the vault on the
  // way here (`_app`): go on, rather than ask, and forget it on unlocking.
  beforeLoad: ({ search }) => {
    if (!desktop && vaultStore.get().status === 'unlocked') {
      throw redirect({ href: safeRedirect(search.redirect) });
    }
  },
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
  // A browser always can.
  const { data: canRemember } = useQuery({
    queryKey: ['desktop-secure-storage'],
    queryFn: () => desktop?.secureStorage() ?? true,
  });
  const accountId = me?.account.id;
  const [checkedRemembered, setCheckedRemembered] = useState(!desktop);
  // Once per page: React may run the effect twice, and two unlocks at once
  // would trip over each other's staged keys.
  const tried = useRef(false);
  // Clips from the browser save once it's unlocked (ADR 0017, decision 7).
  const clips = useWaitingClips();
  // Before a passphrase is asked for, or a remembered unlock tried: were the
  // keys this device last unlocked with replaced elsewhere (section 4.6)?
  const { data: keys, isPending: checking } = useQuery({
    queryKey: ['kept-keys-check', accountId],
    queryFn: async () => (await checkKeptKeys().catch(() => null)) ?? { kind: 'same' as const },
    enabled: accountId !== undefined,
    staleTime: Infinity,
    gcTime: 0,
  });
  const [answer, setAnswer] = useState<'did' | 'didnt' | null>(null);
  const replaced = keys?.kind === 'replaced' && answer !== 'did';

  // At launch, a remembered unlock opens the vault without asking.
  useEffect(() => {
    // Its key is the old vault's once keys were replaced: not tried, nor forgotten.
    if (checking || keys?.kind === 'replaced') {
      if (keys?.kind === 'replaced') setCheckedRemembered(true);
      return;
    }
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
        // else, such as the server being away, leaves it for next time; a
        // vault this version can't unlock says so before anyone types.
        if (noLongerOpens(caught)) await desktop.forgetVault().catch(() => {});
        else if (caught instanceof CryptoError) setError(vaultMessage(caught));
      } finally {
        vaultKey?.fill(0);
      }
      setCheckedRemembered(true);
    })();
  }, [accountId, navigate, redirect, checking, keys]);

  async function submit(form: FormData) {
    const passphrase = form.get('passphrase');
    if (typeof passphrase !== 'string' || !passphrase) return;
    const started = vaultStore.epoch();
    // Open without plugins: safe mode for this tab, set before unlocking,
    // which starts the plugins, and kept only if it opens.
    const safe = form.get('plugins') === 'off' && !tabSafeMode.on();
    if (safe) tabSafeMode.set(true);
    setBusy(true);
    setError(null);
    try {
      const vault = await unlockWith({ kind: 'passphrase', passphrase }, started);
      // The switch says what happens at the next launch or visit, whatever was kept before.
      if (desktop) {
        if (remember) await desktop.rememberVault(vault.accountId, vault.vaultKey);
        else await desktop.forgetVault();
      } else {
        // The vault is open by now: failing to remember it isn't failing to unlock.
        await (remember ? rememberOpenVault(vault) : forgetInBrowser()).catch(() => {});
      }
      await navigate({ to: safeRedirect(redirect) });
    } catch (caught) {
      if (safe) tabSafeMode.set(false);
      setError(vaultMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  if (!checkedRemembered || checking) return null;
  if (replaced) {
    return answer === 'didnt' ? (
      <NotThem />
    ) : (
      <DidYouReplace onDid={() => setAnswer('did')} onDidnt={() => setAnswer('didnt')} />
    );
  }
  return (
    <AuthCard
      title="Unlock your vault"
      description="Your pages are encrypted with keys only your passphrase opens."
    >
      <form onSubmit={submitData(submit)} className="grid gap-4">
        {keys?.kind === 'substituted' && (
          <FormMessage>
            The server shows keys for you that don’t follow from the ones this device last unlocked
            with. That may be an attack. Tell whoever runs your server, and compare your key’s
            fingerprint with the people you share with before you share anything new.
          </FormMessage>
        )}
        <Field
          id="passphrase"
          name="passphrase"
          label="Vault passphrase"
          type="password"
          autoComplete="off"
          required
          autoFocus
        />
        {clips > 0 && (
          <p role="status" className="text-sm text-muted-foreground">
            {clips === 1 ? '1 clip waits' : `${clips} clips wait`} to be saved from your browser.
          </p>
        )}
        {canRemember && (
          <div className="grid gap-1.5">
            <div className="flex items-center gap-3">
              <Switch id="remember" checked={remember} onCheckedChange={setRemember} />
              <Label htmlFor="remember">
                {desktop ? 'Remember on this computer' : 'Remember on this browser'}
              </Label>
            </div>
            <p className="text-sm text-muted-foreground">
              {desktop
                ? `Unlocks when WikiStow starts, until you lock it or sign out. Your ${isApple() ? 'Keychain' : 'system’s secret store'} keeps the key.`
                : 'Unlocks on later visits, until you lock it or sign out. Anyone who can use this browser profile can read your vault.'}
            </p>
          </div>
        )}
        {error && <FormMessage>{error}</FormMessage>}
        <Button type="submit" disabled={busy}>
          {busy ? 'Unlocking…' : 'Unlock'}
        </Button>
        {!desktop && (
          <Button type="submit" name="plugins" value="off" variant="outline" disabled={busy}>
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

/**
 * The directory shows the keys this device last unlocked with replaced, by
 * a chain only someone holding them could sign: the person, on another
 * device, or someone who has their old key (section 4.6, A15). Only the
 * person knows which.
 */
function DidYouReplace({ onDid, onDidnt }: { onDid: () => void; onDidnt: () => void }) {
  return (
    <AuthCard
      title="Did you replace your keys?"
      description="Your account’s keys were replaced since this device last unlocked. Only you can know whether that was you, on another device."
    >
      <div className="grid gap-3">
        <Button onClick={onDid}>I did this</Button>
        <Button variant="outline" onClick={onDidnt}>
          I didn’t
        </Button>
        <p className="text-sm text-muted-foreground">
          If you did, unlock with the passphrase you chose then. This device keeps what it had until
          you do.
        </p>
      </div>
    </AuthCard>
  );
}

/**
 * Someone else holds the person's keys. This device keeps the vault it had,
 * and the remembered unlock, and opens nothing with the replaced keys:
 * nothing more is signed or sealed with them here.
 */
function NotThem() {
  return (
    <AuthCard
      title="Someone else holds your keys"
      description="Whoever replaced your keys had your earlier ones. People you share with now see their keys as yours."
    >
      <div className="grid gap-3 text-sm">
        <p>
          Warn the people you share with in person, not through WikiStow, so they stop sharing with
          those keys. Your agents follow the new keys too.
        </p>
        <p>
          Change your account password, which signs everyone out and ends every agent’s access, and
          tell whoever runs your server. This device signs and seals nothing more with your keys.
        </p>
        <Link to="/settings" hash="password" className="quiet-link">
          Change your password
        </Link>
      </div>
    </AuthCard>
  );
}
