// The page's end of the web clipper in the desktop app (ADR 0017, step 4):
// it tells main the vault's state, saves each clip main hands it once the
// vault is open, answers the extension's folder searches while it's open,
// and opens a clipped draft when the extension asks. A clip that comes
// while the vault is locked waits here and in main, which keeps it until
// the page says how saving it went, so a reload loses nothing.
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import type { ClientContext, PageId, SpaceId } from '@wikistow/client';
import type { DesktopBridge, DesktopClip } from '@wikistow/contracts';
import { useCallback, useEffect, useId, useMemo, useState, useSyncExternalStore } from 'react';
import { z } from 'zod';
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
import { contentChanged } from '../data/content-changed';
import { useConnection } from '../data/connection';
import { pageWriter } from '../data/offline-changes';
import { sharedWithMeQuery, spacesQuery, treeQuery } from '../data/queries';
import { desktop } from '../desktop';
import { showNotice } from '../page/undo-notice';
import { useVault, vaultStore } from '../vault/store';
import { clipTitle, localDay } from './clip-page';
import {
  clipFolder,
  clipPlaces,
  rememberedPlaces,
  searchPlaces,
  type ClipPlace,
} from './clip-places';
import { saveClip, type Places, type Saved } from './save-clip';
import { MarkdownWorker, READ_BUDGET_MS } from '../page/markdown-worker';

/** How long a space's tree loaded for clipping is taken as current. */
const TREES_FRESH_MS = 30_000;

// ---- The clips waiting here ----

let waiting: DesktopClip[] = [];
/** Clips this page took, so one handed over twice (an event, and `waitingClips`) is saved once. */
const taken = new Set<string>();
const listeners = new Set<() => void>();
const emit = () => {
  for (const listener of listeners) listener();
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

/** Let go of clips main no longer holds, as after a sign-out. */
function keepOnly(held: readonly DesktopClip[]) {
  const ids = new Set(held.map((clip) => clip.id));
  waiting = waiting.filter((clip) => ids.has(clip.id));
  emit();
}

function take(clip: DesktopClip) {
  if (taken.has(clip.id)) return;
  taken.add(clip.id);
  waiting = [...waiting, clip];
  emit();
}

/** How many clips wait for the vault to open, for the unlock page. */
export const useWaitingClips = () => useSyncExternalStore(subscribe, () => waiting.length);

// ---- Where clips go ----

const RecentPlaces = z
  .array(z.object({ spaceId: z.string().max(100), folderId: z.string().max(100).nullable() }))
  .max(5);

// The IDs of the five places clips went last, never their names, in this
// computer's storage, per server and account (ADR 0017, decision 3).
const recentKey = (ctx: ClientContext, accountId: string) =>
  `wikistow.clip-places.${ctx.installationId}.${accountId}`;

function recentPlaces(ctx: ClientContext, accountId: string) {
  try {
    const parsed = RecentPlaces.safeParse(
      JSON.parse(localStorage.getItem(recentKey(ctx, accountId)) ?? '[]'),
    );
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

function keepRecentPlace(ctx: ClientContext, accountId: string, place: ClipPlace) {
  const next = rememberedPlaces(recentPlaces(ctx, accountId), {
    spaceId: place.spaceId,
    folderId: place.folderId,
  });
  try {
    localStorage.setItem(recentKey(ctx, accountId), JSON.stringify(next));
  } catch {
    // Not kept past this run.
  }
}

/**
 * Every place the person can make pages, from the trees of the spaces they
 * can write in, and those whose trees couldn't be read, as offline.
 */
async function loadPlaces(queryClient: QueryClient, ctx: ClientContext): Promise<Places> {
  const fresh = { staleTime: TREES_FRESH_MS };
  const [spaces, shared] = await Promise.all([
    queryClient.fetchQuery({ ...spacesQuery(ctx), ...fresh }),
    queryClient.fetchQuery({ ...sharedWithMeQuery(ctx), ...fresh }).catch(() => []),
  ]);
  const ids = new Set<SpaceId>([
    ...spaces.filter((space) => space.role !== 'reader').map((space) => space.id),
    ...shared.filter((item) => item.role !== 'reader').map((item) => item.share.spaceId),
  ]);
  const unread = new Set<string>();
  const trees = await Promise.all(
    [...ids].map((spaceId) =>
      queryClient
        .fetchQuery({ ...treeQuery(ctx, spaceId), ...fresh })
        .then((tree) => ({ spaceId, tree }))
        .catch(() => {
          unread.add(spaceId);
          return null;
        }),
    ),
  );
  return { places: clipPlaces(trees.filter((tree) => tree !== null)), unread };
}

/** Links read in the app's Markdown worker, which no text can hold up for long (#47). */
const reader = new MarkdownWorker();
const spans = (markdown: string) => reader.run('spans', markdown, { budgetMs: READ_BUDGET_MS });

const convert = async (html: string, text: string) => {
  // The visual editor loads only when a clip comes.
  const { htmlMarkdown } = await import('../page/editor/visual/html-markdown');
  return htmlMarkdown(html, text);
};

/** The question for a clip whose folder can't take it: where it goes instead. */
type Asking = { title: string; places: ClipPlace[]; answer: (place: ClipPlace | null) => void };

/** Mounted once in the desktop app's shell. */
export function ClipReceiver() {
  return desktop ? <Receiver bridge={desktop} /> : null;
}

function Receiver({ bridge }: { bridge: DesktopBridge }) {
  const vault = useVault();
  const { online } = useConnection();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [asking, setAsking] = useState<Asking | null>(null);
  const clips = useSyncExternalStore(subscribe, () => waiting);
  const [saving, setSaving] = useState(false);
  const openPage = useCallback(
    (spaceId: SpaceId, pageId: PageId) =>
      void navigate({ to: '/s/$spaceId/p/$pageId', params: { spaceId, pageId } }),
    [navigate],
  );

  // The extension hears the vault's state from main.
  useEffect(() => {
    void bridge.setClipState({ vault: vault.status, offline: !online }).catch(() => {});
  }, [bridge, vault.status, online]);

  // What main asks, and the clips it held before this page heard.
  useEffect(() => {
    const stop = bridge.onClipRequest((request) => {
      if (request.kind === 'clip') return take(request.clip);
      if (request.kind === 'show') return openPage(request.spaceId, request.pageId);
      if (request.kind === 'dropped') {
        const gone = new Set(request.clipIds);
        return keepOnly(waiting.filter((clip) => !gone.has(clip.id)));
      }
      // Folder names cross only while unlocked, for what the person typed.
      const now = vaultStore.get();
      if (now.status !== 'unlocked')
        return void bridge.clipFolders(request.id, null).catch(() => {});
      void (async () => {
        try {
          const { places } = await loadPlaces(queryClient, now.ctx);
          const found = searchPlaces(
            places,
            request.query,
            recentPlaces(now.ctx, now.vault.accountId),
          );
          const answer = vaultStore.get() === now;
          await bridge.clipFolders(
            request.id,
            answer
              ? { recent: found.recent.map(clipFolder), matches: found.matches.map(clipFolder) }
              : null,
          );
        } catch {
          await bridge.clipFolders(request.id, { recent: [], matches: [] }).catch(() => {});
        }
      })();
    });
    // Main holds what waits: this page takes its list afresh, and lets go
    // of its own once it's gone, as after a sign-out.
    waiting = [];
    taken.clear();
    emit();
    void bridge
      .waitingClips()
      .then((held) => held.forEach(take))
      .catch(() => {});
    return () => {
      stop();
      waiting = [];
      taken.clear();
      emit();
    };
  }, [bridge, openPage, queryClient]);

  // A lock closes the question; the clip waits for the next unlock.
  useEffect(() => {
    if (vault.status === 'locked' && asking) {
      setAsking(null);
      asking.answer(null);
    }
  }, [vault.status, asking]);

  // Saving, one at a time, while the vault is open.
  const next = clips[0];
  useEffect(() => {
    if (vault.status !== 'unlocked' || !next || saving) return;
    const { ctx } = vault;
    const { accountId } = vault.vault;
    const started = vaultStore.epoch();
    setSaving(true);
    const save = async () => {
      // Only a clip main still holds: one a sign-out let go isn't saved.
      const held = await bridge.waitingClips().catch(() => null);
      if (!held?.some((clip) => clip.id === next.id)) return keepOnly(held ?? []);
      const saved: Saved = await saveClip(next, {
        writer: pageWriter(ctx),
        places: () => loadPlaces(queryClient, ctx),
        convert,
        spans,
        made: (page) => bridge.clipMade(next.id, page),
        image: (url) => bridge.clipImage(next.id, url),
        today: localDay(),
        choose: (_clip, title) =>
          new Promise(
            (answer) =>
              void loadPlaces(queryClient, ctx).then(
                ({ places }) => setAsking({ title, places, answer }),
                () => answer(null),
              ),
          ),
      }).catch((): Saved => ({
        outcome: { ok: false, code: 'failed', message: 'WikiStow couldn’t save the clip.' },
        place: null,
      }));
      setAsking(null);
      const { place } = saved;
      let { outcome } = saved;
      const locked = vaultStore.epoch() !== started;
      // Locked meanwhile, it couldn't save: it waits for the next unlock.
      if (!outcome.ok && locked) return;
      // Saved, though the vault locked since: no folder's name leaves it now.
      if (outcome.ok && locked) outcome = { ...outcome, path: '' };
      await bridge.clipDone(next.id, outcome).catch(() => {});
      waiting = waiting.filter((clip) => clip.id !== next.id);
      emit();
      if (!outcome.ok) {
        const title = clipTitle(next);
        showNotice({ ctx, message: `“${title}” wasn’t saved. ${outcome.message}`, failed: true });
        return;
      }
      if (place) keepRecentPlace(ctx, accountId, place);
      void contentChanged(queryClient, ctx, { spaceId: outcome.spaceId });
      showNotice({
        ctx,
        message: outcome.path
          ? `Saved “${outcome.title}” to ${outcome.path}`
          : `Saved “${outcome.title}”`,
        ...(outcome.faithful
          ? {}
          : { notes: 'Some of it may look different from the site. Check the draft.' }),
        action: { label: 'Open', run: () => openPage(outcome.spaceId, outcome.pageId) },
      });
    };
    // However it ends, the next clip gets its turn.
    void save().finally(() => setSaving(false));
  }, [vault, next, saving, bridge, queryClient, openPage]);

  return asking && vault.status === 'unlocked' ? (
    <ChoosePlace
      asking={asking}
      recent={recentPlaces(vault.ctx, vault.vault.accountId)}
      onDone={(place) => {
        setAsking(null);
        asking.answer(place);
      }}
    />
  ) : null;
}

/**
 * Where a clip that waited goes, once the folder it was sent to can't take
 * it (ADR 0017, decision 6): the places clips went last, or those matching
 * what the person types.
 */
function ChoosePlace({
  asking,
  recent,
  onDone,
}: {
  asking: Asking;
  recent: readonly { spaceId: string; folderId: string | null }[];
  onDone: (place: ClipPlace | null) => void;
}) {
  const id = useId();
  const [query, setQuery] = useState('');
  const found = useMemo(
    () => searchPlaces(asking.places, query, recent),
    [asking.places, query, recent],
  );
  const shown = query.trim() ? found.matches : found.recent;
  return (
    <Dialog open onOpenChange={(open) => !open && onDone(null)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Where should “{asking.title}” go?</DialogTitle>
          <DialogDescription>
            The folder it was clipped to is gone, or you can’t add pages to it any more.
          </DialogDescription>
        </DialogHeader>
        <Input
          id={`${id}-search`}
          aria-label="Find a folder"
          placeholder="Find a folder"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          autoFocus
        />
        <ul className="grid max-h-72 gap-1 overflow-y-auto" aria-label="Folders">
          {shown.map((place) => (
            <li key={`${place.spaceId}/${place.folderId ?? ''}`}>
              <Button
                variant="ghost"
                className="w-full justify-start truncate"
                onClick={() => onDone(place)}
              >
                {place.path.join(' / ')}
              </Button>
            </li>
          ))}
        </ul>
        {shown.length === 0 && (
          <p className="text-sm text-muted-foreground">
            {query.trim() ? 'No folder you can add pages to matches.' : 'Type to find a folder.'}
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onDone(null)}>
            Don’t save it
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
