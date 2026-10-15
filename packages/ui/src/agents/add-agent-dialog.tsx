import {
  agentOperations,
  appAgentOperations,
  type ClientContext,
  type IdentityId,
} from '@wikistow/client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot, Plus, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Name, plainText } from '@/components/name';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useReauth } from '../auth/reauth';
import { runCommand } from '../commands/command';
import {
  approveAgent,
  claimAgent,
  rejectAgent,
  type ApprovalStep,
} from '../commands/agent-commands';
import { requirementsHere } from '../commands/ui-commands';
import { refreshAccess } from '../data/queries';
import { ACCESS_LABELS, accessOf } from '../sharing/model';
import { ErrorLine, HoldOpen, useAction, useHoldOpen } from '../sharing/use-action';
import { PLAIN, useClient } from '../vault/store';
import { EnrollCommand } from './enroll-command';
import { Fingerprint } from './fingerprint';
import { agentMessage, PartlyDone } from './messages';
import {
  checkAgentName,
  checkGroup,
  enrollmentPoll,
  GROUP_ORDINALS,
  lookupCodeInput,
  MAX_AGENT_NAME,
  withPick,
} from './model';
import { PickForm, type ChosenPick } from './pick-form';

type Claim = agentOperations.Claim;
/** A claim, with the lookup code that named it as the CLI shows it. */
type Claimed = { claim: Claim; code: string };

/** This person's agents as their contacts record lists them, for telling names apart. */
export function listedAgents(ctx: Pick<ClientContext, 'contacts'>) {
  const { shared } = ctx.contacts.book.payloads;
  const revoked = new Map(shared.revokedAgents.map((entry) => [entry.agentId, entry.revokedAt]));
  return shared.agents.map((agent) => ({
    agentId: agent.enrollment.agent.id,
    name: agent.label.name,
    revokedAt: revoked.get(agent.enrollment.agent.id) ?? null,
  }));
}

/** "Space › Folder", or the whole space, for a pick in a sentence or list. */
export const pickPath = (pick: Pick<ChosenPick, 'path'>) =>
  pick.path.length === 0 ? 'Everything shared with you there' : pick.path.join(' › ');

/**
 * Add an agent (protocol section 9.2): enter the code the CLI shows, compare
 * the fingerprint both sides show, name the agent and pick its folders, then
 * approve behind a recent sign-in. Closing it before approving turns the
 * enrollment down, so the CLI stops waiting.
 */
export function AddAgentDialog({
  open,
  onOpenChange,
  inApp = false,
  onAdded,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** A chat assistant this app runs itself, rather than a CLI. */
  inApp?: boolean;
  /** Hears the agent once it is approved (and, in this app, ready to use). */
  onAdded?: (agentId: IdentityId) => void;
}) {
  const ctx = useClient();
  const [claimed, setClaimed] = useState<Claimed | null>(null);
  const claim = claimed?.claim ?? null;
  const [approved, setApproved] = useState<{ name: string; warning: string | null } | null>(null);
  const { locked, hold } = useHoldOpen();
  // `rejected`: the person already turned the claim down, so it isn't again.
  const close = (next: boolean, rejected = false) => {
    if (next) return;
    // Not approved: the CLI hears no, rather than waiting out its ten minutes.
    if (claim && !approved && !rejected) {
      void runCommand(rejectAgent, { claim }, { satisfies: requirementsHere(), ctx }).catch(
        () => {},
      );
    }
    setClaimed(null);
    setApproved(null);
    onOpenChange(false);
  };
  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent
        // Never taller than the window: inside, only the name and picks scroll,
        // so the fingerprint and Approve stay on screen together.
        dialogClassName="max-h-[calc(100dvh-2rem)] open:flex open:flex-col sm:max-w-xl"
        className="flex min-h-0 flex-col"
        locked={locked}
      >
        <HoldOpen value={hold}>
          {approved ? (
            <Approved {...approved} inApp={inApp} onClose={() => close(false)} />
          ) : inApp ? (
            <InApp
              onApproved={(done) => {
                setApproved(done);
                onAdded?.(done.agentId);
              }}
            />
          ) : claimed ? (
            <Compare
              {...claimed}
              onApproved={setApproved}
              onCancel={(rejected) => close(false, rejected)}
            />
          ) : (
            <EnterCode onClaim={setClaimed} />
          )}
        </HoldOpen>
      </DialogContent>
    </Dialog>
  );
}

/** Step 2: the code the CLI shows, claimed behind a recent sign-in. */
function EnterCode({ onClaim }: { onClaim: (claimed: Claimed) => void }) {
  const ctx = useClient();
  const withReauth = useReauth();
  const [typed, setTyped] = useState('');
  const { busy, error, run } = useAction(agentMessage);
  const code = lookupCodeInput(typed);
  return (
    <form
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (!code) return;
        void run(() =>
          withReauth(() =>
            runCommand(
              claimAgent,
              { lookupCode: code },
              { satisfies: requirementsHere(), ctx, onClaim: (claim) => onClaim({ claim, code }) },
            ),
          ),
        );
      }}
    >
      <DialogHeader>
        <DialogTitle>Add an agent</DialogTitle>
        <DialogDescription>
          In a terminal on the computer the agent runs on, run this command. Then enter the lookup
          code it shows.
        </DialogDescription>
      </DialogHeader>
      <EnrollCommand />
      <div className="grid gap-2">
        <Label htmlFor="lookup-code">Lookup code</Label>
        <Input
          id="lookup-code"
          name="lookup-code"
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
          placeholder="XXXX-XXXX"
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          maxLength={32}
          className="font-mono text-lg tracking-widest uppercase"
          required
          autoFocus
        />
      </div>
      <ErrorLine error={error} />
      <DialogFooter>
        <Button type="submit" disabled={busy || !code}>
          {busy ? 'Looking it up…' : 'Next'}
        </Button>
      </DialogFooter>
    </form>
  );
}

const STATE_NOTES: Partial<Record<string, string>> = {
  expired: 'This enrollment expired. Start again in the CLI.',
  cancelled: 'The CLI gave up on this enrollment. Start again there.',
  rejected: 'This enrollment was turned down. Start again in the CLI.',
};

/**
 * Steps 3 to 5: the fingerprint to compare next to the lookup code, while
 * the CLI's user confirms theirs; the agent's name and picks; then
 * approve, or say they don't match. The CLI's yes is only the server's
 * report, so approving also takes one group of the fingerprint, picked at
 * random, typed back from the CLI.
 */
function Compare({
  claim,
  code,
  onApproved,
  onCancel,
}: {
  claim: Claim;
  code: string;
  onApproved: (done: { name: string; warning: string | null }) => void;
  /** `rejected` when the person turned the claim down here. */
  onCancel: (rejected: boolean) => void;
}) {
  const ctx = useClient();
  const queryClient = useQueryClient();
  const withReauth = useReauth();
  const { data: state, error: stateError } = useQuery({
    queryKey: [PLAIN, 'enrollment', claim.enrollmentId],
    queryFn: () => agentOperations.enrollmentState(ctx, claim),
    refetchInterval: (query) => enrollmentPoll(query.state.data),
  });
  const form = useAgentForm();
  const { picks, trimmed, check } = form;
  const [step, setStep] = useState<ApprovalStep | null>(null);
  // Which group to ask for, fixed for this claim, so it can't be guessed ahead.
  const [asked] = useState(
    () => (crypto.getRandomValues(new Uint32Array(1))[0] ?? 0) % GROUP_ORDINALS.length,
  );
  const [typedGroup, setTypedGroup] = useState('');
  const group = checkGroup(claim.fingerprint, asked, typedGroup);
  const { busy, error, run } = useAction(agentMessage);
  const cliSaidYes = state === 'cli-confirmed';
  const ended = state ? STATE_NOTES[state] : undefined;
  const until = claim.deadline.toLocaleTimeString(undefined, { timeStyle: 'short' });

  const approve = () =>
    run(async () => {
      try {
        await withReauth(() =>
          runCommand(
            approveAgent,
            {
              claim,
              comparedFingerprint: claim.fingerprint,
              name: trimmed,
              renameRevoked:
                check.kind === 'revoked' ? { agentId: check.agentId, name: check.rename } : null,
              // The command keeps what it needs of each pick.
              picks,
            },
            { satisfies: requirementsHere(), ctx, onStep: setStep },
          ),
        );
        onApproved({ name: trimmed, warning: null });
      } catch (caught) {
        if (!(caught instanceof PartlyDone)) throw caught;
        onApproved({ name: trimmed, warning: caught.message });
      } finally {
        setStep(null);
        await refreshAccess(queryClient, ctx);
      }
    });

  const reject = () =>
    run(async () => {
      await runCommand(rejectAgent, { claim }, { satisfies: requirementsHere(), ctx });
      onCancel(true);
    });

  const stepText = approvalStepText(step, picks);

  return (
    <div className="flex min-h-0 flex-col gap-3">
      <DialogHeader>
        <DialogTitle>Compare the fingerprints</DialogTitle>
        <DialogDescription>
          Your agent’s computer shows a fingerprint too. Check that all ten groups match this one.
          If any group differs, someone else may be trying to connect: choose They don’t match. This
          works until {until}.
        </DialogDescription>
      </DialogHeader>
      <p className="text-sm text-muted-foreground">
        For lookup code{' '}
        <code data-testid="claimed-code" className="font-mono font-bold text-foreground">
          {code}
        </code>
        , which your CLI shows too.
      </p>
      <Fingerprint value={claim.fingerprint} />
      <p role="status" className="text-sm">
        {ended ??
          (stateError ? (
            <span className="text-destructive">
              Couldn’t check on the CLI: {agentMessage(stateError)} Still trying.
            </span>
          ) : cliSaidYes ? (
            'Yes was typed in the CLI. Still check every group above against the CLI before you approve.'
          ) : (
            'Waiting for the CLI: once the fingerprints match, type yes there.'
          ))}
      </p>
      {!ended && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <Label htmlFor="fingerprint-group" className="min-w-0 flex-1 basis-56 leading-snug">
            Type the {GROUP_ORDINALS[asked]} group of the fingerprint your CLI shows
          </Label>
          <Input
            id="fingerprint-group"
            value={typedGroup}
            onChange={(event) => setTypedGroup(event.target.value)}
            maxLength={9}
            disabled={busy}
            autoComplete="off"
            spellCheck={false}
            className="w-32 font-mono text-lg tracking-wider"
            aria-invalid={group === 'mismatch'}
            aria-describedby="fingerprint-group-note"
            autoFocus
          />
          <p
            id="fingerprint-group-note"
            className={group === 'mismatch' ? 'basis-full text-sm text-destructive' : 'sr-only'}
          >
            {group === 'mismatch'
              ? `That isn’t the ${GROUP_ORDINALS[asked]} group here. Check you typed it from the CLI; if it really differs, the fingerprints don’t match: choose They don’t match.`
              : 'Approve unlocks once it matches.'}
          </p>
        </div>
      )}
      {!ended && <NameAndPicks form={form} busy={busy} />}
      {stepText && (
        <p role="status" className="text-sm font-bold">
          {stepText} Keep this open until it’s done.
        </p>
      )}
      <ErrorLine error={error} />
      <DialogFooter>
        <Button
          variant="ghost"
          disabled={busy}
          onClick={ended ? () => onCancel(false) : () => void reject()}
        >
          {ended ? 'Close' : 'They don’t match'}
        </Button>
        {!ended && (
          <Button
            disabled={
              busy || !cliSaidYes || group !== 'match' || !trimmed || check.kind === 'taken'
            }
            onClick={() => void approve()}
          >
            Fingerprints match, approve
          </Button>
        )}
      </DialogFooter>
    </div>
  );
}

/**
 * A chat assistant this app runs itself (protocol section 9.2, local
 * approval): the same enrollment as a CLI's, with both sides here
 * (`beginLocalEnrollment`), so there is no code to type and no fingerprint
 * to compare. The person names it and picks its folders, then it is
 * created behind a recent sign-in. If approving fails, the enrollment is
 * turned down, and an agent the server made anyway is revoked; a failure
 * after it, before its keys are kept, revokes it too.
 */
function InApp({
  onApproved,
}: {
  onApproved: (done: { name: string; warning: string | null; agentId: IdentityId }) => void;
}) {
  const ctx = useClient();
  const queryClient = useQueryClient();
  const withReauth = useReauth();
  const form = useAgentForm();
  const { picks, trimmed, check } = form;
  const [step, setStep] = useState<ApprovalStep | null>(null);
  const { busy, error, run } = useAction(agentMessage);
  const env = { satisfies: requirementsHere(), ctx };

  const create = () =>
    run(async () => {
      try {
        await withReauth(async () => {
          setStep({ kind: 'approving' });
          const enrollment = await appAgentOperations.beginLocalEnrollment(ctx);
          const { claim } = enrollment;
          let warning: string | null = null;
          try {
            await runCommand(
              approveAgent,
              {
                claim,
                comparedFingerprint: claim.fingerprint,
                name: trimmed,
                renameRevoked:
                  check.kind === 'revoked' ? { agentId: check.agentId, name: check.rename } : null,
                picks,
              },
              { ...env, onStep: setStep },
            );
          } catch (caught) {
            if (!(caught instanceof PartlyDone)) {
              await appAgentOperations.abandonLocalEnrollment(ctx, enrollment).catch(() => {});
              throw caught;
            }
            warning = caught.message;
          }
          await appAgentOperations.finishLocalEnrollment(ctx, enrollment);
          onApproved({ name: trimmed, warning, agentId: claim.agent.id });
        });
      } finally {
        setStep(null);
        await refreshAccess(queryClient, ctx);
      }
    });

  const stepText = approvalStepText(step, picks);
  return (
    <div className="flex min-h-0 flex-col gap-3">
      <DialogHeader>
        <DialogTitle>Add a chat assistant</DialogTitle>
        <DialogDescription>
          An assistant works in the page chat as an agent with its own keys, only in the folders you
          pick, and never does more than you can there. This app makes its keys and enrolls it
          itself, so there’s no code to enter.
        </DialogDescription>
      </DialogHeader>
      <NameAndPicks form={form} busy={busy} placeholder="For example, Helper" />
      {stepText && (
        <p role="status" className="text-sm font-bold">
          {stepText} Keep this open until it’s done.
        </p>
      )}
      <ErrorLine error={error} />
      <DialogFooter>
        <Button disabled={busy || !trimmed || check.kind === 'taken'} onClick={() => void create()}>
          Add assistant
        </Button>
      </DialogFooter>
    </div>
  );
}

/** The agent's name and picks, as the person fills them in. */
function useAgentForm() {
  const ctx = useClient();
  const [name, setName] = useState('');
  const [picks, setPicks] = useState<ChosenPick[]>([]);
  const trimmed = name.trim();
  return {
    name,
    setName,
    picks,
    setPicks,
    trimmed,
    check: checkAgentName(trimmed, listedAgents(ctx)),
  };
}
type AgentForm = ReturnType<typeof useAgentForm>;

/** What an approval is doing now, for the person to wait for. */
function approvalStepText(step: ApprovalStep | null, picks: readonly ChosenPick[]) {
  if (!step) return null;
  if (step.kind === 'approving') return 'Approving, and sealing keys to the agent…';
  const pick = picks.find((p) => p.spaceId === step.spaceId && p.folderId === step.folderId);
  return `Making “${plainText(pickPath(pick ?? { path: [] }))}” a share…`;
}

/** Name the agent and pick what it can reach. */
function NameAndPicks({
  form: { name, setName, picks, setPicks, trimmed, check },
  busy,
  placeholder = 'For example, laptop notes',
}: {
  form: AgentForm;
  busy: boolean;
  placeholder?: string;
}) {
  const [addingPick, setAddingPick] = useState(false);
  // Two picks that become shares, one inside the other: only the outer is kept.
  const [merged, setMerged] = useState<{ inner: ChosenPick; outer: ChosenPick } | null>(null);
  // Focus goes back to Add a folder once the form it opened closes.
  const addButton = useRef<HTMLButtonElement>(null);
  const wasAdding = useRef(false);
  useEffect(() => {
    if (wasAdding.current && !addingPick) addButton.current?.focus();
    wasAdding.current = addingPick;
  }, [addingPick]);
  return (
    <div className="-mx-1 grid min-h-0 grid-cols-1 gap-4 overflow-y-auto border-y px-1 py-3">
      <div className="grid gap-2">
        <Label htmlFor="agent-name">Name the agent</Label>
        <Input
          id="agent-name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          maxLength={MAX_AGENT_NAME}
          placeholder={placeholder}
          disabled={busy}
          autoComplete="off"
        />
        {trimmed && check.kind === 'taken' && (
          <p className="text-sm text-destructive">Another of your agents has that name.</p>
        )}
        {trimmed && check.kind === 'revoked' && (
          <p className="text-sm text-muted-foreground">
            A revoked agent had this name. It will be renamed “<Name>{check.rename}</Name>”.
          </p>
        )}
      </div>
      <section aria-labelledby="picks-heading" className="grid grid-cols-1 gap-2">
        <h3 id="picks-heading" className="text-sm font-bold text-subtle-foreground">
          What it can reach
        </h3>
        <ChosenPicks
          picks={picks}
          disabled={busy}
          onRemove={(pick) => {
            setPicks((all) => all.filter((p) => p !== pick));
            setMerged(null);
          }}
        />
        {merged && (
          <p role="status" className="text-sm text-muted-foreground">
            “<Name>{pickPath(merged.inner)}</Name>” is inside “<Name>{pickPath(merged.outer)}</Name>
            ”, which becomes one share, so the agent reaches it there, as{' '}
            {ACCESS_LABELS[accessOf(merged.outer)]}.
          </p>
        )}
        {addingPick ? (
          <div className="grid gap-2">
            <PickForm
              disabled={busy}
              onPick={(pick) => {
                const next = withPick(picks, pick);
                setPicks(next.picks);
                setMerged(next.merged);
                setAddingPick(false);
              }}
            />
            <div>
              <Button size="sm" variant="ghost" onClick={() => setAddingPick(false)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <div>
            <Button
              ref={addButton}
              size="sm"
              variant="secondary"
              disabled={busy}
              onClick={() => setAddingPick(true)}
            >
              <Plus strokeWidth={1.75} /> Add a folder
            </Button>
          </div>
        )}
        <p className="text-xs text-muted-foreground">
          It can never do more than you can there. You can change this later.
        </p>
      </section>
    </div>
  );
}

/** The picks so far, each with its access and a way to take it off. */
export function ChosenPicks({
  picks,
  disabled,
  onRemove,
}: {
  picks: readonly ChosenPick[];
  disabled: boolean;
  onRemove: (pick: ChosenPick) => void;
}) {
  if (picks.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        Nothing yet. Without a folder, the agent can only check who it is.
      </p>
    );
  }
  return (
    <ul className="grid grid-cols-1 gap-1">
      {picks.map((pick) => {
        const label = pickPath(pick);
        return (
          <li
            key={`${pick.spaceId}:${pick.folderId ?? ''}`}
            className="flex items-center gap-2 rounded-row bg-muted px-3 py-1.5 text-sm"
          >
            <span className="min-w-0 flex-1 truncate font-bold">
              <Name>{label}</Name>
              {pick.newShare && (
                <span className="font-normal text-muted-foreground"> · becomes a share</span>
              )}
            </span>
            <span className="text-muted-foreground">{ACCESS_LABELS[accessOf(pick)]}</span>
            <button
              type="button"
              aria-label={`Remove ${plainText(label)}`}
              disabled={disabled}
              onClick={() => onRemove(pick)}
              className="grid size-7 place-items-center rounded-control enabled:hover:tint enabled:active:tint-strong disabled:opacity-50"
            >
              <X className="size-4" strokeWidth={1.75} />
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function Approved({
  name,
  warning,
  inApp,
  onClose,
}: {
  name: string;
  warning: string | null;
  inApp: boolean;
  onClose: () => void;
}) {
  return (
    <div className="grid gap-4">
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <Bot className="size-5 text-primary" strokeWidth={1.75} />
          <span>
            <Name>{name}</Name> is approved
          </span>
        </DialogTitle>
        <DialogDescription>
          {inApp
            ? 'It’s ready to use in the page chat.'
            : 'The CLI collects its credential on its next check and finishes by itself.'}
        </DialogDescription>
      </DialogHeader>
      {warning && (
        <p role="alert" className="text-sm text-destructive">
          {warning}
        </p>
      )}
      <DialogFooter>
        <Button autoFocus onClick={onClose}>
          Done
        </Button>
      </DialogFooter>
    </div>
  );
}
