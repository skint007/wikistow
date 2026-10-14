import { sharingOperations, type FolderId, type SpaceId } from '@wikistow/client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FileText, Folder } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Name } from '@/components/name';
import { Button } from '@/components/ui/button';
import { DialogFooter } from '@/components/ui/dialog';
import { runCommand } from '../commands/command';
import { createShare } from '../commands/sharing-commands';
import { refreshAccess } from '../data/queries';
import { pageTitle } from '../shell/sidebar';
import { PLAIN, useClient } from '../vault/store';
import { useOwnerRequirements } from './owner-standing';
import type { KeyOutcome } from './key-change';
import { sharingMessage } from './messages';
import { ACCESS_LABELS, grantOf, historyNotice } from './model';
import { nameOf } from './names';
import type { Person } from './people';
import { PersonFinder, type Found } from './person-finder';
import { NewMark } from './new-mark';
import { ErrorLine, useAction } from './use-action';

type Preview = sharingOperations.SharePreview;

/**
 * The first share of a folder or space (protocol sections 6.7 and 7.3):
 * find a person, look over everything that will be shared with them, then
 * share. Milestone 1 spaces take the same path. Once shared, the dialog
 * shows the access list.
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
  const [found, setFound] = useState<Found | null>(null);
  if (!found) {
    return (
      <PersonFinder
        submitLabel="Next"
        review={review}
        exclude={(person) =>
          ownerIds.has(person.id) ? (
            <>
              <Name>{person.name}</Name> owns this space and has access already.
            </>
          ) : null
        }
        onFound={setFound}
      />
    );
  }
  return (
    <ConfirmShare spaceId={spaceId} rootId={rootId} found={found} onBack={() => setFound(null)} />
  );
}

function ConfirmShare({
  spaceId,
  rootId,
  found,
  onBack,
}: {
  spaceId: SpaceId;
  rootId: FolderId | null;
  found: Found;
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
  const { person, access } = found;
  const unreadable = preview.data ? unreadableIn(preview.data) : 0;

  const share = (shown: Preview) =>
    run(async () => {
      setRecords(0);
      try {
        await runCommand(
          createShare,
          { preview: shown, people: [{ person: person.entry, ...grantOf(access) }] },
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
      <p className="text-sm">
        Share with{' '}
        <strong>
          <Name>{person.name}</Name>
        </strong>
        {person.email && (
          <span className="text-muted-foreground">
            {' '}
            (<Name>{person.email}</Name>)
          </span>
        )}{' '}
        as <strong>{ACCESS_LABELS[access]}</strong>. {person.status === 'new' && <NewMark />}
      </p>
      <p className="rounded-control bg-muted p-3 text-sm">
        <Name>{person.name}</Name> {historyNotice(access)}
      </p>
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
          Check this list: anything in it becomes readable to <Name>{person.name}</Name>. Owners of
          the space always have access.
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
