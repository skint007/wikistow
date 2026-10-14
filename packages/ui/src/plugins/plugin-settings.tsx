import { searchOperations, type ClientContext } from '@wikistow/client';
import type { PluginCandidate, PluginScope } from '@wikistow/contracts';
import type { PageAccess, TrustLevel } from '@wikistow/plugin-sdk';
import { useQueries, useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { FormMessage } from '@/components/layout/auth-card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Picker } from '@/components/ui/picker';
import { Switch } from '@/components/ui/switch';
import { sharedWithMeQuery, spacesQuery, treeQuery } from '../data/queries';
import { desktop } from '../desktop';
import { useVault } from '../vault/store';
import { pluginRuntime, usePlugins, type PluginStatus } from './runtime';

const LEVELS: Record<TrustLevel, { label: string; trust: string }> = {
  theme: {
    label: 'Theme',
    trust:
      'It changes how WikiStow looks, and can hide or restyle anything in it. It runs no code.',
  },
  script: {
    label: 'Script',
    trust:
      'Its code runs in a sandbox of its own, with no network. It reaches only the pages you give it in Page access, and its work is time-limited.',
  },
  app: {
    label: 'App',
    trust:
      'Its code runs inside WikiStow with WikiStow’s own trust: it can read everything this window shows and use your account on the server. Page access limits what it asks for, but it isn’t a sandbox. Install it only if you trust whoever made it.',
  },
};

const ACCESS: Record<PageAccess, string> = {
  none: 'no pages',
  read: 'reading the pages you choose',
  write: 'reading and changing drafts in the pages you choose',
};

const message = (error: unknown) =>
  error instanceof Error ? error.message : 'Something went wrong.';

/**
 * Settings → Plugins, in the desktop app: install a plugin folder or load
 * one for development, turn each on or off, reload, remove, and choose
 * the pages it may use. Every install asks for approval first.
 */
export function PluginSettings() {
  const { safeMode, plugins } = usePlugins();
  const [candidate, setCandidate] = useState<PluginCandidate | null>(null);
  const [error, setError] = useState<string | null>(null);
  const bridge = desktop;
  if (!bridge) return null;

  const act = async (run: () => Promise<unknown>) => {
    setError(null);
    try {
      await run();
    } catch (failure) {
      setError(message(failure));
    }
    await pluginRuntime.refresh();
  };
  const pick = (kind: 'install' | 'development') =>
    act(async () => setCandidate(await bridge.pickPlugin(kind)));

  return (
    <div className="grid gap-4">
      {safeMode && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          Safe mode: no plugins are running.
          <Button size="sm" variant="outline" onClick={() => void bridge.setSafeMode(false)}>
            Turn plugins back on
          </Button>
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => void pick('install')}>Install plugin…</Button>
        <Button variant="outline" onClick={() => void pick('development')}>
          Load development folder…
        </Button>
        {!safeMode && (
          <Button variant="ghost" asChild>
            <Link to="/workshop">Build one with the assistant</Link>
          </Button>
        )}
      </div>
      {error && <FormMessage>{error}</FormMessage>}
      {plugins.length === 0 ? (
        <p className="text-sm text-muted-foreground">No plugins are installed.</p>
      ) : (
        <ul className="grid gap-3" aria-label="Installed plugins">
          {plugins.map((status) => (
            <PluginRow
              key={status.plugin.manifest.id}
              status={status}
              act={act}
              onCandidate={setCandidate}
            />
          ))}
        </ul>
      )}
      <Approval
        candidate={candidate}
        onDone={() => setCandidate(null)}
        onApprove={(token) => act(() => bridge.approvePlugin(token))}
      />
    </div>
  );
}

/** Ask the person to approve a plugin folder read for install or development. */
export function Approval({
  candidate,
  onDone,
  onApprove,
}: {
  candidate: PluginCandidate | null;
  onDone: () => void;
  onApprove: (token: string) => Promise<void>;
}) {
  const level = candidate ? LEVELS[candidate.level] : null;
  return (
    <Dialog open={candidate !== null} onOpenChange={(open) => !open && onDone()}>
      {candidate && level && (
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {candidate.replaces ? 'Update' : candidate.development ? 'Load' : 'Install'}{' '}
              {candidate.manifest.name} {candidate.manifest.version}?
            </DialogTitle>
            <DialogDescription>
              {candidate.manifest.description ?? candidate.manifest.id}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-2 text-sm">
            <p>
              <Badge variant="secondary">{level.label}</Badge> {level.trust}
            </p>
            <p>It asks for {ACCESS[candidate.manifest.access]}.</p>
            {candidate.replaces && (
              <p>
                It replaces version {candidate.replaces.version} (
                {LEVELS[candidate.replaces.level].label}, asking for{' '}
                {ACCESS[candidate.replaces.access]}).
              </p>
            )}
            {candidate.development && (
              <p>
                Development: its code is read from {candidate.development} again at each Reload,
                without asking again unless it asks for more.
              </p>
            )}
            {candidate.hash && (
              <p className="text-muted-foreground">
                Its files’ SHA-256, which this approval is for:{' '}
                <code className="break-all">{candidate.hash}</code>
              </p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={onDone}>
              Cancel
            </Button>
            <Button onClick={() => void onApprove(candidate.token).then(onDone)}>
              {candidate.development ? 'Load' : 'Install'}
            </Button>
          </DialogFooter>
        </DialogContent>
      )}
    </Dialog>
  );
}

function PluginRow({
  status: { plugin, problem },
  act,
  onCandidate,
}: {
  status: PluginStatus;
  act: (run: () => Promise<unknown>) => Promise<void>;
  onCandidate: (candidate: PluginCandidate) => void;
}) {
  const { manifest, level, development, enabled } = plugin;
  const bridge = desktop;
  if (!bridge) return null;
  return (
    <li className="grid gap-2 rounded-control border border-border p-3" aria-label={manifest.name}>
      <div className="flex flex-wrap items-center gap-2">
        <strong>{manifest.name}</strong>
        <span className="text-sm text-muted-foreground">{manifest.version}</span>
        <Badge variant="secondary">{LEVELS[level].label}</Badge>
        {development && <Badge variant="outline">Development</Badge>}
        <span className="flex-1" />
        <Switch
          checked={enabled}
          aria-label={`${manifest.name} enabled`}
          onCheckedChange={(on) => void act(() => bridge.setPluginEnabled(manifest.id, on))}
        />
      </div>
      {manifest.description && <p className="text-sm">{manifest.description}</p>}
      {development && <p className="text-sm text-muted-foreground">Read from {development}</p>}
      {problem && (
        <p role="alert" className="text-sm text-destructive">
          {problem}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {development && (
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              void act(async () => {
                const asks = await bridge.reloadPlugin(manifest.id);
                if (asks) onCandidate(asks);
              })
            }
          >
            Reload
          </Button>
        )}
        <Button
          aria-label={`Remove ${manifest.name}`}
          size="sm"
          variant="outline"
          onClick={() => void act(() => bridge.removePlugin(manifest.id))}
        >
          Remove
        </Button>
      </div>
      {manifest.access !== 'none' && (
        <PageAccessEditor pluginId={manifest.id} most={manifest.access} />
      )}
    </li>
  );
}

type Place = { value: string; label: string; spaceId: string; folderId: string | null };

/** Every space and folder this person can choose for a plugin, by path. */
function usePlaces(ctx: ClientContext): Place[] {
  const { data: spaces = [] } = useQuery(spacesQuery(ctx));
  const { data: shared = [] } = useQuery(sharedWithMeQuery(ctx));
  const spaceIds = [
    ...new Set([...spaces.map((space) => space.id), ...shared.map((item) => item.share.spaceId)]),
  ];
  const trees = useQueries({ queries: spaceIds.map((spaceId) => treeQuery(ctx, spaceId)) });
  return spaceIds.flatMap((spaceId, at) => {
    const space = spaces.find((held) => held.id === spaceId);
    const top = space ? (searchOperations.nameOf(space.metadata) ?? 'Unnamed space') : null;
    const folders = trees[at]?.data?.folders ?? [];
    const byId = new Map<string, (typeof folders)[number]>(
      folders.map((folder) => [folder.id, folder]),
    );
    const path = (id: string) => {
      const names: string[] = [];
      for (let at: string | null = id; at !== null; at = byId.get(at)?.parentId ?? null) {
        names.unshift(searchOperations.nameOf(byId.get(at)?.metadata ?? null) ?? 'Unnamed');
        if (names.length > 50) break;
      }
      return [...(top ? [top] : []), ...names].join(' / ');
    };
    return [
      ...(top
        ? [{ value: `${spaceId}:`, label: `${top} (whole space)`, spaceId, folderId: null }]
        : []),
      ...folders.map((folder) => ({
        value: `${spaceId}:${folder.id}`,
        label: path(folder.id),
        spaceId,
        folderId: folder.id,
      })),
    ];
  });
}

/** Where one plugin may read or write, for the open account. */
function PageAccessEditor({ pluginId, most }: { pluginId: string; most: PageAccess }) {
  const vault = useVault();
  usePlugins();
  if (vault.status !== 'unlocked') {
    return <p className="text-sm text-muted-foreground">Unlock your vault to choose its pages.</p>;
  }
  return <PageAccessList ctx={vault.ctx} pluginId={pluginId} most={most} />;
}

function PageAccessList({
  ctx,
  pluginId,
  most,
}: {
  ctx: ClientContext;
  pluginId: string;
  most: PageAccess;
}) {
  const places = usePlaces(ctx);
  const scopes = pluginRuntime.access(pluginId);
  const [place, setPlace] = useState<string | null>(null);
  const [access, setAccess] = useState<PluginScope['access']>('read');
  const [error, setError] = useState<string | null>(null);
  const save = (next: PluginScope[]) =>
    pluginRuntime.setAccess(pluginId, next).catch((failure: unknown) => setError(message(failure)));
  const labelOf = (scope: PluginScope) =>
    places.find((option) => option.spaceId === scope.spaceId && option.folderId === scope.folderId)
      ?.label ?? 'A place you can no longer open';
  const chosen = places.find((option) => option.value === place);
  return (
    <div className="grid gap-2 text-sm">
      <strong>Page access</strong>
      {scopes.length === 0 ? (
        <p className="text-muted-foreground">No pages yet.</p>
      ) : (
        <ul className="grid gap-1" aria-label="Page access">
          {scopes.map((scope, at) => (
            <li key={`${scope.spaceId}:${scope.folderId}`} className="flex items-center gap-2">
              <span className="flex-1">
                {labelOf(scope)}: {scope.access === 'write' ? 'read and write' : 'read'}
              </span>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void save(scopes.filter((_, other) => other !== at))}
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Picker
          label="Where"
          className="w-auto min-w-48 flex-1"
          value={place}
          placeholder="Choose a space or folder"
          options={places.map(({ value, label }) => ({ value, label }))}
          onChange={setPlace}
        />
        {most === 'write' && (
          <Picker
            label="Access"
            className="w-auto"
            value={access}
            options={[
              { value: 'read', label: 'Read' },
              { value: 'write', label: 'Read and write' },
            ]}
            onChange={setAccess}
          />
        )}
        <Button
          size="sm"
          disabled={!chosen}
          onClick={() => {
            if (!chosen) return;
            const scope: PluginScope = {
              spaceId: chosen.spaceId,
              folderId: chosen.folderId,
              access: most === 'write' ? access : 'read',
            };
            const others = scopes.filter(
              (other) => other.spaceId !== scope.spaceId || other.folderId !== scope.folderId,
            );
            void save([...others, scope]);
            setPlace(null);
          }}
        >
          Add
        </Button>
      </div>
      {error && <FormMessage>{error}</FormMessage>}
    </div>
  );
}
