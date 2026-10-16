import { agentOperations, type FolderId, type ShareId, type SpaceId } from '@wikistow/client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot, Plus, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Name, plainText } from '@/components/name';
import { Button } from '@/components/ui/button';
import { runCommand } from '../commands/command';
import { pickForAgent, removeAgentPick } from '../commands/agent-commands';
import { requirementsHere } from '../commands/ui-commands';
import { agentGroupsQuery, refreshAccess, treeQuery } from '../data/queries';
import { ACCESS_LABELS, accessChange, accessOf, grantOf, type Access } from '../sharing/model';
import { nameOf, shareName } from '../sharing/names';
import { useOwnerStanding } from '../sharing/owner-standing';
import { RotateKeysDialog } from '../sharing/rotate-keys-dialog';
import { AccessSelect } from '../sharing/person-finder';
import { ErrorLine, useAction } from '../sharing/use-action';
import { useClient } from '../vault/store';
import { AgentGroups } from './agent-groups';
import { ownAgentName } from './agent-name';
import { pickPath } from './add-agent-dialog';
import { agentMessage, RecordAhead } from './messages';
import {
  accessIn,
  accessUpTo,
  ago,
  picksOffRecord,
  recordedAccess,
  recordedShares,
  type OffRecord,
} from './model';
import { PickForm, useSpaceNames } from './pick-form';

export type ListedAgent = Awaited<ReturnType<typeof agentOperations.listAgents>>[number];
type Grant = ListedAgent['grants'][number];

const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium' });

/**
 * One of this person's agents: its name from their own record, whether it
 * is live, when it last wrote, and what it can reach, with the controls to
 * change that or revoke it.
 */
export function AgentCard({ agent, onRevoke }: { agent: ListedAgent; onRevoke: () => void }) {
  const ctx = useClient();
  const queryClient = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [notice, setNotice] = useState<ReactNode>(null);
  const card = useRef<HTMLLIElement>(null);
  const noticeLine = useRef<HTMLParagraphElement>(null);
  // An action that took away the control it started from (a removed folder,
  // the closed add form) leaves focus nowhere: it goes to what happened.
  useEffect(() => {
    if (notice && !card.current?.contains(document.activeElement)) noticeLine.current?.focus();
  }, [notice, adding]);
  const [rotating, setRotating] = useState<{ spaceId: SpaceId; shareId: ShareId } | null>(null);
  const { busy, error, setError, run } = useAction(agentMessage);
  const name = ownAgentName(ctx, agent.agentId) ?? agent.name;
  const offRecord = new Map(
    picksOffRecord([agent], ctx.contacts.book.payloads.shared.agents).map((p) => [p.shareId, p]),
  );
  const live = agent.revokedAt === null;
  const { agentId } = agent;
  const { data: allGroups } = useQuery({ ...agentGroupsQuery(ctx), enabled: live });
  const groups = allGroups?.filter((group) => group.agentId === agentId) ?? [];
  const env = { satisfies: requirementsHere(), ctx };
  const recorded = () => recordedShares(ctx.contacts.book.payloads.shared.agents, agentId);
  // Each change writes the record first, then calls the server; a failure
  // in between leaves the record ahead, which the card says.
  const act = (action: () => Promise<void>, message: ReactNode, repair = true) =>
    run(async () => {
      setNotice(null);
      const before = recorded();
      try {
        await action();
      } catch (error) {
        throw recorded() === before ? error : new RecordAhead(repair, error);
      }
      await refreshAccess(queryClient, ctx);
      setNotice(message);
    });

  return (
    <li ref={card} aria-label={plainText(name)} className="grid gap-3 rounded-control border p-4">
      <div className="flex flex-wrap items-center gap-3">
        <span
          aria-hidden
          className="grid size-10 shrink-0 place-items-center rounded-tile bg-primary-soft text-primary"
        >
          <Bot className="size-5" strokeWidth={1.75} />
        </span>
        <span className="grid min-w-0 flex-1">
          <span className="truncate font-extrabold">
            <Name>{name}</Name>
          </span>
          <span className="text-sm text-muted-foreground">
            Enrolled {day(agent.enrolledAt)} ·{' '}
            {agent.lastEditAt ? `last edit ${ago(agent.lastEditAt, new Date())}` : 'no edits yet'}
          </span>
        </span>
        <span
          className={
            live
              ? 'rounded-full bg-status-published px-2.5 py-[3px] text-[12.5px] font-bold text-status-published-foreground'
              : 'rounded-full bg-muted px-2.5 py-[3px] text-[12.5px] font-bold text-muted-foreground'
          }
        >
          {live ? 'Live' : `Revoked ${day(agent.revokedAt ?? agent.enrolledAt)}`}
        </span>
        {live && (
          <Button size="sm" variant="outline" className="text-destructive" onClick={onRevoke}>
            Revoke
          </Button>
        )}
      </div>
      {live && (
        <section aria-label={`What ${plainText(name)} can reach`} className="grid gap-2">
          {agent.grants.length === 0 ? (
            !groups.some((group) => group.confirmed) && (
              <p className="text-sm text-muted-foreground">
                Nothing yet: it can only check who it is.
              </p>
            )
          ) : (
            <ul className="grid gap-1">
              {agent.grants.map((grant) => (
                <GrantRow
                  key={grant.shareId}
                  grant={grant}
                  offRecord={offRecord.get(grant.shareId)}
                  disabled={busy}
                  onChange={(to, from, label, folderId, setBack) =>
                    act(
                      () =>
                        runCommand(
                          pickForAgent,
                          {
                            agentId,
                            pick: {
                              spaceId: grant.spaceId,
                              shareId: grant.shareId,
                              folderId,
                              ...grantOf(to),
                              newShare: false,
                            },
                          },
                          env,
                        ),
                      setBack ? (
                        <>
                          “<Name>{label}</Name>” is back to {ACCESS_LABELS[to]}, as your record
                          allows.
                        </>
                      ) : accessChange(from, to).kind === 'demote' ? (
                        <Demoted
                          spaceId={grant.spaceId}
                          label={label}
                          onRotate={() =>
                            setRotating({ spaceId: grant.spaceId, shareId: grant.shareId })
                          }
                        />
                      ) : (
                        <>
                          Access to “<Name>{label}</Name>” changed.
                        </>
                      ),
                    )
                  }
                  onRemove={(label, unrecorded) =>
                    act(
                      () =>
                        runCommand(
                          removeAgentPick,
                          { agentId, spaceId: grant.spaceId, shareId: grant.shareId },
                          env,
                        ),
                      unrecorded ? (
                        <>
                          The server no longer lists “<Name>{label}</Name>” for it, as your record
                          says.
                        </>
                      ) : (
                        <>
                          “<Name>{label}</Name>” is no longer its to reach. It keeps the keys it
                          had; the folder’s owners will be offered new ones.
                        </>
                      ),
                    )
                  }
                />
              ))}
            </ul>
          )}
          {notice && (
            <p
              ref={noticeLine}
              role="status"
              tabIndex={-1}
              className="text-sm font-bold outline-none"
            >
              {notice}
            </p>
          )}
          <ErrorLine error={error} />
          {adding ? (
            <div className="grid gap-2">
              <PickForm
                submitLabel="Give access"
                disabled={busy}
                onPick={(pick) =>
                  void act(
                    () => runCommand(pickForAgent, { agentId, pick }, env),
                    <>
                      It can reach “<Name>{pickPath(pick)}</Name>” now.
                    </>,
                    false,
                  ).then((ok) => ok && setAdding(false))
                }
              />
              <div>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => setAdding(false)}
                >
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <div>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  setError(null);
                  setAdding(true);
                }}
              >
                <Plus strokeWidth={1.75} /> Add a folder
              </Button>
            </div>
          )}
        </section>
      )}
      {live && <AgentGroups agentId={agentId} groups={groups} />}
      {rotating && (
        <RotateKeysDialog
          spaceId={rotating.spaceId}
          shareId={rotating.shareId}
          onClose={() => setRotating(null)}
        />
      )}
    </li>
  );
}

/**
 * After a change to reader: the agent keeps the draft keys it had (A6).
 * An owner of the space can rotate them right here; anyone else is told to
 * ask the owners, who aren't told of a demotion (protocol section 17, Q10).
 */
function Demoted({
  spaceId,
  label,
  onRotate,
}: {
  spaceId: SpaceId;
  label: string;
  onRotate: () => void;
}) {
  const owner = useOwnerStanding(spaceId) === 'owner';
  return (
    <span className="flex flex-wrap items-center gap-2">
      <span className="min-w-0 flex-1">
        It reads “<Name>{label}</Name>” only now. It keeps the drafts it could already read.{' '}
        {owner
          ? 'Rotate the folder’s keys so it can’t read drafts saved from now on.'
          : 'Ask the folder’s owners to rotate its keys if that matters.'}
      </span>
      {owner && (
        <Button size="xs" variant="outline" onClick={onRotate}>
          Rotate keys
        </Button>
      )}
    </span>
  );
}

/**
 * One pick: where, with what access (never above this person's), and a way
 * to take it away. A pick the person's own record doesn't back
 * (`offRecord`) says so, and offers only to bring the server in line with
 * the record: remove the access the record doesn't list, or set the role
 * back to the record's. The server's role is never adopted; its folder is
 * kept only inside the listed share, which the client checks.
 */
function GrantRow({
  grant,
  offRecord,
  disabled,
  onChange,
  onRemove,
}: {
  grant: Grant;
  offRecord: OffRecord | undefined;
  disabled: boolean;
  /** `folderId` is the picked folder, or the share's root for a whole share. */
  onChange: (
    to: Access,
    from: Access,
    label: string,
    folderId: FolderId | null,
    setBack: boolean,
  ) => void;
  onRemove: (label: string, unrecorded: boolean) => void;
}) {
  const ctx = useClient();
  const { data: tree } = useQuery(treeQuery(ctx, grant.spaceId));
  const space = useSpaceNames().find((s) => s.spaceId === grant.spaceId)?.name ?? null;
  const share = tree?.shares.find((s) => s.shareId === grant.shareId);
  const label =
    grant.folderId === null
      ? shareName(tree, share?.rootId ?? null)
      : (nameOf(tree?.folders.find((f) => f.id === grant.folderId)?.metadata) ??
        'A folder this app can’t read');
  // What the server lists, which the record may not back.
  const listed = accessOf(grant);
  const max = share ? accessIn(share) : listed;
  const allowed = accessUpTo(max);
  const unrecorded = offRecord?.kind === 'unrecorded';
  const setBack =
    offRecord?.kind === 'role-differs' ? recordedAccess(offRecord.recorded, max) : null;
  const shown = setBack ?? listed;
  // The record names a share, not a folder in it. Its keys open the whole
  // share, so keeping the listed folder narrows only what the server allows.
  const folderId = share ? (grant.folderId ?? share.rootId) : null;
  return (
    <li className="grid gap-1.5 rounded-row bg-muted px-3 py-1.5 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1 truncate">
          <span className="font-bold">
            <Name>{label}</Name>
          </span>
          {/* Folders of the same name in two spaces are told apart. */}
          {space !== null && space !== label && (
            <span className="text-muted-foreground">
              {' '}
              in <Name>{space}</Name>
            </span>
          )}
        </span>
        {unrecorded ? (
          <span className="text-muted-foreground">{ACCESS_LABELS[listed]}, says the server</span>
        ) : (
          <>
            <AccessSelect
              id={`grant-${grant.shareId}`}
              label={`Access to ${plainText(label)}`}
              value={shown}
              allowed={allowed.includes(shown) ? allowed : [...allowed, shown]}
              disabled={disabled || !share}
              onChange={(to) => share && onChange(to, listed, label, folderId, false)}
            />
            <Button
              size="icon"
              variant="ghost"
              aria-label={`Take away ${plainText(label)}`}
              disabled={disabled}
              onClick={() => onRemove(label, false)}
            >
              <Trash2 strokeWidth={1.75} />
            </Button>
          </>
        )}
      </div>
      {offRecord && (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="min-w-0 flex-1 text-muted-foreground">
            {unrecorded
              ? 'The server lists this for it, but your own record doesn’t, so your apps give it no keys here.'
              : `The server lists ${ACCESS_LABELS[listed]} here, but your own record allows ${ACCESS_LABELS[setBack ?? listed]}.`}
          </span>
          {unrecorded ? (
            <Button
              size="xs"
              variant="outline"
              disabled={disabled}
              onClick={() => onRemove(label, true)}
            >
              Remove this access
            </Button>
          ) : (
            setBack &&
            share && (
              <Button
                size="xs"
                variant="outline"
                disabled={disabled}
                onClick={() => onChange(setBack, listed, label, folderId, true)}
              >
                Set back to {ACCESS_LABELS[setBack]}
              </Button>
            )
          )}
        </div>
      )}
    </li>
  );
}
