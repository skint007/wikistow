import { pluginProposalRoutes } from '@wikistow/contracts';
import { queryOptions, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, useSyncExternalStore } from 'react';
import { Name } from '@/components/name';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { FormMessage } from '@/components/layout/auth-card';
import { ago } from '../agents/model';
import { LineDiff, Text } from '../ai/line-diff';
import { api } from '../api';
import { errorMessage } from '../errors';
import { PROPOSALS_KEY, useNewDraft } from './drafts';
import type { Workshop } from './workshop';

/*
 * Plugin proposals (#315): a copy of someone else's plugin, sent back to
 * its owner, who reads what changed by file and opens it as a draft of
 * their own under the plugin's ID, or declines it.
 */

type ProposalSummary = pluginProposalRoutes.ProposalSummary;

/** Proposals for the person's plugins, newest first. */
const proposalsQuery = queryOptions({
  queryKey: PROPOSALS_KEY,
  queryFn: async () => (await api.call(pluginProposalRoutes.listProposals)).proposals,
});

/** Whom a draft would be proposed to, and the proposal sent from it, if any. */
const draftProposalQuery = (draftId: string) =>
  queryOptions({
    queryKey: [...PROPOSALS_KEY, 'draft', draftId],
    queryFn: () => api.call(pluginProposalRoutes.getDraftProposal, { params: { draftId } }),
    // A server from before proposals answers 404: there's nothing to offer.
    retry: false,
  });

/** When something was sent, as a list says it. */
function when(iso: string) {
  const said = ago(iso, new Date());
  if (said === 'just now') return said;
  return /^\d+ (min|h|d)$/.test(said) ? `${said} ago` : `on ${said}`;
}

/**
 * **Propose to *owner*…** on a copy of someone else's plugin: its files go
 * to the plugin's owner, under its ID again, for them to open and publish
 * or decline. Nothing shows on another draft, or on a server without
 * proposals.
 */
export function Propose({ workshop }: { workshop: Workshop }) {
  const queryClient = useQueryClient();
  const { copy, phase } = useSyncExternalStore(workshop.subscribe, workshop.state);
  const query = draftProposalQuery(workshop.draftId);
  const { data } = useQuery({ ...query, enabled: copy !== null });
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!copy || phase !== 'ready' || !data?.to) return null;
  const to = data.to.name;
  const propose = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.call(pluginProposalRoutes.proposeDraft, {
        params: { draftId: workshop.draftId },
        body: {},
      });
      setAsking(false);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
      await queryClient.invalidateQueries({ queryKey: query.queryKey });
    }
  };
  return (
    <section aria-label="Propose" className="grid gap-2">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <p className="flex-1">
          {data.sent ? (
            <>
              {/* One proposal per plugin: it may have gone from another copy draft of it. */}
              You proposed a copy of <strong>{copy.from}</strong> to <Name>{to}</Name>{' '}
              {when(data.sent.createdAt)}. Proposing again sends this draft’s files as they are now,
              in its place.
            </>
          ) : (
            <>
              A copy of <Name>{to}</Name>’s <strong>{copy.from}</strong>. Propose your changes to
              them, and they can publish them as a new version of it.
            </>
          )}
        </p>
        <Button size="sm" variant="outline" onClick={() => setAsking(true)}>
          {data.sent ? (
            'Propose again…'
          ) : (
            // One span: the button spaces out each child.
            <span>
              Propose to <Name>{to}</Name>…
            </span>
          )}
        </Button>
      </div>
      <Dialog open={asking} onOpenChange={(open) => !open && !busy && setAsking(false)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Propose to <Name>{to}</Name>?
            </DialogTitle>
            <DialogDescription>
              <Name>{to}</Name> gets this draft’s files as they are now, under the ID{' '}
              <strong>{copy.from}</strong> again. They see what you changed, and can open it as a
              draft of their own to publish, or decline it. The conversation, its versions and
              sample pages stay with you.
            </DialogDescription>
          </DialogHeader>
          {error && <FormMessage>{error}</FormMessage>}
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setAsking(false)}>
              Cancel
            </Button>
            <Button disabled={busy} onClick={() => void propose()}>
              Propose
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

/**
 * Proposals for the person's plugins, on the workshop page, each with
 * **Review**. Nothing shows without any, or on a server without proposals.
 */
export function ProposalsList() {
  const { data: proposals } = useQuery({ ...proposalsQuery, retry: false });
  const [reviewing, setReviewing] = useState<ProposalSummary | null>(null);
  // The review stays open while it says why its proposal went, as when declined on another device.
  if ((!proposals || proposals.length === 0) && !reviewing) return null;
  return (
    <section aria-label="Proposals" className="grid gap-3">
      <h2 className="text-sm font-bold">Proposals for your plugins</h2>
      <ul className="grid gap-2">
        {proposals?.map((proposal) => (
          <li
            key={proposal.id}
            aria-label={proposal.name}
            className="flex flex-wrap items-center gap-2 rounded-control border p-3 text-sm"
          >
            <strong className="min-w-0 truncate">
              <Name>{proposal.name}</Name>
            </strong>
            <span className="flex-1 text-xs text-muted-foreground">
              From <Name>{proposal.from.name}</Name>, {when(proposal.createdAt)}
            </span>
            <Button size="sm" variant="outline" onClick={() => setReviewing(proposal)}>
              Review
            </Button>
          </li>
        ))}
      </ul>
      <Review proposal={reviewing} onClose={() => setReviewing(null)} />
    </section>
  );
}

const BASE = {
  newest: 'It starts from your newest version.',
  older:
    'It starts from an older version than your newest, so a version published from it leaves out what you changed since.',
  gone: 'The version it started from is no longer in the library, so every file shows as added.',
} as const;

const CHANGE = { added: 'Added', changed: 'Changed', removed: 'Removed' } as const;

/**
 * One proposal, with what changed by file against the version it started
 * from, and **Decline** or **Open as a draft**, which opens the workshop
 * on it as the person's own draft, asking first at 10 drafts.
 */
function Review({ proposal, onClose }: { proposal: ProposalSummary | null; onClose: () => void }) {
  const queryClient = useQueryClient();
  const newDraft = useNewDraft();
  const { data, error: readError } = useQuery({
    queryKey: [...PROPOSALS_KEY, 'one', proposal?.id],
    queryFn: () =>
      api.call(pluginProposalRoutes.getProposal, {
        params: { proposalId: proposal?.id ?? '' },
      }),
    enabled: proposal !== null,
  });
  const [declining, setDeclining] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = declining || newDraft.busy;
  const close = () => {
    setError(null);
    newDraft.clear();
    onClose();
  };
  const decline = async () => {
    if (!proposal) return;
    setDeclining(true);
    setError(null);
    try {
      await api.call(pluginProposalRoutes.declineProposal, {
        params: { proposalId: proposal.id },
      });
      close();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setDeclining(false);
      await queryClient.invalidateQueries({ queryKey: PROPOSALS_KEY, exact: true });
    }
  };
  const open = async () => {
    if (!proposal) return;
    setError(null);
    if (await newDraft.start({ proposal: proposal.id })) close();
  };
  const shown = newDraft.error ?? error ?? (readError ? errorMessage(readError) : null);
  return (
    <>
      <Dialog open={proposal !== null} onOpenChange={(next) => !next && !busy && close()}>
        <DialogContent
          dialogClassName="max-h-[calc(100dvh-2rem)] open:flex open:flex-col sm:max-w-2xl"
          className="grid min-h-0 gap-4 overflow-y-auto"
          locked={busy}
        >
          <DialogHeader>
            <DialogTitle>
              <Name>{proposal?.name ?? ''}</Name> from <Name>{proposal?.from.name ?? ''}</Name>
            </DialogTitle>
            <DialogDescription>
              A change to your plugin <strong>{proposal?.pluginId}</strong>. Open it as a draft of
              your own to try it in the workshop and publish it, which offers everyone who installed
              the plugin the update, or decline it.
            </DialogDescription>
          </DialogHeader>
          {data && (
            <div className="grid gap-3 text-sm">
              <p className="text-muted-foreground">{BASE[data.base]}</p>
              {data.changes.length === 0 ? (
                <p>It changes no files.</p>
              ) : (
                <ul aria-label="Changed files" className="grid gap-2">
                  {data.changes.map((change) => (
                    <li key={change.path} aria-label={change.path}>
                      <details open={data.changes.length <= 3} className="grid gap-1.5">
                        <summary className="cursor-default">
                          <span className="font-mono text-xs">{change.path}</span>{' '}
                          <span className="text-xs text-muted-foreground">
                            {CHANGE[change.change]}
                          </span>
                        </summary>
                        <FileChange change={change} />
                      </details>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          {shown && <FormMessage>{shown}</FormMessage>}
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => void decline()}>
              Decline
            </Button>
            <Button disabled={busy || !data} onClick={() => void open()}>
              Open as a draft
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {newDraft.dialog}
    </>
  );
}

/** One file's change: a line diff of its text, its text whole, or a font or image's note. */
function FileChange({ change }: { change: pluginProposalRoutes.ProposalChange }) {
  const { before, after } = change;
  if (before !== null && after !== null) return <LineDiff before={before} after={after} />;
  const text = after ?? before;
  if (text !== null) return <Text>{text}</Text>;
  return <p className="text-xs text-muted-foreground">A font or image.</p>;
}
