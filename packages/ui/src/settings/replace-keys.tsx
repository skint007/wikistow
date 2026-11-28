// Settings → Security → Replace my keys (protocol section 4.6, #327): new
// identity keys at the next key version, a new vault, passphrase and
// recovery key, and the agents the person ticks kept at the new key; then
// their shared folders moved to the new keys. Shown only where the server
// takes it (`IDENTITY_ROTATION`).
import {
  agentOperations,
  closeSession,
  contactsOperations,
  replaceKeysOperations as replaceKeys,
  type ClientContext,
  type UnlockedVault,
} from '@wikistow/client';
import { ApiError } from '@wikistow/client/api';
import { accountRoutes, vaultRoutes } from '@wikistow/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Field } from '@/components/form/field';
import { submitData } from '@/components/form/submit';
import { FormMessage } from '@/components/layout/auth-card';
import { Button } from '@/components/ui/button';
import { api, installationQuery, meQuery } from '../api';
import { useReauth } from '../auth/reauth';
import { errorMessage } from '../errors';
import { PassphraseFields, readPassphrase } from '../routes/_app/vault/setup';
import { vaultMessage } from '../vault/messages';
import { tellKeysReplaced } from '../data/kept-store';
import { keepAnchor, keepChangedWrapper, keepSentRotation, startSession } from '../vault/open';
import { forgetKeptUnlock, PLAIN, useVault, vaultStore, zeroVault } from '../vault/store';
import { workerVaultCrypto } from '../vault/worker-crypto';
import { FormRow, useOpenedRow } from './rows';
import { ownedQuery, SpacesAfterRotation, SpacesBeforeRotation } from './rotated-spaces';
import { finishingQuery, leftToFinish } from '../sharing/finish-rotation';

/**
 * A rotation made here and not yet answered, kept in memory, not in the
 * form, so closing the form or a lost answer sends the same one again, never
 * new keys with a recovery key nobody saved. A lock drops it, with the keys.
 */
type Held = {
  prepared: replaceKeys.PreparedRotation;
  epoch: number;
  password: boolean;
  /** The send under way, which a panel opened again waits for too. */
  run: Promise<Outcome> | null;
  /** Sent at least once: it may have landed, so it is never replaced. */
  sent: boolean;
};
let pending: Held | null = null;

/** How a send ended. */
type Outcome =
  | { kind: 'done'; password: boolean }
  | { kind: 'not-opened' }
  | { kind: 'dropped'; message: string }
  | { kind: 'again'; message: string };

/**
 * The last send's outcome once it landed, shown again if the panel opens
 * again, until the next lock.
 */
let finished: (Outcome & { epoch: number }) | null = null;
const finishedNow = () => {
  if (finished && finished.epoch !== vaultStore.epoch()) finished = null;
  return finished;
};
const current = () => {
  if (pending && pending.epoch !== vaultStore.epoch()) pending = null;
  return pending;
};

// A lock drops a rotation waiting to be sent, and its recovery key, at once.
vaultStore.subscribe(() => {
  current();
  finishedNow();
});

/**
 * Once a rotation landed but this tab couldn't open the new vault, what the
 * row says, so it says it after a lock too.
 */
let landedFor: string | null = null;

/** Counts preparations, so only the latest is kept. */
let preparing = 0;

const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium' });

export function ReplaceKeys() {
  const { data: installation } = useQuery(installationQuery);
  const vault = useVault();
  const { data: me } = useQuery(meQuery);
  // Past key version 1, the person replaced their keys: from the server's
  // answer, so it shows while locked too.
  const retired = (me?.identity?.keyVersion ?? 1) > 1;
  // Whether shared folders are left at keys the old key opens: unknown while locked.
  const unlockedCtx = vault.status === 'unlocked' ? vault.ctx : null;
  const checking = vault.status === 'unlocked' && retired;
  const { data: finishing } = useQuery({ ...finishingQuery(unlockedCtx), enabled: checking });
  // Spaces owned with others wait for another owner to add the person again.
  const { data: owned } = useQuery({ ...ownedQuery(unlockedCtx), enabled: checking });
  // Off on the server, someone who replaced their keys still finishes and
  // copies what the rotation left; nobody can start a new one.
  const canRotate = !!installation?.identityRotation;
  if (!canRotate && !retired) return null;
  const landed = landedFor !== null && landedFor === me?.account.id;
  const finishedSharing =
    leftToFinish(finishing) === 0 &&
    owned !== undefined &&
    !owned.some((s) => s.waitsForReAdd || s.confirmFirst);
  return (
    <FormRow
      id="replace-keys"
      name="Replace my keys"
      label="Start"
      close="Close"
      state={
        landed && !retired
          ? 'Your keys are replaced. Lock your vault, and unlock it with your new passphrase.'
          : retired && finishedSharing
            ? 'Your keys were replaced, and your shared folders use the new ones.'
            : retired
              ? 'Your keys were replaced. Moving what you share to the new keys isn’t finished: until it is, people you share with use your earlier keys.'
              : 'If your keys may have leaked, make new ones. You choose a new passphrase and get a new recovery key.'
      }
    >
      {vault.status === 'unlocked' ? (
        <ReplaceKeysFlow ctx={vault.ctx} vault={vault.vault} canRotate={canRotate} />
      ) : (
        <p className="text-sm">
          Unlock your vault first. If you lost your passphrase, use your recovery key.
        </p>
      )}
    </FormRow>
  );
}

function ReplaceKeysFlow({
  ctx,
  vault,
  canRotate,
}: {
  ctx: ClientContext;
  vault: UnlockedVault;
  canRotate: boolean;
}) {
  const [step, setStep] = useState<'choose' | 'save' | 'done'>(() =>
    finishedNow()?.kind === 'done' ? 'done' : current() ? 'save' : 'choose',
  );
  const [password, setPassword] = useState(() => {
    const now = finishedNow();
    return now?.kind === 'done' && now.password;
  });
  if (step === 'done') {
    return (
      <div className="grid gap-4">
        <Replaced password={password} />
        {vault.identity.public.keyVersion > 1 && <SpacesAfterRotation ctx={ctx} />}
      </div>
    );
  }
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
  return (
    <div className="grid gap-6">
      {vault.identity.public.keyVersion > 1 && <SpacesAfterRotation ctx={ctx} />}
      {canRotate ? (
        <Choose ctx={ctx} vault={vault} onPrepared={() => setStep('save')} />
      ) : (
        <p className="text-sm text-muted-foreground">
          This server doesn’t let anyone replace their keys now.
        </p>
      )}
    </div>
  );
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
  // The spaces the person owns, named before they confirm (`SpacesBeforeRotation`).
  const owned = useQuery(ownedQuery(ctx));
  // Names from the contacts record: under PLAIN, so a lock drops them.
  const agents = useQuery({
    queryKey: [PLAIN, 'rotation-agents', vault.identity.public.keyVersion],
    queryFn: async () => {
      // From the record as the server has it now, as preparing reads it.
      const book = await contactsOperations.readContacts(
        { api: ctx.api, installationId: ctx.installationId, identity: ctx.identity },
        ctx.contacts.book.mark,
      );
      const keepable = await replaceKeys.keepableAgents(ctx, book.payloads);
      const ids = new Set<string>(keepable.map((agent) => agent.agentId));
      // Every other live agent is revoked: listed too, as the server names it.
      const others = (await agentOperations.listAgents(ctx)).filter(
        (agent) => agent.revokedAt === null && !ids.has(agent.agentId),
      );
      return { keepable, others };
    },
  });
  const [kept, setKept] = useState<ReadonlySet<string>>(new Set());
  // The list again, and the ticks only of agents still on it.
  const refresh = async () => {
    const { data } = await agents.refetch();
    const listed = new Set<string>(data?.keepable.map((agent) => agent.agentId) ?? []);
    setKept((was) => new Set([...was].filter((id) => listed.has(id))));
  };
  const [password, setPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(form: FormData) {
    // Numbered first, so only the latest submit's preparation can be kept.
    const mine = ++preparing;
    // Taken as it starts: a lock during the slow steps below stops it.
    const epoch = vaultStore.epoch();
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
          (error: unknown) => {
            // Only a passphrase that doesn't open it is new; any other failure stops here.
            if (error instanceof Error && 'code' in error && error.code === 'decrypt-failed') {
              return false;
            }
            throw error;
          },
        );
      if (reused) return setError('Choose a passphrase you haven’t used for your vault.');
      if (vaultStore.epoch() !== epoch) return;
      const keepable = (agents.data?.keepable ?? []).map((agent) => agent.agentId);
      const others = (agents.data?.others ?? []).map((agent) => agent.agentId);
      const prepared = await replaceKeys.prepareRotation(ctx, {
        vault,
        crypto: workerVaultCrypto,
        passphrase: passphrase.value,
        keep: [...kept],
        shown: { live: [...keepable, ...others], keepable },
      });
      // Locked meanwhile, or another preparation started since, as in a
      // panel closed and opened again: this one goes.
      // Nor ever over a rotation being sent, or sent with no answer yet.
      const sending = pending !== null && (pending.run !== null || pending.sent);
      if (vaultStore.epoch() !== epoch || mine !== preparing || sending) {
        zeroVault(prepared.vault);
        if (sending) {
          setError(
            'New keys were already sent. Close this and open it again to see how that went.',
          );
        }
        return;
      }
      vaultStore.stage(prepared.vault);
      pending = { prepared, epoch, password, run: null, sent: false };
      landedFor = null;
      finished = null;
      onPrepared();
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === 'stale-head') {
        void refresh();
        setError(
          'Something changed on another device, such as an agent enrolled. Check the list, and try again.',
        );
      } else if (
        caught instanceof Error &&
        'code' in caught &&
        caught.code === 'malformed' &&
        caught.message.includes('agent')
      ) {
        void refresh();
        setError('An agent you ticked was revoked meanwhile. Check the list, and try again.');
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
      <SpacesBeforeRotation ctx={ctx} />
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
        // Not before the spaces the person owns are named (#327, item 7).
        disabled={busy || agents.isPending || Boolean(agents.error) || owned.isPending}
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
      'request-timeout',
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

/**
 * Send `held`, once at a time, and finish: what a panel shows comes from
 * here, so closing the panel mid-send and opening it again shows the same
 * send's end.
 */
function send(
  held: Held,
  withReauth: ReturnType<typeof useReauth>,
  queryClient: ReturnType<typeof useQueryClient>,
): Promise<Outcome> {
  held.run ??= sendAndFinish(held, withReauth, queryClient).finally(() => {
    held.run = null;
  });
  return held.run;
}

async function sendAndFinish(
  held: Held,
  withReauth: ReturnType<typeof useReauth>,
  queryClient: ReturnType<typeof useQueryClient>,
): Promise<Outcome> {
  const { prepared, epoch, password } = held;
  // Kept until a definite answer, so a reload meanwhile knows the
  // statement as this device's own (#764).
  await keepSentRotation(replaceKeys.rotationHash(prepared.request.rotation)).catch(() => {});
  try {
    await withReauth(() => {
      // Locked meanwhile, as while signing in again: nothing is sent.
      if (current() !== held) throw new LockedMeanwhile();
      held.sent = true;
      return replaceKeys.sendRotation(api, prepared);
    });
  } catch (caught) {
    if (caught instanceof LockedMeanwhile) {
      return {
        kind: 'dropped',
        message: 'Your vault locked, so nothing was sent. Unlock it and start again.',
      };
    }
    // A first send whose answer was lost may have landed: a refusal now,
    // or no clear answer, says nothing of it until the server is asked.
    const landedBefore = await replaceKeys.rotationLanded(api, prepared).catch(() => null);
    if (landedBefore !== true) {
      if (landedBefore === false && definitelyRefused(caught)) {
        // Nothing was stored, and these keys are of no use now.
        if (pending === held) pending = null;
        await keepSentRotation(null).catch(() => {});
        // These keys only: another vault may be staged by now.
        zeroVault(prepared.vault);
        return {
          kind: 'dropped',
          message:
            caught.code === 'rotation-exists'
              ? 'Your keys were replaced already, maybe on another device. Lock your vault and unlock again.'
              : `${errorMessage(caught)} Nothing changed, and the recovery key above won’t work: start again, and save the new one.`,
        };
      }
      return {
        kind: 'again',
        message:
          caught instanceof ApiError && caught.code === 'reauth-required'
            ? vaultMessage(caught)
            : 'There was no clear answer. Try again: the same keys are sent.',
      };
    }
  }
  // It landed: the device keeps what follows from it, while the same
  // account is signed in here, even if the vault locked meanwhile.
  landedFor = prepared.vault.accountId;
  try {
    // The old vault key opens nothing served now: a remembered unlock goes,
    // whoever is signed in, so nothing reopens the old vault on its own.
    await forgetKeptUnlock();
    // Asked afresh: another tab may have signed in as someone else meanwhile.
    const me = await api.call(accountRoutes.me).catch(() => null);
    if (me?.account.id === prepared.vault.accountId) {
      await keepAnchor(prepared.vault.identity.public);
      await keepSentRotation(null).catch(() => {});
      // The new vault as served, kept for unlocking offline if it is this
      // rotation's, at the version served. Without an answer, the next
      // online unlock keeps it.
      const served = await api.call(vaultRoutes.getVault).catch(() => null);
      if (served && sameKeyring(served.wrapper, prepared.request.wrapper)) {
        await keepChangedWrapper(served);
      }
    }
    // The browser's other tabs hold the old keys: they lock, now the anchor moved.
    tellKeysReplaced();
    if (vaultStore.epoch() !== epoch) throw new LockedMeanwhile();
    const ctx = await startSession(prepared.vault);
    // Locked while it opened: nothing opens.
    if (vaultStore.epoch() !== epoch) {
      closeSession(ctx);
      throw new LockedMeanwhile();
    }
    vaultStore.unlock(ctx, prepared.vault);
    landedFor = null;
    await queryClient.invalidateQueries({ queryKey: meQuery.queryKey });
    finished = { kind: 'done', password, epoch: vaultStore.epoch() };
    // Only now, so a panel opened again meanwhile waited for this send.
    if (pending === held) pending = null;
  } catch {
    // The browser's other tabs hold the old keys whatever failed here.
    tellKeysReplaced();
    // The old keys open nothing the server takes now: this tab locks too.
    if (vaultStore.epoch() === epoch) vaultStore.lock({ forget: false });
    finished = { kind: 'not-opened', epoch: vaultStore.epoch() };
    if (pending === held) pending = null;
  }
  return finished;
}

const sameKeyring = (
  a: { format: number },
  b: { keyring: { nonce: string; ciphertext: string } },
) =>
  'keyring' in a &&
  typeof a.keyring === 'object' &&
  a.keyring !== null &&
  (a.keyring as { nonce?: unknown }).nonce === b.keyring.nonce &&
  (a.keyring as { ciphertext?: unknown }).ciphertext === b.keyring.ciphertext;

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
  const [error, setError] = useState<string | null>(
    finishedNow()?.kind === 'not-opened' ? NOT_OPENED : null,
  );
  const [busy, setBusy] = useState(false);
  // Sent and landed, or dropped: never sent again.
  const [dropped, setDropped] = useState(() => finishedNow() !== null);

  const show = (outcome: Outcome) => {
    setBusy(false);
    if (outcome.kind === 'done') return onSent(outcome.password);
    if (outcome.kind === 'not-opened') {
      setDropped(true);
      return setError(NOT_OPENED);
    }
    if (outcome.kind === 'dropped') setDropped(true);
    setError(outcome.message);
  };
  // A send this panel didn't start, as before it was closed and opened again.
  useEffect(() => {
    if (!held?.run) return;
    setBusy(true);
    void held.run.then(show);
    // Once, for the send under way as the panel opens.
  }, []);

  if (!held) {
    return finishedNow()?.kind === 'not-opened' || landedFor !== null ? (
      <p className="text-sm">{NOT_OPENED}</p>
    ) : (
      <div className="grid gap-3 text-sm">
        <p>Your vault locked before the new keys were sent, so nothing changed.</p>
        <Button size="sm" className="justify-self-start" onClick={onRestart}>
          Start again
        </Button>
      </div>
    );
  }

  async function submit(form: FormData) {
    if (!held) return;
    const typed = asked.map((index) => {
      const value = form.get(`rotation-group-${index}`);
      return typeof value === 'string' ? value.trim().toLowerCase() : '';
    });
    if (typed.some((value, i) => value !== groups[asked[i] ?? -1])) {
      return setError('Those groups don’t match. Check the key you saved.');
    }
    setBusy(true);
    setError(null);
    show(await send(held, withReauth, queryClient));
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
        {dropped && landedFor === null && error && (
          <Button type="button" variant="outline" onClick={onRestart}>
            Start again
          </Button>
        )}
      </div>
    </form>
  );
}

const NOT_OPENED =
  'Your keys are replaced, and your new recovery key works, but this tab couldn’t open the new vault. Lock your vault, and unlock it with your new passphrase.';

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
