import { groupOperations, isAgentId, type ShareId, type SpaceId } from '@wikistow/client';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState, type ReactNode } from 'react';
import { Name } from '@/components/name';
import { Button } from '@/components/ui/button';
import { DialogFooter } from '@/components/ui/dialog';
import { treeQuery } from '../data/queries';
import { useClient } from '../vault/store';
import { isStale } from './messages';
import { ACCESS_LABELS, accessOf } from './model';
import { nameOf, shareNameById } from './names';
import { describePerson, peopleQuery } from './people';
import { NewMark } from './new-mark';
import { ErrorLine, useAction } from './use-action';

type SpaceGroups = groupOperations.SpaceGroups;
type GroupChange = groupOperations.GroupChange;

/** What a group is called, to its space's owners. */
export const groupName = (group: groupOperations.Group): string =>
  nameOf(group.name) ?? 'Unreadable group';

/** A group's people. Its agents are left to their person (section 9.4). */
export const peopleIn = (group: groupOperations.Group) =>
  group.members.filter((m) => !isAgentId(m.identity.id));

/**
 * Where someone's access in a share comes from, as the access list says
 * it: "direct", "via Family", or with each access when there are several.
 */
export function sourcesText(state: SpaceGroups, sources: groupOperations.AccessSource[]): string {
  const from = (source: groupOperations.AccessSource) => {
    if (source.kind === 'direct') return 'direct';
    const group = state.groups.find((g) => g.groupId === source.groupId);
    return `via ${group ? groupName(group) : 'a group'}`;
  };
  if (sources.length === 1 && sources[0]) return from(sources[0]);
  return sources.map((s) => `${ACCESS_LABELS[accessOf(s)]} ${from(s)}`).join(' · ');
}

/** Readers get every publication kept, editors every draft too (protocol section 7.3). */
export const HISTORY_NOTICE =
  'Readers get every published version kept there, older ones included, but no drafts. Editors also get every draft.';

/**
 * What a change leaves each of `personIds` with in each of `shareIds`, by
 * folder: their access and where it comes from, whether keys are sealed to
 * them now, whether they wait, or that they have no access left.
 */
export function ChangeReview({
  spaceId,
  change,
  shareIds,
  personIds,
}: {
  spaceId: SpaceId;
  change: GroupChange;
  shareIds: readonly ShareId[];
  personIds: readonly string[];
}) {
  const ctx = useClient();
  const { data: tree } = useQuery(treeQuery(ctx, spaceId));
  const { data: people } = useQuery(peopleQuery(ctx, personIds));
  const person = (id: string) => people?.get(id) ?? describePerson(ctx, id, null);
  const { after } = change;
  const listed = shareIds.filter((id) => after.shares.some((s) => s.shareId === id));
  if (listed.length === 0 || personIds.length === 0) return null;
  return (
    <div className="grid max-h-[40vh] gap-3 overflow-y-auto">
      {listed.map((shareId) => {
        const access = groupOperations.shareAccess(after, shareId);
        return (
          <section key={shareId} className="grid gap-1">
            <h4 className="text-sm font-bold text-subtle-foreground">
              <Name>{shareNameById(tree, shareId)}</Name>
            </h4>
            <ul className="grid gap-1 text-sm">
              {personIds.map((id) => {
                const who = person(id);
                const now = access.people.find((p) => p.identityId === id);
                const sealed = change.seals.some(
                  (s) => s.person.identity.id === id && s.shares.some((h) => h.shareId === shareId),
                );
                const waits = change.waits.some(
                  (w) => w.person.identity.id === id && w.shareIds.includes(shareId),
                );
                return (
                  <li key={id} className="flex flex-wrap items-center justify-between gap-x-2">
                    <span className="flex min-w-0 items-center gap-1.5">
                      <span className="truncate">
                        <Name>{who.name}</Name>
                      </span>
                      {who.status === 'new' && (
                        <span className="shrink-0">
                          <NewMark />
                        </span>
                      )}
                    </span>
                    {now ? (
                      <span className="text-muted-foreground">
                        {ACCESS_LABELS[accessOf(now.access)]} · {sourcesText(after, now.sources)}
                        {sealed && ', gets the keys now'}
                        {waits && (
                          <span className="text-destructive">
                            , waits: their key changed and you haven’t confirmed it
                          </span>
                        )}
                      </span>
                    ) : (
                      <span className="text-destructive">No access</span>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

/**
 * Confirm a change that gives access (protocol section 7.8): adding a
 * member, sharing with a group or raising its access, or Give access.
 * `make` works it out when shown, and again if access changed meanwhile;
 * `review` shows what it gives, and nothing is sealed until the owner
 * confirms.
 */
export function GrantConfirm({
  title,
  confirmLabel,
  make,
  review,
  apply,
  onCancel,
  onDone,
}: {
  title: ReactNode;
  confirmLabel: string;
  make: () => Promise<GroupChange>;
  review: (change: GroupChange) => ReactNode;
  apply: (change: GroupChange) => Promise<void>;
  onCancel: () => void;
  onDone: () => Promise<void> | void;
}) {
  const [change, setChange] = useState<GroupChange | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const { busy, error, run } = useAction();
  // Worked out once when shown; again only if access changed meanwhile.
  useEffect(() => {
    void run(async () => setChange(await make()));
  }, []);

  const confirm = (current: GroupChange) =>
    run(async () => {
      setSending(true);
      try {
        await apply(current);
      } catch (caught) {
        if (!isStale(caught)) throw caught;
        setChange(await make());
        setNotice('Access changed meanwhile. Check the list again, then confirm again.');
        return;
      } finally {
        setSending(false);
      }
      await onDone();
    });

  return (
    <div className="grid gap-4">
      <h3 className="font-extrabold">{title}</h3>
      {notice && (
        <p role="status" className="text-sm font-bold">
          {notice}
        </p>
      )}
      {!change && !error && <p className="text-sm text-muted-foreground">Working it out…</p>}
      {change && review(change)}
      {change && change.seals.length > 0 && (
        <p className="rounded-control bg-muted p-3 text-sm">{HISTORY_NOTICE}</p>
      )}
      {sending && (
        <p role="status" className="text-sm font-bold">
          Sealing keys… Keep this open until it’s done.
        </p>
      )}
      <ErrorLine error={error} />
      <DialogFooter>
        <Button variant="ghost" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
        <Button disabled={busy || !change} onClick={() => change && void confirm(change)}>
          {confirmLabel}
        </Button>
      </DialogFooter>
    </div>
  );
}

/**
 * "Waiting for keys", beside someone whose access asks for keys no owner's
 * app has sealed to them yet (section 7.9): they can't open those folders.
 */
export function WaitingMark() {
  return (
    <span className="inline-block rounded-full bg-muted px-1.5 text-[11px] font-bold whitespace-nowrap text-muted-foreground inset-ring inset-ring-foreground/15">
      Waiting for keys
    </span>
  );
}
