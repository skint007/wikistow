import type { FolderId, SpaceId } from '@wikistow/client';
import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useEffect, useId, useMemo, useState } from 'react';
import { failedToLoad, LoadFailed } from '@/components/load-failed';
import { Name, plainText } from '@/components/name';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Picker } from '@/components/ui/picker';
import { sharedWithMeQuery, spacesQuery, treeQuery } from '../data/queries';
import { grantOf, type Access } from '../sharing/model';
import { nameOf } from '../sharing/names';
import { useOwnerStanding } from '../sharing/owner-standing';
import { AccessSelect } from '../sharing/person-finder';
import { ErrorLine } from '../sharing/use-action';
import { useClient } from '../vault/store';
import { accessUpTo, ancestorsOf, placesIn, type Place } from './model';

/** A folder or space picked for an agent, with its access, and how it is named on screen. */
export type ChosenPick = {
  spaceId: SpaceId;
  folderId: FolderId | null;
  role: 'reader' | 'editor';
  canPublish: boolean;
  newShare: boolean;
  /** The share it is in; null for a new share. One pick per share. */
  shareId: string | null;
  path: string[];
  /** The folders above it, for telling nested picks apart (`withPick`). */
  ancestors: FolderId[];
};

// The Folder list's value for the whole space: IDs are never empty.
const SPACE = '';

const SPACE_GONE = 'The space you picked is no longer available. Choose again.';
const FOLDER_GONE = 'The folder you picked is no longer available. Choose again.';

/**
 * The spaces this person can pick in, each named so two can be told
 * apart: the ones they own or hold whole by their name, then each space
 * they hold only folders of, by who shared them and those folders' names.
 * Each group goes by name, then ID, as the server lists spaces in no set
 * order and the first is the pick form's default.
 */
export function useSpaceNames(): { spaceId: SpaceId; name: string }[] {
  const ctx = useClient();
  const { data: spaces } = useQuery(spacesQuery(ctx));
  const { data: sharedWithMe } = useQuery(sharedWithMeQuery(ctx));
  return useMemo(() => {
    const listed = (spaces ?? []).map((space) => ({
      spaceId: space.id,
      name: nameOf(space.metadata) ?? 'A space this app can’t read',
    }));
    const known = new Set(listed.map((s) => s.spaceId));
    const folders = new Map<SpaceId, { by: string | null; roots: string[] }>();
    // By share, so who a space's name says shared it doesn't follow the server's order.
    const items = [...(sharedWithMe ?? [])].sort((a, b) =>
      a.share.shareId.localeCompare(b.share.shareId),
    );
    for (const item of items) {
      if (known.has(item.share.spaceId)) continue;
      const entry = folders.get(item.share.spaceId) ?? {
        by: item.sharedBy?.label ?? null,
        roots: [],
      };
      entry.roots.push(nameOf(item.root) ?? 'a folder this app can’t read');
      folders.set(item.share.spaceId, entry);
    }
    const shared = [...folders].map(([spaceId, { by, roots }]) => ({
      spaceId,
      name: `Shared with you by ${by ?? 'an owner'}: ${roots.sort((a, b) => a.localeCompare(b)).join(', ')}`,
    }));
    return [...listed.sort(byName), ...shared.sort(byName)];
  }, [spaces, sharedWithMe]);
}

const byName = (a: { spaceId: string; name: string }, b: { spaceId: string; name: string }) =>
  a.name.localeCompare(b.name) || a.spaceId.localeCompare(b.spaceId);

/**
 * Pick a folder, or a space, for an agent from this person's own access
 * (protocol section 9.4): a space, then a place in it, then the access,
 * never more than theirs. A place in the owner region is explained as
 * becoming a share.
 */
export function PickForm({
  submitLabel = 'Add',
  disabled = false,
  onPick,
}: {
  submitLabel?: string;
  disabled?: boolean;
  onPick: (pick: ChosenPick) => void;
}) {
  const id = useId();
  const ctx = useClient();
  // Spaces this person owns or holds whole, then those they hold folders of.
  const spaceOptions = useSpaceNames();
  const spaces = useQuery(spacesQuery(ctx));
  const sharedWithMe = useQuery(sharedWithMeQuery(ctx));
  // The space picked, by ID. Until the person picks, it is the first one
  // shown once both lists are in, kept once shown, so a space added meanwhile
  // doesn't take its place and drop the folder picked in it. If a refetch no
  // longer lists it, nothing is picked until they pick again.
  const [spaceId, setSpaceId] = useState<SpaceId | null>(null);
  const first = spaces.isPending || sharedWithMe.isPending ? undefined : spaceOptions[0];
  useEffect(() => {
    if (spaceId === null && first) setSpaceId(first.spaceId);
  }, [spaceId, first]);
  const chosen = spaceOptions.some((s) => s.spaceId === spaceId) ? spaceId : null;
  // The folder picked in it, and the access, kept here so they outlast the
  // space going from the list and coming back: the first place mustn't
  // stand in for the folder then, nor Reader for the access.
  const [picked, setPicked] = useState<FolderId | null | undefined>(undefined);
  const [access, setAccess] = useState<Access>('reader');
  // Both lists are in, or failed, and neither has a space: there's no list to show.
  const settled = (list: typeof spaces | typeof sharedWithMe) =>
    list.data !== undefined || failedToLoad(list);
  const nowhere = settled(spaces) && settled(sharedWithMe) && spaceOptions.length === 0;
  const failed = failedToLoad(spaces) || failedToLoad(sharedWithMe);

  return (
    <div className="grid gap-3 rounded-control border p-3">
      {nowhere && !failed && (
        <p className="text-sm text-muted-foreground">
          There’s nowhere to pick yet. Make a space, or ask someone to share a folder with you.
        </p>
      )}
      <LoadFailed what="the spaces you can pick in" queries={[spaces, sharedWithMe]} />
      {!nowhere && (
        <div className="grid gap-1.5">
          <Label htmlFor={`${id}-space`}>Space</Label>
          <Picker
            id={`${id}-space`}
            label="Space"
            placeholder="Choose a space"
            value={chosen}
            options={spaceOptions.map((space) => ({
              value: space.spaceId,
              label: plainText(space.name),
            }))}
            disabled={disabled || spaceId === null}
            onChange={(value) => {
              const next = spaceOptions.find((s) => s.spaceId === value);
              if (!next) return;
              setSpaceId(next.spaceId);
              setPicked(undefined);
              setAccess('reader');
            }}
          />
          <ErrorLine error={spaceId !== null && !chosen ? SPACE_GONE : null} />
        </div>
      )}
      {chosen && (
        <PlaceInSpace
          key={chosen}
          spaceId={chosen}
          picked={picked}
          onPicked={setPicked}
          access={access}
          onAccess={setAccess}
          idPrefix={id}
          submitLabel={submitLabel}
          disabled={disabled}
          onPick={onPick}
        />
      )}
    </div>
  );
}

function PlaceInSpace({
  spaceId,
  picked,
  onPicked,
  access,
  onAccess,
  idPrefix,
  submitLabel,
  disabled,
  onPick,
}: {
  spaceId: SpaceId;
  /** The folder picked, by ID (null for the whole space); undefined until something is shown picked. */
  picked: FolderId | null | undefined;
  onPicked: (folderId: FolderId | null) => void;
  access: Access;
  onAccess: (access: Access) => void;
  idPrefix: string;
  submitLabel: string;
  disabled: boolean;
  onPick: (pick: ChosenPick) => void;
}) {
  const ctx = useClient();
  const treeLoad = useQuery(treeQuery(ctx, spaceId));
  const tree = treeLoad.data;
  const standing = useOwnerStanding(spaceId);
  const found = useMemo(
    () =>
      tree
        ? placesIn(
            {
              shares: tree.shares,
              folders: tree.folders.map((f) => ({
                id: f.id,
                parentId: f.parentId,
                name: nameOf(f.metadata),
              })),
            },
            {
              owner: standing === 'owner',
              spaceName: nameOf(tree.space?.metadata),
              spaceOpened: !!tree.space?.metadata,
            },
          )
        : null,
    [tree, standing],
  );
  // The folder picked, by ID, not by where it is in the list: a refetch can
  // put another folder there. Until the person picks, it is the first one
  // shown, kept once shown, so a folder made meanwhile doesn't take its place.
  // If a refetch no longer offers it, nothing is picked until they pick again:
  // the first place may be the whole space, a far wider grant.
  const first = standing === 'owner' || standing === null ? found?.places[0] : undefined;
  useEffect(() => {
    if (picked === undefined && first) onPicked(first.folderId);
  }, [picked, first, onPicked]);
  if (failedToLoad(treeLoad)) {
    return <LoadFailed what="the folders in this space" queries={[treeLoad]} />;
  }
  if (standing === 'checking' || !found) {
    return <p className="text-sm text-muted-foreground">Looking at what you can reach here…</p>;
  }
  if (standing === 'unconfirmed') {
    return (
      <p className="text-sm text-muted-foreground">
        You’re an owner of this space, but you haven’t confirmed who added you yet. Open the space
        and confirm first, then pick its folders for an agent.
      </p>
    );
  }
  const { places, unpickable } = found;
  const place: Place<FolderId> | undefined =
    picked === undefined ? places[0] : places.find((p) => p.folderId === picked);
  if (places.length === 0) {
    return <p className="text-sm text-muted-foreground">There’s nothing here you can pick.</p>;
  }
  // While nothing is picked, the access list (off then) shows the access
  // chosen as it is, so it can't come back changed when a folder is picked.
  const allowed = accessUpTo(place?.max ?? 'publisher');
  const shown = allowed.includes(access) ? access : 'reader';
  const label = (p: Pick<Place, 'path'>) =>
    p.path.length === 0 ? 'Everything shared with you here' : p.path.map(plainText).join(' › ');

  return (
    <>
      <div className="grid gap-1.5">
        <Label htmlFor={`${idPrefix}-place`}>Folder</Label>
        <Picker
          id={`${idPrefix}-place`}
          label="Folder"
          placeholder="Choose a folder"
          value={place ? (place.folderId ?? SPACE) : null}
          options={places.map((p) => ({
            value: p.folderId ?? SPACE,
            label: `${p.folderId === null ? `${label(p)} (whole space)` : label(p)}${p.newShare ? ' — not shared yet' : ''}`,
          }))}
          disabled={disabled}
          onChange={(value) => {
            const next = places.find((p) => (p.folderId ?? SPACE) === value);
            if (next) onPicked(next.folderId);
          }}
        />
        <ErrorLine error={place ? null : FOLDER_GONE} />
      </div>
      {place?.newShare && (
        <p className="rounded-control bg-muted p-3 text-sm">
          “<Name>{place.path.at(-1) ?? 'This space'}</Name>” isn’t shared yet. Picking it makes it a
          share, with this agent as its only member besides the space’s owners, who will see it in
          Share. After that, folders inside it can’t be shared on their own.
        </p>
      )}
      {unpickable.length > 0 && (
        <p className="text-xs text-muted-foreground">
          {unpickable.map((u) => (u.folderId === null ? 'The whole space' : label(u))).join(', ')}{' '}
          {unpickable.length === 1 ? 'holds' : 'hold'} a shared folder, so{' '}
          {unpickable.length === 1 ? 'it' : 'they'} can’t be picked. Pick that folder instead.
        </p>
      )}
      <div className="flex flex-wrap items-end gap-2">
        <div className="grid gap-1.5">
          <Label htmlFor={`${idPrefix}-access`}>Access</Label>
          <AccessSelect
            id={`${idPrefix}-access`}
            value={shown}
            allowed={allowed}
            disabled={disabled || !place}
            onChange={onAccess}
          />
        </div>
        <Button
          type="button"
          variant="secondary"
          disabled={disabled || !place}
          onClick={() =>
            place &&
            onPick({
              spaceId,
              folderId: place.folderId,
              ...grantOf(shown),
              newShare: place.newShare,
              shareId: place.shareId,
              path: place.path,
              ancestors: tree ? ancestorsOf(tree.folders, place.folderId) : [],
            })
          }
        >
          <Plus strokeWidth={1.75} /> {submitLabel}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Reader: reads published pages. Editor: also reads and changes drafts. Editor + publish: can
        also publish.
        {place?.newShare === false && ' The folder’s owners will see this agent in Share.'}
      </p>
      {place && place.max !== 'publisher' && (
        <p className="text-xs text-muted-foreground">
          You’re {place.max === 'reader' ? 'a reader' : 'an editor without publish'} here, so your
          agent can’t be given more.
        </p>
      )}
    </>
  );
}
