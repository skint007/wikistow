// Settings → Security → Replace my keys (protocol section 4.6, #327): new
// identity keys at the next key version, a new vault, passphrase and
// recovery key, and the agents the person ticks kept at the new key. Shown
// only where the server takes it (`IDENTITY_ROTATION`), which stays off
// until replacing keys is fully built.
import {
  agentOperations,
  closeSession,
  replaceKeysOperations as replaceKeys,
  type ClientContext,
  type UnlockedVault,
} from '@wikistow/client';
import { ApiError, noAnswer } from '@wikistow/client/api';
import { vaultRoutes } from '@wikistow/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Field } from '@/components/form/field';
import { submitData } from '@/components/form/submit';
import { FormMessage } from '@/components/layout/auth-card';
import { Button } from '@/components/ui/button';
import { api, installationQuery, meQuery } from '../api';
import { useReauth } from '../auth/reauth';
import { errorMessage } from '../errors';
import { PassphraseFields, readPassphrase } from '../routes/_app/vault/setup';
import { vaultMessage } from '../vault/messages';
import { keepAnchor, keepChangedWrapper, startSession } from '../vault/open';
import { forgetKeptUnlock, PLAIN, useVault, vaultStore, zeroVault } from '../vault/store';
import { workerVaultCrypto } from '../vault/worker-crypto';
import { FormRow, useOpenedRow } from './rows';

/**
 * A rotation made here and not yet answered, kept in memory, not in the
 * form, so closing the form or a lost answer sends the same one again, never
 * new keys with a recovery key nobody saved. A lock drops it, with the keys.
 */
let pending: { prepared: replaceKeys.PreparedRotation; epoch: number; password: boolean } | null =
  null;
const current = () => {
  if (pending && pending.epoch !== vaultStore.epoch()) pending = null;
  return pending;
};

// A lock drops a rotation waiting to be sent, and its recovery key, at once.
vaultStore.subscribe(() => {
  current();
});

/**
 * Once a rotation landed but this tab couldn't open the new vault, what the
 * row says, so it says it after a lock too.
 */
let landed = false;

const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium' });

export function ReplaceKeys() {
  const { data: installation } = useQuery(installationQuery);
  const vault = useVault();
  if (!installation?.identityRotation) return null;
  const retired = vault.status === 'unlocked' && vault.vault.retired.length > 0;
  return (
    <FormRow
      id="replace-keys"
      name="Replace my keys"
      label="Start"
      close="Close"
      state={
        landed && !retired
          ? 'Your keys are replaced. Lock your vault, and unlock it with your new passphrase.'
          : retired
            ? 'You replaced your keys. Moving what you share to the new keys isn’t finished: until it is, people you share with use your earlier keys.'
            : 'If your keys may have leaked, make new ones. You choose a new passphrase and get a new recovery key.'
      }
    >
      {vault.status === 'unlocked' ? (
        <ReplaceKeysFlow ctx={vault.ctx} vault={vault.vault} />
      ) : (
        <p className="text-sm">
          Unlock your vault first. If you lost your passphrase, use your recovery key.
        </p>
      )}
    </FormRow>
  );
}

function ReplaceKeysFlow({ ctx, vault }: { ctx: ClientContext; vault: UnlockedVault }) {
  const [step, setStep] = useState<'choose' | 'save' | 'done'>(() =>
    current() ? 'save' : 'choose',
  );
  const [password, setPassword] = useState(false);
  if (step === 'done') return <Replaced password={password} />;
  if (step === 'save') {
    return (
      <SaveAndSend
        onSent={(changePassword) => {
          setPassword(changePassword);
          setStep('done');
        }}
        onRestart={() => setStep('choose')}
      />
    );
  }
  return <Choose ctx={ctx} vault={vault} onPrepared={() => setStep('save')} />;
}

function Choose({
  ctx,
  vault,
  onPrepared,
}: {
  ctx: ClientContext;
  vault: UnlockedVault;
  onPrepared: () => void;
}) {
  // Names from the contacts record: under PLAIN, so a lock drops them.
  const agents = useQuery({
    queryKey: [PLAIN, 'rotation-agents', vault.identity.public.keyVersion],
    queryFn: async () => {
      const keepable = await replaceKeys.keepableAgents(ctx);
      const ids = new Set<string>(keepable.map((agent) => agent.agentId));
      // Every other live agent is revoked: listed too, as the server names it.
      const others = (await agentOperations.listAgents(ctx)).filter(
        (agent) => agent.revokedAt === null && !ids.has(agent.agentId),
      );
      return { keepable, others };
    },
  });
  const [kept, setKept] = useState<ReadonlySet<string>>(new Set());
  const [password, setPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(form: FormData) {
    setBusy(true);
    setError(null);
    try {
      const passphrase = await readPassphrase(form);
      if ('error' in passphrase) return setError(passphrase.error);
      // A new vault under the old passphrase would open to whoever knows it.
      const { wrapper } = await api.call(vaultRoutes.getVault);
      const reused = await workerVaultCrypto
        .unlock({ wrapper, secret: { kind: 'passphrase', passphrase: passphrase.value } })
        .then(
          (opened) => {
            zeroVault(opened);
            return true;
          },
          () => false,
        );
      if (reused) return setError('Choose a passphrase you haven’t used for your vault.');
      const epoch = vaultStore.epoch();
      const shown = [...(agents.data?.keepable ?? []), ...(agents.data?.others ?? [])];
      const prepared = await replaceKeys.prepareRotation(ctx, {
        vault,
        crypto: workerVaultCrypto,
        passphrase: passphrase.value,
        keep: [...kept],
        shown: shown.map((agent) => agent.agentId),
      });
      if (vaultStore.epoch() !== epoch) return;
      vaultStore.stage(prepared.vault);
      pending = { prepared, epoch, password };
      onPrepared();
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === 'stale-head') {
        void agents.refetch();
        setError(
          'Something changed on another device, such as an agent enrolled. Check the list, and try again.',
        );
      } else {
        setError(vaultMessage(caught));
      }
    } finally {
      setBusy(false);
    }
  }

  const toggle = (agentId: string, on: boolean) =>
    setKept((was) => {
      const next = new Set(was);
      if (on) next.add(agentId);
      else next.delete(agentId);
      return next;
    });

  return (
    <form onSubmit={submitData(submit)} className="grid max-w-xl gap-4 text-sm">
      <p>
        This makes new keys for you, and a new vault: a new passphrase and a new recovery key. Your
        earlier keys stay in it, only to open what was shared with them. Your other devices are
        signed out, and live editing in your spaces stops, to start again with the new keys.
      </p>
      <fieldset className="grid gap-2">
        <legend className="mb-1 font-bold">Agents to keep</legend>
        {agents.isPending ? (
          <p className="text-muted-foreground">Loading your agents…</p>
        ) : agents.error ? (
          <FormMessage>{errorMessage(agents.error)}</FormMessage>
        ) : (
          <>
            {agents.data.keepable.length === 0 ? (
              <p className="text-muted-foreground">You have no agents to keep.</p>
            ) : (
              <p className="text-muted-foreground">
                Every agent you don’t tick is revoked. Before you tick one, run{' '}
                <code>wikistow whoami</code> on its computer and check it prints the same ID:
                someone holding your earlier keys could have named their own agent after one of
                yours.
              </p>
            )}
            {agents.data.keepable.map((agent) => (
              <label key={agent.agentId} className="flex items-start gap-2">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={kept.has(agent.agentId)}
                  onChange={(event) => toggle(agent.agentId, event.target.checked)}
                />
                <span>
                  <span className="font-bold">{agent.name}</span>, enrolled {day(agent.enrolledAt)}
                  <br />
                  <code className="break-all text-muted-foreground">{agent.agentId}</code>
                </span>
              </label>
            ))}
            {agents.data.others.length > 0 && (
              <div className="grid gap-1">
                <p className="text-muted-foreground">
                  These are revoked: WikiStow runs them, or your contacts don’t list them.
                </p>
                {agents.data.others.map((agent) => (
                  <p key={agent.agentId}>
                    <span className="font-bold">{agent.name}</span>, enrolled{' '}
                    {day(agent.enrolledAt)}
                    <br />
                    <code className="break-all text-muted-foreground">{agent.agentId}</code>
                  </p>
                ))}
              </div>
            )}
          </>
        )}
        <p className="text-muted-foreground">
          The agents WikiStow runs for the page chat are revoked, and made again when you next use
          it.
        </p>
      </fieldset>
      <label className="flex items-start gap-2">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={password}
          onChange={(event) => setPassword(event.target.checked)}
        />
        <span>
          Change the password I sign in with too, if someone may know it. That also ends every
          agent’s access, the ones you keep included, so you enroll them again.
        </span>
      </label>
      <PassphraseFields />
      {error && <FormMessage>{error}</FormMessage>}
      <Button
        type="submit"
        disabled={busy || agents.isPending || Boolean(agents.error)}
        className="justify-self-start"
      >
        {busy ? 'Making new keys…' : 'Make new keys'}
      </Button>
    </form>
  );
}

/** The vault locked while a rotation waited to be sent. */
class LockedMeanwhile extends Error {}

/**
 * A refusal that stored nothing, so these keys are of no use: the server
 * answered with one of the rotation's own refusals. A cancelled sign-in, a
 * busy or failing server, or an answer that couldn't be read may come before
 * or after it landed, so the same request is sent again.
 */
function definitelyRefused(error: unknown): error is ApiError {
  return (
    error instanceof ApiError &&
    error.status >= 400 &&
    error.status < 500 &&
    ![
      'reauth-required',
      'rate-limited',
      'account-rate-limited',
      'unreadable-response',
      'network',
    ].includes(error.code)
  );
}

/** Two groups of the key, chosen at random, to type back as proof it was saved. */
function pickGroups(count: number): [number, number] {
  const first = Math.floor(Math.random() * count);
  const second = (first + 1 + Math.floor(Math.random() * (count - 1))) % count;
  return first < second ? [first, second] : [second, first];
}

function SaveAndSend({
  onSent,
  onRestart,
}: {
  onSent: (changePassword: boolean) => void;
  onRestart: () => void;
}) {
  const queryClient = useQueryClient();
  const withReauth = useReauth();
  const [held] = useState(current);
  const groups = held?.prepared.recoveryKey.split('-') ?? [];
  const [asked] = useState(() => pickGroups(groups.length));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Sent and landed, or definitely refused: never sent again.
  const [dropped, setDropped] = useState(false);
  if (!held) {
    return (
      <div className="grid gap-3 text-sm">
        <p>Your vault locked before the new keys were sent, so nothing changed.</p>
        <Button size="sm" className="justify-self-start" onClick={onRestart}>
          Start again
        </Button>
      </div>
    );
  }
  const { prepared, epoch, password } = held;

  async function submit(form: FormData) {
    const typed = asked.map((index) => {
      const value = form.get(`rotation-group-${index}`);
      return typeof value === 'string' ? value.trim().toLowerCase() : '';
    });
    if (typed.some((value, i) => value !== groups[asked[i] ?? -1])) {
      return setError('Those groups don’t match. Check the key you saved.');
    }
    setBusy(true);
    setError(null);
    let answer: { vaultVersion: number } | null = null;
    try {
      answer = await withReauth(() => {
        // Locked meanwhile, as while signing in again: nothing is sent.
        if (current() !== held) throw new LockedMeanwhile();
        return replaceKeys.sendRotation(api, prepared);
      });
    } catch (caught) {
      if (caught instanceof LockedMeanwhile) {
        setBusy(false);
        return setError('Your vault locked, so nothing was sent. Unlock it and start again.');
      }
      // A first send whose answer was lost may have landed: a refusal now,
      // or no clear answer, says nothing of it until the server is asked.
      const landedBefore = await replaceKeys.rotationLanded(api, prepared).catch(() => null);
      if (landedBefore !== true) {
        setBusy(false);
        if (landedBefore === false && definitelyRefused(caught)) {
          // Nothing was stored, and these keys are of no use now.
          pending = null;
          setDropped(true);
          vaultStore.dropStaged();
          return setError(
            caught.code === 'rotation-exists'
              ? 'Your keys were replaced already, maybe on another device. Lock your vault and unlock again.'
              : `${errorMessage(caught)} Nothing changed, and the recovery key above won’t work: start again, and save the new one.`,
          );
        }
        return setError(
          caught instanceof ApiError && caught.code === 'reauth-required'
            ? vaultMessage(caught)
            : 'There was no clear answer. Try again: the same keys are sent.',
        );
      }
    }
    // It landed: the device keeps what follows from it, while the same
    // account is signed in here, even if the vault locked meanwhile.
    pending = null;
    landed = true;
    setDropped(true);
    try {
      const me = queryClient.getQueryData(meQuery.queryKey);
      if (me?.account.id === prepared.vault.accountId) {
        await forgetKeptUnlock();
        await keepAnchor(prepared.vault.identity.public);
        // Kept only as the version it was stored at, never a later one.
        if (answer?.vaultVersion === prepared.request.expectedVaultVersion + 1) {
          await keepChangedWrapper({
            wrapper: prepared.request.wrapper,
            version: answer.vaultVersion,
          });
        }
      }
      if (vaultStore.epoch() !== epoch) throw new LockedMeanwhile();
      const ctx = await startSession(prepared.vault);
      // Locked while it opened: nothing opens.
      if (vaultStore.epoch() !== epoch) {
        closeSession(ctx);
        throw new LockedMeanwhile();
      }
      vaultStore.unlock(ctx, prepared.vault);
      landed = false;
      await queryClient.invalidateQueries({ queryKey: meQuery.queryKey });
      onSent(password);
    } catch {
      setError(
        'Your keys are replaced, and your new recovery key works, but this tab couldn’t open the new vault. Lock your vault, and unlock it with your new passphrase.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submitData(submit)} className="grid max-w-xl gap-4 text-sm">
      <p className="font-bold">Save your new recovery key</p>
      <p>
        If you forget your new passphrase, this key is the only way back in. Your old recovery key
        stops working once your keys are replaced. It won’t be shown again.
      </p>
      <p
        data-testid="rotation-recovery-key"
        className="rounded-control bg-muted p-3 font-mono break-words"
      >
        {groups.join(' ')}
      </p>
      <p>To confirm you saved it, type two of its groups.</p>
      <div className="grid grid-cols-2 gap-3">
        {asked.map((index) => (
          <Field
            key={index}
            id={`rotation-group-${index}`}
            name={`rotation-group-${index}`}
            label={`Group ${index + 1}`}
            spellCheck={false}
            required
          />
        ))}
      </div>
      {error && <FormMessage>{error}</FormMessage>}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={busy || dropped}>
          {busy ? 'Replacing…' : 'Replace my keys'}
        </Button>
        {dropped && !landed && error && (
          <Button type="button" variant="outline" onClick={onRestart}>
            Start again
          </Button>
        )}
      </div>
    </form>
  );
}

function Replaced({ password }: { password: boolean }) {
  const { setOpen } = useOpenedRow();
  return (
    <div className="grid gap-3 text-sm" role="status">
      <p className="font-bold">Your keys are replaced.</p>
      <p>
        Your other devices are signed out. When they sign in again, unlock them with your new
        passphrase.
      </p>
      {password && (
        <Button size="sm" className="justify-self-start" onClick={() => setOpen('password')}>
          Change your password now
        </Button>
      )}
    </div>
  );
}
