import {
  publicationOperations,
  type FolderId,
  type PageId,
  type RevisionId,
  type SpaceId,
} from '@wikistow/client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Fragment, useEffect, useId, useMemo, useRef, useState } from 'react';
import { failedToLoad, LoadFailed } from '@/components/load-failed';
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
import { Label } from '@/components/ui/label';
import { Picker } from '@/components/ui/picker';
import { runCommand } from '../commands/command';
import { endPublication, publishElsewhere } from '../commands/page-commands';
import { requirementsHere } from '../commands/ui-commands';
import { searchIndexChanged, sharedWithMeQuery, spacesQuery, treeQuery } from '../data/queries';
import { isStale } from '../sharing/messages';
import { nameOf, type Tree } from '../sharing/names';
import { describePerson, peopleQuery } from '../sharing/people';
import { ErrorLine, HoldOpen, useAction, useHoldOpen } from '../sharing/use-action';
import { PLAIN, useClient } from '../vault/store';
import { READ_BUDGET_MS } from './markdown-worker';
import { pageReader } from './page-reader';
import { publicationMessage } from './messages';
import { publishPlaces, publishSpaces, type PublishPlace } from './publish-model';

/** The version being published: the one on screen, or the one opening the page shows. */
export type Version = { revisionId: RevisionId; audience: 'draft' | 'published' };

type Chosen = { spaceId: SpaceId; spaceName: string; place: PublishPlace<FolderId> };

/**
 * Publish the version of a page the person is looking at, or from the
 * sidebar the one opening it shows, into a page in another space (protocol
 * section 13): choose the space and folder, look over who can read it
 * there, which attachments go and which links readers there can't open,
 * then publish. Opened from the page menu and the page's sidebar menu.
 */
export function PublishDialog({
  page,
  title,
  version,
  open,
  onOpenChange,
}: {
  page: { spaceId: SpaceId; pageId: PageId };
  title: string;
  version: Version;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { locked, hold } = useHoldOpen();
  const [chosen, setChosen] = useState<Chosen | null>(null);
  const [confirming, setConfirming] = useState(false);
  // Where the copy went, once it has.
  const [done, setDone] = useState<{ spaceId: SpaceId; pageId: PageId } | null>(null);
  useEffect(() => {
    if (!open) return;
    setChosen(null);
    setConfirming(false);
    setDone(null);
  }, [open]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent dialogClassName="sm:max-w-xl" locked={locked}>
        <HoldOpen value={hold}>
          <div className="grid gap-4">
            <DialogHeader>
              <DialogTitle>
                Publish “<Name>{title}</Name>” to another space
              </DialogTitle>
              <DialogDescription>
                {version.audience === 'draft'
                  ? 'Copies the draft as it is now, as a published version there.'
                  : 'Copies this published version.'}{' '}
                Later changes here reach it only when you publish to it again.
              </DialogDescription>
            </DialogHeader>
            {done ? (
              <Published to={done} onClose={() => onOpenChange(false)} />
            ) : chosen && confirming ? (
              <ConfirmPublication
                page={page}
                version={version}
                chosen={chosen}
                onBack={() => setConfirming(false)}
                onDone={setDone}
              />
            ) : (
              <ChooseDestination
                sourceSpaceId={page.spaceId}
                chosen={chosen}
                onChoose={(next) => {
                  setChosen(next);
                  setConfirming(true);
                }}
              />
            )}
          </div>
        </HoldOpen>
      </DialogContent>
    </Dialog>
  );
}

const SPACE_GONE = 'The space you picked is no longer available. Choose again.';
const FOLDER_GONE = 'The folder you picked is no longer available. Choose again.';

// Any space but this one, then anywhere there the person can publish.
function ChooseDestination({
  sourceSpaceId,
  chosen,
  onChoose,
}: {
  sourceSpaceId: SpaceId;
  chosen: Chosen | null;
  onChoose: (chosen: Chosen) => void;
}) {
  const ctx = useClient();
  const id = useId();
  const spacesLoad = useQuery(spacesQuery(ctx));
  const sharedLoad = useQuery(sharedWithMeQuery(ctx));
  const spaces = spacesLoad.data;
  const shared = sharedLoad.data;
  const choices = useMemo(
    () =>
      spaces && shared
        ? publishSpaces(
            {
              spaces: spaces.map((s) => ({ id: s.id, name: nameOf(s.metadata) })),
              shared: shared.map((item) => ({
                spaceId: item.share.spaceId,
                rootName: nameOf(item.root),
              })),
            },
            sourceSpaceId,
          )
        : null,
    [spaces, shared, sourceSpaceId],
  );
  // The space picked, by ID. Until the person picks, it is the first one
  // shown, kept once shown, so a space added meanwhile doesn't take its
  // place. If a refetch no longer offers it, nothing is picked until they
  // pick again: "Top of" another space mustn't stand in for the top of this one.
  const [spaceId, setSpaceId] = useState<SpaceId | null>(chosen?.spaceId ?? null);
  const first = choices?.[0];
  useEffect(() => {
    if (spaceId === null && first) setSpaceId(first.spaceId);
  }, [spaceId, first]);
  const space = spaceId === null ? first : choices?.find((c) => c.spaceId === spaceId);
  const treeLoad = useQuery({
    ...treeQuery(ctx, space?.spaceId ?? sourceSpaceId),
    enabled: space !== undefined,
  });
  const tree = treeLoad.data;
  const places = useMemo(
    () =>
      tree && space
        ? publishPlaces({
            space: tree.space && {
              role: tree.space.role,
              canPublish: tree.space.canPublish,
              opened: tree.space.metadata !== null,
            },
            shares: tree.shares,
            folders: tree.folders.map((f) => ({
              id: f.id,
              parentId: f.parentId,
              name: nameOf(f.metadata),
            })),
          })
        : null,
    [tree, space],
  );
  // The place picked, by its folder; until the person picks, the first.
  // If a refetch no longer offers it, nothing is picked until they pick again.
  const [picked, setPicked] = useState<FolderId | null | undefined>(chosen?.place.parentId);
  if (!choices) {
    return failedToLoad(spacesLoad) || failedToLoad(sharedLoad) ? (
      <LoadFailed what="the spaces you can publish to" queries={[spacesLoad, sharedLoad]} />
    ) : (
      <p className="text-sm text-muted-foreground">Loading…</p>
    );
  }
  if (choices.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        There’s no other space you can publish to. Someone who owns a space can let you publish in
        it, or in a folder they share with you.
      </p>
    );
  }
  const index = picked === undefined ? 0 : (places?.findIndex((p) => p.parentId === picked) ?? -1);
  const place = places?.[index];
  const label = (p: PublishPlace, spaceName: string) =>
    p.parentId === null ? `Top of ${plainText(spaceName)}` : p.path.map(plainText).join(' › ');
  return (
    <form
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (space && place) onChoose({ spaceId: space.spaceId, spaceName: space.name, place });
      }}
    >
      <div className="grid gap-1.5">
        <Label htmlFor={`${id}-space`}>Space</Label>
        <Picker
          id={`${id}-space`}
          label="Space"
          placeholder="Choose a space"
          value={space?.spaceId ?? null}
          options={choices.map((c) => ({
            value: c.spaceId,
            label: `${plainText(c.name)}${c.folderOnly ? ' (a folder shared with you)' : ''}`,
          }))}
          autoFocus
          onChange={(value) => {
            const next = choices.find((c) => c.spaceId === value);
            if (!next) return;
            setSpaceId(next.spaceId);
            setPicked(undefined);
          }}
        />
        <ErrorLine error={space ? null : SPACE_GONE} />
      </div>
      {space && (
        <div className="grid gap-1.5">
          <Label htmlFor={`${id}-to`}>Folder</Label>
          {!places ? (
            failedToLoad(treeLoad) ? (
              <LoadFailed what="the folders in this space" queries={[treeLoad]} />
            ) : (
              <p className="text-sm text-muted-foreground">Loading…</p>
            )
          ) : places.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              You can’t publish anywhere in this space. Choose another.
            </p>
          ) : (
            <>
              <Picker
                id={`${id}-to`}
                label="Folder"
                placeholder="Choose a folder"
                value={place ? String(index) : null}
                options={places.map((p, i) => ({ value: String(i), label: label(p, space.name) }))}
                onChange={(value) => {
                  const next = places[Number(value)];
                  if (next) setPicked(next.parentId);
                }}
              />
              <ErrorLine error={place ? null : FOLDER_GONE} />
            </>
          )}
        </div>
      )}
      <DialogFooter>
        <Button type="submit" disabled={!place}>
          Next
        </Button>
      </DialogFooter>
    </form>
  );
}

// Everything the person confirms, worked out afresh from what this app verified.
function ConfirmPublication({
  page,
  version,
  chosen,
  onBack,
  onDone,
}: {
  page: { spaceId: SpaceId; pageId: PageId };
  version: Version;
  chosen: Chosen;
  onBack: () => void;
  onDone: (copy: { spaceId: SpaceId; pageId: PageId }) => void;
}) {
  const ctx = useClient();
  const queryClient = useQueryClient();
  const { busy, error, run } = useAction(publicationMessage);
  const [notice, setNotice] = useState<string | null>(null);
  const preview = useQuery({
    queryKey: [
      PLAIN,
      'publication-preview',
      page.pageId,
      version.revisionId,
      chosen.spaceId,
      chosen.place.parentId,
    ],
    queryFn: ({ signal }) =>
      publicationOperations.previewPublication(ctx, {
        source: page,
        revisionId: version.revisionId,
        audience: version.audience,
        spaceId: chosen.spaceId,
        parentId: chosen.place.parentId,
        // Off the page's thread, given as long as the reader.
        read: (markdown) => pageReader.run('links', markdown, { budgetMs: READ_BUDGET_MS, signal }),
      }),
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
  const shown = preview.data;
  // Every attachment goes unless the person unticks it.
  const [left, setLeft] = useState<ReadonlySet<string>>(new Set());
  const { data: people } = useQuery(
    peopleQuery(ctx, shown?.audience.people.map((p) => p.identityId) ?? []),
  );
  const name = (identityId: string) =>
    (people?.get(identityId) ?? describePerson(ctx, identityId, null)).name;
  const { data: tree } = useQuery(treeQuery(ctx, chosen.spaceId));
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), []);

  // Named from where the copy actually goes, once worked out: an existing
  // copy stays where it is, which may not be where the person chose.
  const path = shown ? pathIn(tree, shown.destination.parentId) : chosen.place.path;

  const publish = (confirmed: publicationOperations.PublicationPreview) =>
    run(async () => {
      setNotice(null);
      try {
        await runCommand(
          publishElsewhere,
          {
            preview: confirmed,
            attachmentIds: confirmed.attachments
              .map((a) => a.id)
              .filter((attachmentId) => !left.has(attachmentId)),
          },
          { satisfies: requirementsHere(), ctx },
        );
      } catch (caught) {
        if (!isStale(caught)) throw caught;
        // Worked out again and shown again, never sent unseen.
        await preview.refetch();
        setNotice('Something changed there meanwhile. Check it again, then publish.');
        return;
      }
      searchIndexChanged(queryClient);
      // Not waited for: it opens every space the page is published in.
      void queryClient.invalidateQueries({ queryKey: [PLAIN, 'published-copies'] });
      await Promise.all(
        ['tree', 'page', 'history'].map((kind) =>
          queryClient.invalidateQueries({ queryKey: [PLAIN, kind] }),
        ),
      );
      onDone({ spaceId: confirmed.destination.spaceId, pageId: confirmed.destination.pageId });
    });

  return (
    <div className="grid gap-4">
      {/* Where focus goes after Next, so a screen reader starts with what is being confirmed. */}
      <h3 ref={heading} tabIndex={-1} className="text-sm outline-none">
        {shown?.destination.state === 'existing'
          ? 'To the page it was published to before, in '
          : 'To '}
        <strong>
          <Name>{chosen.spaceName}</Name>
          {path.map((folder, i) => (
            <Fragment key={i}>
              {' › '}
              <Name>{folder}</Name>
            </Fragment>
          ))}
        </strong>
        .
      </h3>
      {notice && !preview.isError && (
        <p role="status" className="text-sm font-bold">
          {notice}
        </p>
      )}
      {preview.error instanceof publicationOperations.PublishedElsewhere ? (
        <EndElsewhere
          source={page}
          spaceId={chosen.spaceId}
          spaceName={chosen.spaceName}
          onEnded={() => {
            void preview.refetch();
            void queryClient.invalidateQueries({ queryKey: [PLAIN, 'published-copies'] });
          }}
        />
      ) : (
        preview.error && (
          <ErrorLine
            error={
              isStale(preview.error)
                ? 'Something changed there since you chose it. Go back and check again.'
                : publicationMessage(preview.error)
            }
          />
        )
      )}
      {!shown && !preview.error && (
        <p className="text-sm text-muted-foreground">Working out who can read it there…</p>
      )}
      {shown && (
        <>
          <section aria-label="Who can read it there" className="grid gap-2">
            <h3 className="text-sm font-bold text-subtle-foreground">
              At least these people can read it there
            </h3>
            <ul className="grid gap-1 text-sm">
              {shown.audience.people.map((p) => (
                <li key={p.identityId}>
                  <strong>
                    <Name>{name(p.identityId)}</Name>
                  </strong>
                </li>
              ))}
            </ul>
            <p className="text-xs text-muted-foreground">
              {shown.audience.complete
                ? 'The server could keep someone from this list, so there may be more.'
                : `And anyone else it’s shared with there: only an owner of ${plainText(chosen.spaceName)} can see who.`}{' '}
              They see only what you publish there, never this page’s drafts or other versions, and
              they don’t get access to this page.
            </p>
          </section>
          <section aria-label="Attachments" className="grid gap-2">
            <h3 className="text-sm font-bold text-subtle-foreground">Attachments that go</h3>
            {shown.attachments.length === 0 ? (
              <p className="text-sm text-muted-foreground">This version has none.</p>
            ) : (
              <ul className="grid gap-1 text-sm">
                {shown.attachments.map((a) => (
                  <li key={a.id}>
                    <label className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={!left.has(a.id)}
                        onChange={(event) => {
                          const next = new Set(left);
                          if (event.target.checked) next.delete(a.id);
                          else next.add(a.id);
                          setLeft(next);
                        }}
                      />
                      <Name>{a.name}</Name>
                    </label>
                  </li>
                ))}
              </ul>
            )}
            <p className="text-xs text-muted-foreground">
              Each is copied and encrypted afresh for that space.
            </p>
          </section>
          {(shown.links === null || shown.links.length > 0) && (
            <section aria-label="Links readers there may not open" className="grid gap-2">
              <h3 className="text-sm font-bold text-subtle-foreground">
                Links readers there may not be able to open
              </h3>
              {shown.links === null ? (
                <p className="text-sm">
                  This page’s links couldn’t be read, so some may not open there.
                </p>
              ) : (
                <ul className="grid list-disc gap-1 pl-5 text-sm">
                  {shown.links.map((link) => (
                    <li key={`${link.kind} ${link.page}`}>
                      <Name>{link.text}</Name>
                      {link.count > 1 && (
                        <span className="text-muted-foreground"> · {link.count} links</span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              <p className="text-xs text-muted-foreground">
                The pages they point at aren’t published with it.
              </p>
            </section>
          )}
          <p role="note" className="rounded-control bg-muted p-3 text-sm">
            <strong>Copies can’t be recalled.</strong> Once it’s published there, anyone who can
            read it there can keep what they read or download.
          </p>
        </>
      )}
      <ErrorLine error={error} />
      <DialogFooter>
        <Button variant="ghost" disabled={busy} onClick={onBack}>
          Back
        </Button>
        <Button
          disabled={busy || !shown || preview.isError}
          onClick={() => shown && void publish(shown)}
        >
          {busy ? 'Publishing…' : 'Publish there'}
        </Button>
      </DialogFooter>
    </div>
  );
}

// The page's copy in that space is somewhere this person can't publish:
// they may end it, as someone who can publish the page, without seeing it.
function EndElsewhere({
  source,
  spaceId,
  spaceName,
  onEnded,
}: {
  source: { spaceId: SpaceId; pageId: PageId };
  spaceId: SpaceId;
  spaceName: string;
  onEnded: () => void;
}) {
  const ctx = useClient();
  const { busy, error, run } = useAction(publicationMessage);
  return (
    <section aria-label="Already published there" className="grid gap-2">
      <p className="text-sm font-bold">
        This page is already published in <Name>{spaceName}</Name>, somewhere you can’t publish.
      </p>
      <p className="text-sm text-muted-foreground">
        You can end that copy’s link to this page, then publish it there. The copy stays where it
        is, as a page of its own, and its readers keep it. It just isn’t updated from this page any
        more.
      </p>
      <ErrorLine error={error} />
      <div>
        <Button
          variant="secondary"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              await runCommand(
                endPublication,
                { source, spaceId },
                { satisfies: requirementsHere(), ctx },
              );
              onEnded();
            })
          }
        >
          {busy ? 'Ending…' : 'End the existing copy there'}
        </Button>
      </div>
    </section>
  );
}

// The names of the folders down to `parentId`, outermost first.
function pathIn(tree: Tree | undefined, parentId: string | null): string[] {
  const path: string[] = [];
  const folders = new Map(tree?.folders.map((f) => [f.id as string, f]) ?? []);
  for (let at = parentId; at !== null && path.length <= folders.size;) {
    const folder = folders.get(at);
    if (!folder) break;
    path.unshift(nameOf(folder.metadata) ?? 'Unreadable folder');
    at = folder.parentId;
  }
  return path;
}

function Published({
  to,
  onClose,
}: {
  to: { spaceId: SpaceId; pageId: PageId };
  onClose: () => void;
}) {
  const heading = useRef<HTMLParagraphElement>(null);
  useEffect(() => heading.current?.focus(), []);
  return (
    <div className="grid gap-4">
      <p ref={heading} tabIndex={-1} role="status" className="text-sm font-bold outline-none">
        Published. Readers there see it now.
      </p>
      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>
          Close
        </Button>
        <Button asChild>
          <Link to="/s/$spaceId/p/$pageId" params={to} onClick={onClose}>
            Open it there
          </Link>
        </Button>
      </DialogFooter>
    </div>
  );
}
