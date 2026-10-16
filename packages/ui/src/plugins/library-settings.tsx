import { pluginOperations, type ClientContext } from '@wikistow/client';
import { pluginRoutes, type PluginUploadFile } from '@wikistow/contracts';
import { trustLevel } from '@wikistow/plugin-sdk/manifest';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
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
import { api, meQuery } from '../api';
import { desktop } from '../desktop';
import { errorMessage } from '../errors';
import { useVault } from '../vault/store';
import {
  asInstalled,
  LIBRARY_KEY,
  libraryQuery,
  privatePluginsQuery,
  readUpload,
  uploadAndInstall,
  type LibraryPlugin,
  type LibraryVersion,
  type PluginUpload,
} from './library';
import {
  ACCESS,
  Approval,
  LEVELS,
  PluginRow,
  SafeModeNotice,
  type ApprovalRequest,
} from './plugin-settings';
import { pluginRuntime, usePlugins } from './runtime';

/** A library version to approve, as a new install or as an update of the one approved. */
type Request = ApprovalRequest & { id: string; hash: string };

const requestFor = (id: string, version: LibraryVersion): Request => ({
  ...asInstalled(version, true),
  id,
  hash: version.hash,
  replaces: null,
});

type Visibility = pluginRoutes.PluginVisibility;

const VISIBILITY = [
  { value: 'shared', label: 'Shared' },
  { value: 'private', label: 'Only me' },
] as const;

/** What removing from the library takes away: a whole plugin, or one version. */
type Removal = { plugin: LibraryPlugin; version: LibraryVersion | null };

const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium' });
const size = (bytes: number) =>
  bytes < 1024 * 1024 ? `${Math.ceil(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/**
 * Settings → Plugins in the browser (ADR 0002): the plugins this account
 * installed from the server's library, each on or off with its page access
 * and any update waiting, then the library itself, to install from, upload
 * to (which installs it) and remove from. What is installed is in the
 * account's encrypted contacts record, so it shows only while the vault is open.
 */
export function LibrarySettings() {
  const vault = useVault();
  if (vault.status !== 'unlocked') {
    return (
      <p className="text-sm text-muted-foreground">
        Unlock your vault to see your plugins. Which ones you installed is encrypted.
      </p>
    );
  }
  return (
    <div className="grid gap-4">
      <SafeModeNotice />
      <Library ctx={vault.ctx} />
    </div>
  );
}

/**
 * The library plugins this account installed, then the library. The
 * browser's whole section; in the desktop app, the part below the plugins
 * installed from folders. There a plugin runs from the copy the app keeps,
 * even once the library drops its version, and a folder install of the
 * same ID replaces it on that computer. The desktop shares to the library
 * from an installed plugin or a workshop version, not by choosing a folder.
 * The owner of a plugin chooses whether it is Shared or Only me.
 */
export function Library({ ctx }: { ctx: ClientContext }) {
  const queryClient = useQueryClient();
  const { data: library, error: listError } = useQuery(libraryQuery(ctx));
  const { data: onlyMe } = useQuery(privatePluginsQuery);
  const { data: me } = useQuery(meQuery);
  // Its problems, and drawn again as each change lands.
  const { plugins: running, listed, unavailable } = usePlugins();
  // The runtime lists the library at unlock; if that failed, the library
  // shown here means the server answers again.
  useEffect(() => {
    if (library && !listed) void pluginRuntime.refresh();
  }, [library, listed]);
  const approvals = pluginOperations.listPluginApprovals(ctx);
  const [request, setRequest] = useState<Request | null>(null);
  const [removal, setRemoval] = useState<Removal | null>(null);
  const [upload, setUpload] = useState<PluginUpload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const admin = me?.account.role === 'admin';

  /** Run a change, then show the library and the runtime afresh. A string it returns is said. */
  const act = async (run: () => Promise<unknown>) => {
    setError(null);
    setNotice(null);
    try {
      const done = await run();
      if (typeof done === 'string') setNotice(done);
    } catch (failure) {
      setError(errorMessage(failure));
    }
    await queryClient.invalidateQueries({ queryKey: LIBRARY_KEY });
    await pluginRuntime.refresh();
  };
  const approve = ({ id, hash }: Request) =>
    act(async () => {
      if (approvals.some((approval) => approval.id === id))
        await pluginOperations.updatePlugin(ctx, id, hash);
      else await pluginOperations.approvePlugin(ctx, { id, hash, access: [] });
    });

  const inLibrary = (id: string) => library?.find((plugin) => plugin.id === id);
  const installedLabel = desktop ? 'Installed from the library' : 'Installed plugins';

  return (
    <div className="grid gap-4">
      {desktop && approvals.length > 0 && <h3 className="font-bold">{installedLabel}</h3>}
      {approvals.length > 0 && (
        <ul className="grid gap-3" aria-label={installedLabel}>
          {approvals.map((approval) => {
            const plugin = inLibrary(approval.id);
            const version = plugin?.versions.find((each) => each.hash === approval.hash);
            const newest = plugin?.versions[0];
            const status = running.find(({ plugin }) => plugin.manifest.id === approval.id);
            // What runs: in a browser the library's version, in the desktop app its copy,
            // which stays when the library drops the version.
            const runs =
              status?.plugin.library && status.plugin.key === approval.hash ? status : null;
            // In the desktop app, a folder install of the same ID runs instead.
            const replaced = status !== undefined && !status.plugin.library;
            const shown = runs?.plugin ?? (version ? asInstalled(version, true) : null);
            if (!shown) {
              if (!library) return null;
              return (
                <li
                  key={approval.id}
                  aria-label={newest?.manifest.name ?? approval.id}
                  className="grid gap-2 rounded-control border border-border p-3"
                >
                  <strong>{newest?.manifest.name ?? approval.id}</strong>
                  <p className="text-sm text-muted-foreground">
                    The version you installed is no longer in the library, so it doesn’t load. Pages
                    keep its blocks.
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {plugin && newest && (
                      <Button size="sm" onClick={() => setRequest(requestFor(plugin.id, newest))}>
                        Install {newest.manifest.version}…
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        void act(() => pluginOperations.removePlugin(ctx, approval.id))
                      }
                    >
                      Remove
                    </Button>
                  </div>
                </li>
              );
            }
            const installed = { ...shown, enabled: approval.enabled };
            const update = newest && newest.hash !== approval.hash ? newest : null;
            return (
              <PluginRow
                key={approval.id}
                status={{
                  plugin: installed,
                  problem: runs?.problem ?? unavailable[approval.id] ?? null,
                }}
                onEnabled={(on) =>
                  void act(() => pluginOperations.setPluginEnabled(ctx, approval.id, on))
                }
                onRemove={() => void act(() => pluginOperations.removePlugin(ctx, approval.id))}
                pageAccess={!replaced}
                note={
                  <>
                    {replaced && (
                      <p className="text-sm text-muted-foreground">
                        A plugin installed from a folder on this computer replaces it here, until
                        you remove that one.
                      </p>
                    )}
                    {update && (
                      <p className="text-sm">
                        Version {update.manifest.version} is in the library.
                      </p>
                    )}
                  </>
                }
                actions={
                  update && (
                    <Button
                      size="sm"
                      onClick={() =>
                        setRequest({
                          ...requestFor(approval.id, update),
                          replaces: {
                            version: installed.manifest.version,
                            level: installed.level,
                            access: installed.manifest.access,
                          },
                        })
                      }
                    >
                      Update…
                    </Button>
                  )
                }
              />
            );
          })}
        </ul>
      )}
      {error && <FormMessage>{error}</FormMessage>}
      {notice && <FormMessage tone="notice">{notice}</FormMessage>}
      <div className="grid gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="flex-1 font-bold">Library</h3>
          {!desktop && (
            <Upload
              onFolder={(chosen) =>
                act(async () => setUpload(await readUpload(await readFolder(chosen))))
              }
            />
          )}
        </div>
        {desktop && (
          <p className="text-sm text-muted-foreground">
            Share a plugin installed on this computer, or a workshop version, to add it here.
          </p>
        )}
        {listError && <FormMessage>{errorMessage(listError)}</FormMessage>}
        {library?.length === 0 && (
          <p className="text-sm text-muted-foreground">Nobody has uploaded a plugin yet.</p>
        )}
        {library && library.length > 0 && (
          <ul className="grid gap-3" aria-label="Plugin library">
            {library.map((plugin) => (
              <LibraryRow
                key={plugin.id}
                plugin={plugin}
                installed={approvals.some((approval) => approval.id === plugin.id)}
                removable={plugin.mine || admin}
                visibility={onlyMe?.has(plugin.id) ? 'private' : 'shared'}
                onInstall={(version) => setRequest(requestFor(plugin.id, version))}
                onRemove={(version) => setRemoval({ plugin, version })}
                onVisibility={(visibility) =>
                  act(() =>
                    api.call(pluginRoutes.setVisibility, {
                      params: { pluginId: plugin.id },
                      body: { visibility },
                    }),
                  )
                }
              />
            ))}
          </ul>
        )}
      </div>
      <Approval candidate={request} onDone={() => setRequest(null)} onApprove={approve} />
      <ConfirmUpload
        ctx={ctx}
        upload={upload}
        onDone={() => setUpload(null)}
        onUpload={(chosen, visibility) =>
          act(async () => {
            const { manifest } = await uploadAndInstall(ctx, chosen, visibility);
            return `Uploaded and installed ${manifest.name} ${manifest.version}.`;
          })
        }
      />
      <RemoveFromLibrary
        removal={removal}
        onDone={() => setRemoval(null)}
        onRemove={({ plugin, version }) =>
          act(async () => {
            const params = { pluginId: plugin.id };
            if (version) {
              await api.call(pluginRoutes.removeVersion, {
                params: { ...params, hash: version.hash },
              });
            } else await api.call(pluginRoutes.removePlugin, { params });
          })
        }
      />
    </div>
  );
}

/**
 * A chosen folder's files as an upload, each path from the folder's top.
 * Paths are checked here as the server checks them, naming the first bad
 * file, and so are the limits, before anything is sent.
 */
async function readFolder(chosen: File[]): Promise<PluginUploadFile[]> {
  if (chosen.length > pluginRoutes.MAX_VERSION_FILES)
    throw new Error(`A plugin holds at most ${pluginRoutes.MAX_VERSION_FILES} files.`);
  const bytes = chosen.reduce((total, file) => total + file.size, 0);
  if (bytes > pluginRoutes.MAX_VERSION_BYTES)
    throw new Error(`A plugin holds at most ${size(pluginRoutes.MAX_VERSION_BYTES)}.`);
  const files = chosen.map((file) => ({
    file,
    shown: file.webkitRelativePath || file.name,
    // The chosen folder's own name comes first.
    path: file.webkitRelativePath.split('/').slice(1).join('/') || file.name,
  }));
  for (const { path, shown } of files) {
    const problem = pluginRoutes.uploadPathProblem(path, shown);
    if (problem) throw new Error(problem);
  }
  return Promise.all(
    files.map(async ({ file, path }) => ({ path, data: new Uint8Array(await file.arrayBuffer()) })),
  );
}

/** Pick, on a computer, a built plugin's folder to upload. Phones can't choose folders. */
function Upload({ onFolder }: { onFolder: (files: File[]) => Promise<void> }) {
  const input = useRef<HTMLInputElement | null>(null);
  const [computer] = useState(() => window.matchMedia('(any-pointer: fine)').matches);
  if (!computer) {
    return <p className="text-sm text-muted-foreground">Uploading a plugin needs a computer.</p>;
  }
  return (
    <>
      <Button size="sm" variant="outline" onClick={() => input.current?.click()}>
        Upload plugin folder…
      </Button>
      <input
        ref={(element) => {
          input.current = element;
          // Not in React's types: lets the person choose a whole folder.
          element?.setAttribute('webkitdirectory', '');
        }}
        type="file"
        hidden
        aria-label="Plugin folder"
        onChange={(event) => {
          const files = [...(event.target.files ?? [])];
          // So choosing the same folder again, once it is fixed, sends it again.
          event.target.value = '';
          if (files.length > 0) void onFolder(files);
        }}
      />
    </>
  );
}

/**
 * One plugin in the library: its newest version's name, description, trust
 * level and most page access, its owner, Install unless it is installed,
 * and its versions with their hashes.
 */
function LibraryRow({
  plugin,
  installed,
  removable,
  visibility,
  onInstall,
  onRemove,
  onVisibility,
}: {
  plugin: LibraryPlugin;
  installed: boolean;
  removable: boolean;
  /** Known for the caller's own plugins only. */
  visibility: Visibility;
  onInstall: (version: LibraryVersion) => void;
  /** Remove one version, or with null the whole plugin. */
  onRemove: (version: LibraryVersion | null) => void;
  onVisibility: (visibility: Visibility) => Promise<void>;
}) {
  const [newest] = plugin.versions;
  if (!newest) return null;
  const { manifest } = newest;
  const level = LEVELS[asInstalled(newest, true).level];
  return (
    <li className="grid gap-2 rounded-control border border-border p-3" aria-label={manifest.name}>
      <div className="flex flex-wrap items-center gap-2">
        <strong>{manifest.name}</strong>
        <span className="text-sm text-muted-foreground">{manifest.version}</span>
        <Badge variant="secondary">{level.label}</Badge>
        {installed && <Badge variant="outline">Installed</Badge>}
        {plugin.mine && visibility === 'private' && <Badge variant="outline">Only me</Badge>}
      </div>
      {manifest.description && <p className="text-sm">{manifest.description}</p>}
      <p className="text-sm text-muted-foreground">
        Asks for {ACCESS[manifest.access]}. Uploaded by {plugin.owner.name}
        {plugin.mine && ' (you)'}.
      </p>
      <div className="flex flex-wrap gap-2">
        {plugin.mine && (
          <Picker
            label="Who sees it"
            className="h-8 w-auto"
            value={visibility}
            options={VISIBILITY}
            onChange={(chosen) => void onVisibility(chosen)}
          />
        )}
        {!installed && (
          <Button size="sm" onClick={() => onInstall(newest)}>
            Install…
          </Button>
        )}
        {removable && (
          <Button size="sm" variant="outline" onClick={() => onRemove(null)}>
            Remove from library
          </Button>
        )}
      </div>
      <details className="text-sm">
        <summary className="cursor-pointer text-muted-foreground">
          {plugin.versions.length === 1 ? '1 version' : `${plugin.versions.length} versions`}
        </summary>
        <ul className="mt-2 grid gap-2" aria-label={`${manifest.name} versions`}>
          {plugin.versions.map((version) => (
            <li key={version.hash} className="grid gap-1">
              <div className="flex flex-wrap items-center gap-2">
                <span>
                  {version.manifest.version}, {day(version.uploadedAt)}, {size(version.size)}
                </span>
                {removable && plugin.versions.length > 1 && (
                  <Button size="sm" variant="outline" onClick={() => onRemove(version)}>
                    Remove version
                  </Button>
                )}
              </div>
              <code className="text-xs break-all text-muted-foreground">{version.hash}</code>
            </li>
          ))}
        </ul>
      </details>
    </li>
  );
}

/** Confirm removing a plugin, or one version, from the library: for everyone, not only here. */
function RemoveFromLibrary({
  removal,
  onDone,
  onRemove,
}: {
  removal: Removal | null;
  onDone: () => void;
  onRemove: (removal: Removal) => Promise<void>;
}) {
  const name = removal?.plugin.versions[0]?.manifest.name;
  return (
    <Dialog open={removal !== null} onOpenChange={(open) => !open && onDone()}>
      {removal && (
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {removal.version
                ? `Remove version ${removal.version.manifest.version} of ${name}?`
                : `Remove ${name} from the library?`}
            </DialogTitle>
            <DialogDescription>
              Its files are deleted from the server for everyone. Browsers that installed it stop
              loading it; desktop apps keep their copy. Pages keep its blocks.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={onDone}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={() => void onRemove(removal).then(onDone)}>
              Remove
            </Button>
          </DialogFooter>
        </DialogContent>
      )}
    </Dialog>
  );
}

/**
 * Confirm uploading a plugin to the library (ADR 0004), whichever way it
 * is uploaded: the approval dialog for its version, as an update of the
 * one installed if there is one, with the choice of Shared or Only me.
 * Uploading installs it for the person, so confirming does both:
 * `onUpload` runs `uploadAndInstall` and says how it went. `visibility` is
 * left out unless it changes, so a server from before ADR 0004, which
 * refuses the field, still takes the upload.
 */
export function ConfirmUpload({
  ctx,
  upload,
  onDone,
  onUpload,
}: {
  ctx: ClientContext;
  upload: PluginUpload | null;
  onDone: () => void;
  onUpload: (upload: PluginUpload, visibility: Visibility | undefined) => Promise<void>;
}) {
  const { data: library } = useQuery(libraryQuery(ctx));
  const { data: onlyMe, isError } = useQuery(privatePluginsQuery);
  // The person's choice for this upload; until they make one, the plugin's own.
  const [choice, setChoice] = useState<{ upload: PluginUpload; visibility: Visibility } | null>(
    null,
  );
  const id = upload?.manifest.id;
  // Unknown until the server says, and what is shown is then always sent.
  // A server without the route (from before ADR 0004) has no Only me.
  const known = onlyMe ?? (isError ? new Set<string>() : null);
  const current = known && (id && known.has(id) ? 'private' : 'shared');
  const visibility = choice && choice.upload === upload ? choice.visibility : (current ?? 'shared');
  const approved = pluginOperations.listPluginApprovals(ctx).find((each) => each.id === id);
  const installed = library
    ?.find((plugin) => plugin.id === id)
    ?.versions.find((version) => version.hash === approved?.hash)?.manifest;
  const candidate = upload && {
    ...upload,
    level: trustLevel(upload.manifest),
    development: null,
    replaces:
      installed && approved?.hash !== upload.hash
        ? { version: installed.version, level: trustLevel(installed), access: installed.access }
        : null,
  };
  return (
    <Approval
      candidate={candidate}
      verb="Upload"
      onDone={onDone}
      onApprove={(chosen) => onUpload(chosen, visibility === current ? undefined : visibility)}
    >
      <Picker
        label="Who sees it"
        className="w-auto justify-self-start"
        value={visibility}
        options={VISIBILITY}
        onChange={(chosen) => upload && setChoice({ upload, visibility: chosen })}
      />
      <p>
        {visibility === 'shared'
          ? 'Everyone on this server can see it in the library and install it.'
          : 'Only you see it in the library. Anyone who already installed it keeps it and its updates.'}{' '}
        Its files are plain text on the server.
      </p>
      <p>
        Uploading installs it for you, on all your devices. Only the account that first uploaded{' '}
        {id} can add versions of it.
      </p>
    </Approval>
  );
}
