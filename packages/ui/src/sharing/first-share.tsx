import { groupOperations, sharingOperations, type FolderId, type SpaceId } from '@wikistow/client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FileText, Folder } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Name } from '@/components/name';
import { Button } from '@/components/ui/button';
import { DialogFooter } from '@/components/ui/dialog';
import { runCommand } from '../commands/command';
import { createShare } from '../commands/sharing-commands';
import { groupsQuery, refreshAccess } from '../data/queries';
import { pageTitle } from '../shell/sidebar';
import { PLAIN, useClient } from '../vault/store';
import { useOwnerRequirements } from './owner-standing';
import type { KeyOutcome } from './key-change';
import { sharingMessage } from './messages';
import { groupName, HISTORY_NOTICE, peopleIn } from './groups';
import { ACCESS_LABELS, grantOf, historyNotice, type Access } from './model';
import { nameOf } from './names';
import { describePerson, type Person } from './people';
import { PersonFinder, type Found } from './person-finder';
import { NewMark } from './new-mark';
import { ErrorLine, useAction } from './use-action';

type Preview = sharingOperations.SharePreview;

/** Who the first share is with: a person, or one of the space's groups. */
type Chosen =
  | { kind: 'person'; found: Found }
  | { kind: 'group'; group: groupOperations.Group; access: Access };

/**
 * The first share of a folder or space (protocol sections 6.7 and 7.3):
 * find a person or pick a group, look over everything that will be shared
 * with them, then share. Milestone 1 spaces take the same path. Once
 * shared, the dialog shows the access list.
 */
export function FirstShare({
  spaceId,
  rootId,
  ownerIds,
  review,
}: {
  spaceId: SpaceId;
  rootId: FolderId | null;
  ownerIds: ReadonlySet<string>;
  review: (person: Person) => Promise<KeyOutcome>;
}) {
  const ctx = useClient();
  const { data: groups } = useQuery(groupsQuery(ctx, spaceId));
  const [chosen, setChosen] = useState<Chosen | null>(null);
  if (!chosen) {
    return (
      <PersonFinder
        submitLabel="Next"
        review={review}
        groups={
          groups?.groups
            .filter((g) => g.name)
            .map((g) => ({ groupId: g.groupId, name: groupName(g), people: peopleIn(g).length })) ??
          []
        }
        onGroup={(groupId, access) => {
          const group = groups?.groups.find((g) => g.groupId === groupId);
          if (group) setChosen({ kind: 'group', group, access });
        }}
        exclude={(person) =>
          ownerIds.has(person.id) ? (
            <>
              <Name>{person.name}</Name> owns this space and has access already.
            </>
          ) : null
        }
        onFound={(found) => setChosen({ kind: 'person', found })}
      />
    );
  }
  return (
    <ConfirmShare
      spaceId={spaceId}
      rootId={rootId}
      chosen={chosen}
      onBack={() => setChosen(null)}
    />
  );
}

/**
 * A group's people as the preview lists them, by label, each marked if
 * they would wait for keys: their key changed and nobody confirmed it.
 */
function GroupPeople({ group }: { group: groupOperations.Group }) {
  const ctx = useClient();
  const members = peopleIn(group);
  if (members.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No one is in it yet. Everyone you add to it later gets this folder.
      </p>
    );
  }
  return (
    <ul className="grid gap-1 text-sm">
      {members.map((member) => {
        const who = describePerson(ctx, member.identity.id, member);
        const waits = who.status === 'changed' || who.status === 'declined';
        return (
          <li key={who.id} className="flex flex-wrap justify-between gap-x-2">
            <span className="truncate">
              <Name>{who.name}</Name>
            </span>
            {waits && (
              <span className="text-destructive">
                Waits: their key changed and you haven’t confirmed it
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function ConfirmShare({
  spaceId,
  rootId,
  chosen,
  onBack,
}: {
  spaceId: SpaceId;
  rootId: FolderId | null;
  chosen: Chosen;
  onBack: () => void;
}) {
  const ctx = useClient();
  const satisfies = useOwnerRequirements(spaceId);
  const queryClient = useQueryClient();
  const { busy, error, run } = useAction();
  const [records, setRecords] = useState<number | null>(null);
  // Looked over afresh every time: it is what the owner confirms.
  const preview = useQuery({
    queryKey: [PLAIN, 'share-preview', spaceId, rootId],
    queryFn: () => sharingOperations.previewShare(ctx, { spaceId, rootId }),
    staleTime: 0,
    gcTime: 0,
  });
  const access = chosen.kind === 'person' ? chosen.found.access : chosen.access;
  // Who gets it, as the preview's last line names them.
  const whom = chosen.kind === 'person' ? chosen.found.person.name : groupName(chosen.group);
  const unreadable = preview.data ? unreadableIn(preview.data) : 0;

  const share = (shown: Preview) =>
    run(async () => {
      setRecords(0);
      try {
        await runCommand(
          createShare,
          chosen.kind === 'person'
            ? {
                preview: shown,
                people: [{ person: chosen.found.person.entry, ...grantOf(access) }],
              }
            : { preview: shown, groups: [{ groupId: chosen.group.groupId, ...grantOf(access) }] },
          {
            satisfies,
            ctx,
            onProgress: ({ records: done }) => setRecords(done),
          },
        );
      } finally {
        setRecords(null);
      }
      await refreshAccess(queryClient, ctx);
    });

  return (
    <div className="grid gap-4">
      {chosen.kind === 'person' ? (
        <>
          <p className="text-sm">
            Share with{' '}
            <strong>
              <Name>{chosen.found.person.name}</Name>
            </strong>
            {chosen.found.person.email && (
              <span className="text-muted-foreground">
                {' '}
                (<Name>{chosen.found.person.email}</Name>)
              </span>
            )}{' '}
            as <strong>{ACCESS_LABELS[access]}</strong>.{' '}
            {chosen.found.person.status === 'new' && <NewMark />}
          </p>
          <p className="rounded-control bg-muted p-3 text-sm">
            <Name>{chosen.found.person.name}</Name> {historyNotice(access)}
          </p>
        </>
      ) : (
        <>
          <p className="text-sm">
            Share with the group{' '}
            <strong>
              <Name>{groupName(chosen.group)}</Name>
            </strong>{' '}
            as <strong>{ACCESS_LABELS[access]}</strong>.
          </p>
          <section aria-label="Who gets it" className="grid gap-2">
            <h3 className="text-sm font-bold text-subtle-foreground">Who gets it</h3>
            <GroupPeople group={chosen.group} />
          </section>
          <p className="rounded-control bg-muted p-3 text-sm">{HISTORY_NOTICE}</p>
        </>
      )}
      <section aria-label="What will be shared" className="grid gap-2">
        <h3 className="text-sm font-bold text-subtle-foreground">What will be shared</h3>
        {preview.error && <ErrorLine error={sharingMessage(preview.error)} />}
        {preview.data ? (
          <PreviewTree preview={preview.data} />
        ) : (
          !preview.error && <p className="text-sm text-muted-foreground">Listing…</p>
        )}
        {unreadable > 0 && (
          <p role="alert" className="text-sm text-destructive">
            This app can’t read {unreadable === 1 ? 'one item' : `${unreadable} items`} here, so it
            won’t share this folder: you’d be sharing something you can’t check. Delete or move{' '}
            {unreadable === 1 ? 'it' : 'them'} first.
          </p>
        )}
        <p className="text-xs text-muted-foreground">
          Check this list: anything in it becomes readable to <Name>{whom}</Name>. Owners of the
          space always have access.
        </p>
      </section>
      {records !== null && (
        <p role="status" className="text-sm font-bold">
          Sharing… {records} {records === 1 ? 'version' : 'versions'} done
        </p>
      )}
      <ErrorLine error={error} />
      <DialogFooter>
        <Button variant="ghost" disabled={busy} onClick={onBack}>
          Back
        </Button>
        <Button
          disabled={busy || !preview.data || unreadable > 0}
          onClick={() => preview.data && void share(preview.data)}
        >
          Share
        </Button>
      </DialogFooter>
    </div>
  );
}

// Folders with a name this app couldn't open, and pages with no title it could read.
const unreadableIn = ({ folders, pages }: Preview) =>
  folders.filter((f) => nameOf(f.metadata) === null).length +
  pages.filter((p) => p.title === null).length;

/** The previewed folders and pages, nested as the server's tree has them. */
export function PreviewTree({ preview }: { preview: Preview }) {
  const { rootId, folders, pages } = preview;
  const walk = (parentId: string | null, depth: number): ReactNode[] => [
    ...folders
      .filter((f) => f.parentId === parentId && f.id !== rootId)
      .map((f) => (
        <li key={f.id} className="grid gap-1">
          <Item depth={depth} kind="folder" name={nameOf(f.metadata)} />
          <ul className="grid gap-1">{walk(f.id, depth + 1)}</ul>
        </li>
      )),
    ...pages
      .filter((p) => p.parentId === parentId)
      .map((p) => (
        <li key={p.id}>
          <Item depth={depth} kind="page" name={p.title === null ? null : pageTitle(p.title)} />
        </li>
      )),
  ];
  const root = rootId === null ? null : folders.find((f) => f.id === rootId);
  const items = walk(rootId, root ? 1 : 0);
  return (
    <ul className="grid max-h-56 gap-1 overflow-y-auto rounded-control border p-2 text-sm">
      {root && (
        <li>
          <Item depth={0} kind="folder" name={nameOf(root.metadata)} />
        </li>
      )}
      {items}
      {!root && items.length === 0 && <li className="text-muted-foreground">Nothing yet.</li>}
    </ul>
  );
}

function Item({
  depth,
  kind,
  name,
}: {
  depth: number;
  kind: 'folder' | 'page';
  name: string | null;
}) {
  const Icon = kind === 'folder' ? Folder : FileText;
  return (
    <span className="flex items-center gap-1.5" style={{ paddingLeft: `${depth * 16}px` }}>
      <Icon className="size-3.5 shrink-0 text-muted-foreground" strokeWidth={1.75} />
      {name !== null ? (
        <Name>{name}</Name>
      ) : (
        <span className="font-bold text-destructive">
          {kind === 'folder' ? 'Unreadable folder' : 'Unreadable page'}
        </span>
      )}
    </span>
  );
}
