import type { ClientContext } from '@wikistow/client';
import { libraryInstall, pluginRoutes } from '@wikistow/contracts';
import { MANIFEST_FILE, platformWarnings, trustLevel } from '@wikistow/plugin-sdk/manifest';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
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
import { aiStatusQuery } from '../ai/session';
import { api, meQuery } from '../api';
import { desktop } from '../desktop';
import { errorMessage } from '../errors';
import { useNewDraft } from '../workshop/drafts';
import { ChooseFolder, folderFiles } from './choose-folder';
import { DEVICE_LABELS, DeviceTags, useDevice, Warning, worksOn } from './devices';
import {
  LIBRARY_KEY,
  libraryQuery,
  libraryRequest,
  privatePluginsQuery,
  readFolder,
  readUpload,
  size,
  uploadAndInstall,
  type LibraryPlugin,
  type LibraryVersion,
  type PluginUpload,
} from './library';
import {
  ACCESS,
  Approval,
  InstalledList,
  itemText,
  LEVELS,
  matches,
  PluginRow,
  type InstalledItem,
  type PluginsView,
} from './plugin-settings';
import { useAppPlugins } from './app-plugins';
import { usePlugins } from './runtime';
import type { LibraryRequest, PluginRef } from './store';

type Visibility = pluginRoutes.PluginVisibility;

const VISIBILITY = [
  { value: 'shared', label: 'Shared' },
  { value: 'private', label: 'Only me' },
] as const;

/** What removing from the library takes away: a whole plugin, or one version. */
type Removal = { plugin: LibraryPlugin; version: LibraryVersion | null };

const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium' });

/**
 * The library plugins this account installed (ADR 0002), in the Installed
 * tab, each on or off with its page access and any update waiting, and the
 * library, in the Library tab, to install from, upload to (which installs
 * it) and remove from. What is installed is in the account's encrypted
 * contacts record, so it shows only while the vault is open. In the
 * desktop app the installed ones are listed with its `folder` installs.
 * There a plugin runs from the copy the app keeps, even once the library
 * drops its version, and a folder install of the same ID replaces it on
 * that computer. The desktop shares to the library from an installed
 * plugin, not by choosing a folder.
 * The owner of a plugin chooses whether it is Shared or Only me.
 */
export function Library({
  ctx,
  tab,
  query,
  folder = [],
}: PluginsView & { ctx: ClientContext; folder?: InstalledItem[] }) {
  const { store: pluginStore, runtime: pluginRuntime } = useAppPlugins();
  const queryClient = useQueryClient();
  const { data: library, error: listError } = useQuery(libraryQuery(ctx));
  const { data: onlyMe } = useQuery(privatePluginsQuery);
  const { data: me } = useQuery(meQuery);
  // Its problems, and drawn again as each change lands.
  const { plugins: running, listed, unavailable, safeMode, offHere } = usePlugins();
  const { data: ai } = useQuery(aiStatusQuery);
  const newDraft = useNewDraft();
  const navigate = useNavigate();
  // The runtime lists the library at unlock; if that failed, the library
  // shown here means the server answers again.
  useEffect(() => {
    if (library && !listed) void pluginRuntime.refresh();
  }, [library, listed]);
  const approvals = pluginStore.approvals();
  const [request, setRequest] = useState<LibraryRequest | null>(null);
  const [removal, setRemoval] = useState<Removal | null>(null);
  const [upload, setUpload] = useState<PluginUpload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Only the plugins that say they work on this device, fully or partly.
  const [here, setHere] = useState(false);
  const device = useDevice();
  const admin = me?.account.role === 'admin';

  /** Run a change, then show the library and the runtime afresh. A string it returns is said. */
  const act = async (run: () => Promise<unknown>) => {
    setError(null);
    setNotice(null);
    newDraft.clear();
    try {
      const done = await run();
      if (typeof done === 'string') setNotice(done);
    } catch (failure) {
      setError(errorMessage(failure));
    }
    await queryClient.invalidateQueries({ queryKey: LIBRARY_KEY });
    await pluginRuntime.refresh();
  };
  const approve = (chosen: LibraryRequest) => act(() => pluginStore.approve(chosen));

  const inLibrary = (id: string) => library?.find((plugin) => plugin.id === id);
  const installed = approvals.flatMap((approval): InstalledItem[] => {
    const plugin = inLibrary(approval.id);
    const version = plugin?.versions.find((each) => each.hash === approval.hash);
    const newest = plugin?.versions[0];
    const status = running.find(({ plugin }) => plugin.manifest.id === approval.id);
    // What runs: in a browser the library's version, in the desktop app its copy,
    // which stays when the library drops the version.
    const runs = status?.plugin.library && status.plugin.key === approval.hash ? status : null;
    // In the desktop app a folder install of the same ID runs instead, in a
    // browser a development folder.
    const replaced = status !== undefined && !status.plugin.library;
    const shown =
      runs?.plugin ?? (version ? libraryInstall(version.manifest, version.hash, true) : null);
    const key = `library:${approval.id}`;
    const ref: PluginRef = { id: approval.id, library: true };
    if (!shown) {
      if (!library) return [];
      const name = newest?.manifest.name ?? approval.id;
      return [
        {
          key,
          text: newest ? itemText(newest.manifest) : approval.id,
          problem: true,
          row: (
            <li aria-label={name} className="grid gap-2 rounded-control border border-border p-3">
              <strong>{name}</strong>
              <p className="text-sm text-muted-foreground">
                The version you installed is no longer in the library, so it doesn’t load. Pages
                keep its blocks.
              </p>
              <div className="flex flex-wrap gap-2">
                {plugin && newest && (
                  <Button size="sm" onClick={() => setRequest(libraryRequest(newest))}>
                    Install {newest.manifest.version}…
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void act(() => pluginStore.remove(ref))}
                >
                  Remove
                </Button>
              </div>
            </li>
          ),
        },
      ];
    }
    const plugged = { ...shown, enabled: approval.enabled };
    const update = newest && newest.hash !== approval.hash ? newest : null;
    const problem = runs?.problem ?? unavailable[approval.id] ?? null;
    return [
      {
        key,
        text: itemText(plugged.manifest),
        problem: problem !== null,
        row: (
          <PluginRow
            status={{ plugin: plugged, problem }}
            onEnabled={(on) => void act(() => pluginStore.enable(ref, on))}
            onRemove={() => void act(() => pluginStore.remove(ref))}
            here={!replaced}
            offHere={
              replaced
                ? undefined
                : {
                    off: offHere.includes(approval.id),
                    onChange: (off) => void act(() => pluginStore.setOffHere(ref, off)),
                  }
            }
            note={
              <>
                {replaced && (
                  <p className="text-sm text-muted-foreground">
                    {desktop
                      ? 'A plugin installed from a folder on this computer replaces it here, until you remove that one.'
                      : 'A development folder loaded in this tab replaces it here, until you remove that one.'}
                  </p>
                )}
                {update && (
                  <p className="text-sm">Version {update.manifest.version} is in the library.</p>
                )}
              </>
            }
            actions={
              update && (
                <Button
                  size="sm"
                  onClick={() => setRequest(libraryRequest(update, plugged.manifest))}
                >
                  Update…
                </Button>
              )
            }
          />
        ),
      },
    ];
  });
  const listedHere = library?.filter((plugin) => {
    const [newest] = plugin.versions;
    return (
      newest &&
      matches(query, itemText(newest.manifest)) &&
      (!here || worksOn(newest.manifest.platforms, device))
    );
  });
  const thisDevice = `this ${DEVICE_LABELS[device].toLowerCase()}`;

  return (
    <div className="grid gap-4">
      {(error ?? newDraft.error) && <FormMessage>{error ?? newDraft.error}</FormMessage>}
      {notice && <FormMessage tone="notice">{notice}</FormMessage>}
      {listError && <FormMessage>{errorMessage(listError)}</FormMessage>}
      {tab === 'installed' ? (
        <InstalledList
          items={[...folder, ...installed]}
          query={query}
          // Rows wait for the library, which says what each approval is.
          loading={!library && approvals.length > 0}
        />
      ) : (
        <div className="grid gap-2">
          {desktop ? (
            <p className="text-sm text-muted-foreground">
              Share a plugin installed on this computer to add it here.
            </p>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <ChooseFolder
                label="Upload plugin folder…"
                name="Plugin folder"
                phone="Uploading a plugin needs a computer."
                onFolder={(chosen) =>
                  act(async () =>
                    setUpload(await readUpload(await readFolder(folderFiles(chosen)))),
                  )
                }
              />
            </div>
          )}
          {library && library.length > 0 && (
            <label className="flex items-center gap-2 text-sm">
              <Switch checked={here} onCheckedChange={setHere} />
              Works on {thisDevice}
            </label>
          )}
          {library?.length === 0 && (
            <p className="text-sm text-muted-foreground">Nobody has uploaded a plugin yet.</p>
          )}
          {library && library.length > 0 && listedHere?.length === 0 && (
            <p className="text-sm text-muted-foreground">
              {here
                ? `No plugin in the library that matches says it works on ${thisDevice}.`
                : 'No plugin in the library matches.'}
            </p>
          )}
          {listedHere && listedHere.length > 0 && (
            <ul className="grid gap-3" aria-label="Plugin library">
              {listedHere.map((plugin) => (
                <LibraryRow
                  key={plugin.id}
                  plugin={plugin}
                  installed={approvals.some((approval) => approval.id === plugin.id)}
                  removable={plugin.mine || admin}
                  visibility={onlyMe?.has(plugin.id) ? 'private' : 'shared'}
                  onInstall={(version) => setRequest(libraryRequest(version))}
                  onChange={
                    ai?.enabled && !safeMode && !newDraft.busy
                      ? async (version) => {
                          setError(null);
                          setNotice(null);
                          const from = { pluginId: plugin.id, hash: version.hash };
                          if (await newDraft.start({ from })) await navigate({ to: '/workshop' });
                        }
                      : null
                  }
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
      )}
      {newDraft.dialog}
      <Approval candidate={request} onDone={() => setRequest(null)} onApprove={approve} />
      <ConfirmUpload
        ctx={ctx}
        upload={upload}
        onDone={() => setUpload(null)}
        onUpload={(chosen, visibility) =>
          act(async () => {
            const { manifest } = await uploadAndInstall(pluginStore, chosen, visibility);
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
 * One plugin in the library: its newest version's name, description, trust
 * level, devices and most page access, its owner, Install unless it is installed,
 * Change with the assistant if the version carries its source, and its
 * versions with their hashes.
 */
function LibraryRow({
  plugin,
  installed,
  removable,
  visibility,
  onInstall,
  onChange,
  onRemove,
  onVisibility,
}: {
  plugin: LibraryPlugin;
  installed: boolean;
  removable: boolean;
  /** Known for the caller's own plugins only. */
  visibility: Visibility;
  onInstall: (version: LibraryVersion) => void;
  /** Start a draft from a version's source in the workshop, or null where there's no workshop now. */
  onChange: ((version: LibraryVersion) => Promise<void>) | null;
  /** Remove one version, or with null the whole plugin. */
  onRemove: (version: LibraryVersion | null) => void;
  onVisibility: (visibility: Visibility) => Promise<void>;
}) {
  const [newest] = plugin.versions;
  if (!newest) return null;
  const { manifest } = newest;
  const level = LEVELS[trustLevel(manifest)];
  return (
    <li className="grid gap-2 rounded-control border border-border p-3" aria-label={manifest.name}>
      <div className="flex flex-wrap items-center gap-2">
        <strong>{manifest.name}</strong>
        <span className="text-sm text-muted-foreground">{manifest.version}</span>
        <Badge variant="secondary">{level.label}</Badge>
        <DeviceTags platforms={manifest.platforms} />
        {installed && <Badge variant="outline">Installed</Badge>}
        {plugin.mine && visibility === 'private' && <Badge variant="outline">Only me</Badge>}
      </div>
      {manifest.description && <p className="text-sm">{manifest.description}</p>}
      {manifest.platforms?.note && (
        <p className="text-sm text-muted-foreground">{manifest.platforms.note}</p>
      )}
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
        {onChange && newest.files.includes(`source/${MANIFEST_FILE}`) && (
          <Button size="sm" variant="outline" onClick={() => void onChange(newest)}>
            Change with the assistant
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
 * one installed if there is one, with the choice of Shared or Only me,
 * and a warning where its devices contradict its code (`platformWarnings`).
 * Uploading installs it for the person, so confirming does both:
 * `onUpload` runs `uploadAndInstall` and says how it went. `visibility` is
 * left out unless it changes, so a server from before ADR 0004, which
 * refuses the field, still takes the upload.
 */
export function ConfirmUpload({
  ctx,
  upload,
  verb = 'Upload',
  onDone,
  onUpload,
}: {
  ctx: ClientContext;
  upload: PluginUpload | null;
  /** What confirming says it does, such as Publish in the workshop. */
  verb?: string;
  onDone: () => void;
  onUpload: (upload: PluginUpload, visibility: Visibility | undefined) => Promise<void>;
}) {
  const { store: pluginStore } = useAppPlugins();
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
  const approved = pluginStore.approvals().find((each) => each.id === id);
  const installed = library
    ?.find((plugin) => plugin.id === id)
    ?.versions.find((version) => version.hash === approved?.hash)?.manifest;
  const candidate = upload && {
    ...upload,
    ...libraryRequest(upload, installed && approved?.hash !== upload.hash ? installed : null),
  };
  const warnings = upload
    ? platformWarnings(upload.manifest, new Map(upload.files.map(({ path, data }) => [path, data])))
    : [];
  return (
    <Approval
      candidate={candidate}
      verb={verb}
      onDone={onDone}
      onApprove={(chosen) => onUpload(chosen, visibility === current ? undefined : visibility)}
    >
      {warnings.map((warning) => (
        <Warning key={warning}>{warning}</Warning>
      ))}
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
        This installs it for you, on all your devices. Only the account that first uploaded {id} can
        add versions of it.
      </p>
    </Approval>
  );
}
