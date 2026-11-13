import { searchOperations, type ClientContext } from '@wikistow/client';
import type { InstalledPlugin, PluginCandidate, PluginScope } from '@wikistow/contracts';
import {
  blockLanguage,
  isReplaceable,
  REGIONS,
  type Manifest,
  type PageAccess,
  type Replacements,
  type TrustLevel,
} from '@wikistow/plugin-sdk';
import { fencePart } from '@wikistow/plugin-sdk/manifest';
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
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
import { desktop } from '../desktop';
import { sharedWithMeQuery, spacesQuery, treeQuery } from '../data/queries';
import { ScopePill, SettingRow, THIS_DEVICE } from '../settings/rows';
import { useVault } from '../vault/store';
import { LIBRARY_KEY, readUpload, uploadAndInstall, type PluginUpload } from './library';
import { ChooseFolder } from './choose-folder';
import { CommandShortcuts } from './command-shortcuts';
import { DeclaredSettings } from './declared-settings';
import { ApprovalDevices } from './devices';
import { pickFolder } from './development';
import { ConfirmUpload, Library } from './library-settings';
// This file's own `Place` is a place for page access.
import { Place as RegionPlace, REPLACED } from './places';
import { useAppPlugins } from './app-plugins';
import { usePlugins, type PluginStatus } from './runtime';
import { refOf, type ApprovalRequest, type PluginRef } from './store';

export const LEVELS: Record<TrustLevel, { label: string; trust: string }> = {
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

export const ACCESS: Record<PageAccess, string> = {
  none: 'no pages',
  read: 'reading the pages you choose',
  write: 'reading and changing drafts in the pages you choose',
};

export const message = (error: unknown) =>
  error instanceof Error ? error.message : 'Something went wrong.';

const listed = new Intl.ListFormat('en', { type: 'conjunction' });

/** The parts of the app a manifest replaces, by the names this app knows. */
const replacedParts = (manifest: Manifest) =>
  (manifest.replaces ?? []).filter(isReplaceable).map((region) => REPLACED[region].part);

const capitalized = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** The most parts of the app one plugin's approval gives back (`ownParts`), regions and languages. */
const MAX_OWN_PARTS = 20;

/** The bare fence languages a manifest claims (`fences`), in its order. */
const fencesOf = (manifest: Manifest) => Object.keys(manifest.fences ?? {});

/** Says safe mode is on, with the way out, on the Plugins page wherever plugins come from. */
export function SafeModeNotice() {
  const { runtime: pluginRuntime } = useAppPlugins();
  const { safeMode } = usePlugins();
  if (!safeMode) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      Safe mode: no plugins are running.
      <Button size="sm" variant="outline" onClick={() => void pluginRuntime.setSafeMode(false)}>
        Turn plugins back on
      </Button>
    </div>
  );
}

/**
 * Settings' one Plugins row: how many are installed and on, any that need
 * attention in the destructive colour, safe mode, and Manage plugins.
 */
export function PluginsSummary() {
  const { listed, safeMode, plugins, unavailable } = usePlugins();
  const vault = useVault();
  // Library plugins are known only while the vault is open, in the desktop app too.
  const known = listed && vault.status === 'unlocked';
  // One that couldn't load is installed too, and needs attention.
  const installed = new Set([
    ...plugins.map(({ plugin }) => plugin.manifest.id),
    ...Object.keys(unavailable),
  ]).size;
  const on = plugins.filter(({ plugin }) => plugin.enabled).length;
  const troubled = new Set([
    ...plugins.filter(({ problem }) => problem).map(({ plugin }) => plugin.manifest.id),
    ...Object.keys(unavailable),
  ]).size;
  return (
    <SettingRow
      name="Your plugins"
      state={
        <>
          {!known
            ? 'Unlock your vault to see your plugins.'
            : installed === 0
              ? 'No plugins yet'
              : `${installed} installed · ${on} on`}
          {troubled > 0 && (
            <span className="text-destructive">
              {' · '}
              {troubled === 1 ? '1 needs attention' : `${troubled} need attention`}
            </span>
          )}
          {safeMode && <span className="block">Safe mode: plugins are off.</span>}
        </>
      }
      action={
        <Button size="sm" variant="outline" asChild>
          <Link to="/settings/plugins">Manage plugins</Link>
        </Button>
      }
    />
  );
}

/** What the Plugins page shows: its tab, and what is searched for. */
export type PluginsView = { tab: 'installed' | 'library'; query: string };

/** Whether `text` (a plugin's name and description) holds what is searched for. */
export const matches = (query: string, text: string) =>
  text.toLowerCase().includes(query.trim().toLowerCase());

/** One installed plugin on the Plugins page, with what the list searches and sorts by. */
export type InstalledItem = { key: string; text: string; problem: boolean; row: ReactNode };

export const itemText = (manifest: Pick<Manifest, 'name' | 'description'>) =>
  `${manifest.name} ${manifest.description ?? ''}`;

/** The installed plugins searched for, those with a problem first. Nothing while `loading`. */
export function InstalledList({
  items,
  query,
  loading = false,
}: {
  items: InstalledItem[];
  query: string;
  loading?: boolean;
}) {
  const shown = items
    .filter((item) => matches(query, item.text))
    .toSorted((a, b) => Number(b.problem) - Number(a.problem));
  if (loading && items.length === 0) return null;
  if (items.length === 0)
    return <p className="text-sm text-muted-foreground">No plugins are installed.</p>;
  if (shown.length === 0)
    return <p className="text-sm text-muted-foreground">No installed plugin matches.</p>;
  return (
    <ul className="grid gap-3" aria-label="Installed plugins">
      {shown.map(({ key, row }) => (
        <Fragment key={key}>{row}</Fragment>
      ))}
    </ul>
  );
}

/**
 * The Plugins page's install buttons: in the desktop app, install a plugin
 * folder, or load one for development; in a computer's browser, with the
 * vault open, load one for development in this tab. Each asks for approval first.
 */
export function InstallFromFolder() {
  const { store: pluginStore, runtime: pluginRuntime } = useAppPlugins();
  const vault = useVault();
  const [candidate, setCandidate] = useState<PluginCandidate | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { folders, development } = pluginStore;
  if (!folders && !(development && vault.status === 'unlocked')) return null;
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
    act(async () => setCandidate((await folders?.pick(kind)) ?? null));
  return (
    <>
      {folders ? (
        <>
          <Button size="sm" onClick={() => void pick('install')}>
            Install plugin…
          </Button>
          <Button size="sm" variant="outline" onClick={() => void pick('development')}>
            Load development folder…
          </Button>
        </>
      ) : (
        development && (
          <ChooseFolder
            label="Load development folder…"
            name="Development folder"
            phone="Loading a development folder needs a computer."
            onFolder={(files) => act(async () => setCandidate(await development.load({ files })))}
            onPick={
              development.keepsFolder
                ? () =>
                    void act(async () => {
                      const chosen = await pickFolder();
                      if (chosen) setCandidate(await development.load(chosen));
                    })
                : undefined
            }
          />
        )
      )}
      {error && (
        <p role="alert" className="basis-full text-sm text-destructive">
          {error}
        </p>
      )}
      <Approval
        candidate={candidate}
        onDone={() => setCandidate(null)}
        onApprove={(chosen) => act(() => pluginStore.approve(chosen))}
      />
    </>
  );
}

/**
 * Reload for a development plugin: the desktop and a browser that kept
 * the folder read it again; any other browser asks for it again.
 */
function Reload({
  pluginId,
  name,
  act,
  onAsks,
}: {
  pluginId: string;
  name: string;
  act: (run: () => Promise<unknown>) => Promise<void>;
  onAsks: (candidate: PluginCandidate) => void;
}) {
  const { store: pluginStore } = useAppPlugins();
  const { folders, development } = pluginStore;
  const reload = (read: () => Promise<PluginCandidate | null> | undefined) =>
    act(async () => {
      const asks = await read();
      if (asks) onAsks(asks);
    });
  if (development && !development.keepsFolder)
    return (
      <ChooseFolder
        label="Reload…"
        name={`${name}’s folder`}
        phone="Reloading needs a computer."
        onFolder={(files) => reload(() => development.reload(pluginId, { files }))}
      />
    );
  return (
    <Button
      size="sm"
      variant="outline"
      onClick={() =>
        void reload(() => folders?.reload(pluginId) ?? development?.reload(pluginId, null))
      }
    >
      Reload
    </Button>
  );
}

/**
 * The Plugins page, through the app's plugin store: the plugins installed
 * from the library once the vault is open, and the server's library
 * (`Library`). In the desktop app, whose store also installs from a
 * folder, the plugins installed that way are listed with them (turn each
 * on or off, reload, remove, share one to the library, which installs it
 * from there on every device, and choose its pages), locked or not.
 */
export function PluginSettings({ tab, query }: PluginsView) {
  const { store: pluginStore, runtime: pluginRuntime } = useAppPlugins();
  const { plugins } = usePlugins();
  const vault = useVault();
  const queryClient = useQueryClient();
  const [candidate, setCandidate] = useState<PluginCandidate | null>(null);
  const [sharing, setSharing] = useState<PluginUpload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const { folders } = pluginStore;

  /** Run a change, then list the plugins afresh. A string it returns is said. */
  const act = async (run: () => Promise<unknown>) => {
    setError(null);
    setNotice(null);
    try {
      const done = await run();
      if (typeof done === 'string') setNotice(done);
    } catch (failure) {
      setError(message(failure));
    }
    await pluginRuntime.refresh();
  };

  // The desktop's folder installs, or this tab's development folders.
  const folder = plugins
    .filter(({ plugin }) => !plugin.library)
    .map((status): InstalledItem => {
      const { manifest } = status.plugin;
      const ref = refOf(status.plugin);
      return {
        key: `folder:${manifest.id}`,
        text: itemText(manifest),
        problem: status.problem !== null,
        row: (
          <PluginRow
            status={status}
            onEnabled={(on) => void act(() => pluginStore.enable(ref, on))}
            onRemove={() => void act(() => pluginStore.remove(ref))}
            actions={
              status.plugin.development ? (
                <Reload
                  pluginId={manifest.id}
                  name={manifest.name}
                  act={act}
                  onAsks={setCandidate}
                />
              ) : (
                folders &&
                vault.status === 'unlocked' && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      void act(async () =>
                        setSharing(await readUpload(await folders.files(manifest.id))),
                      )
                    }
                  >
                    Share to library…
                  </Button>
                )
              )
            }
          />
        ),
      };
    });

  return (
    <div className="grid gap-4">
      {error && <FormMessage>{error}</FormMessage>}
      {notice && <FormMessage tone="notice">{notice}</FormMessage>}
      {tab === 'installed' && <ReplacedParts />}
      {tab === 'installed' && <ClaimedFences />}
      {vault.status === 'unlocked' ? (
        <Library ctx={vault.ctx} tab={tab} query={query} folder={folder} />
      ) : folders ? (
        <>
          {tab === 'installed' && <InstalledList items={folder} query={query} />}
          <p className="text-sm text-muted-foreground">
            Unlock your vault to see the plugins you installed from the library, and the library.
            Which ones you installed is encrypted.
          </p>
        </>
      ) : (
        <p className="text-sm text-muted-foreground">
          Unlock your vault to see your plugins. Which ones you installed is encrypted.
        </p>
      )}
      <Approval
        candidate={candidate}
        onDone={() => setCandidate(null)}
        onApprove={(chosen) => act(() => pluginStore.approve(chosen))}
      />
      {folders && vault.status === 'unlocked' && (
        <ConfirmUpload
          ctx={vault.ctx}
          upload={sharing}
          onDone={() => setSharing(null)}
          onUpload={(upload, visibility) =>
            act(async () => {
              const { manifest } = await uploadAndInstall(pluginStore, upload, visibility);
              await queryClient.invalidateQueries({ queryKey: LIBRARY_KEY });
              return `Shared ${manifest.name} ${manifest.version} to the library and installed it on all your devices.`;
            })
          }
        />
      )}
    </div>
  );
}

/**
 * Ask the person to approve a plugin before it runs: its name, version,
 * trust level, the most page access it may ask for, the devices it says
 * it works on (warning when this isn't one) and the hash approved,
 * and for an update what it replaces, with any change of level or access.
 * `verb` names what confirming does, if not installing, updating or
 * loading; `children` go after the hash.
 */
export function Approval<T extends ApprovalRequest>({
  candidate,
  onDone,
  onApprove,
  verb: action,
  children,
}: {
  candidate: T | null;
  onDone: () => void;
  onApprove: (candidate: T) => Promise<void>;
  verb?: string;
  children?: ReactNode;
}) {
  const { store: pluginStore } = useAppPlugins();
  // A browser without the File System Access picker asks for the folder again.
  const keepsFolder = pluginStore.development?.keepsFolder ?? true;
  const level = candidate ? LEVELS[candidate.level] : null;
  const verb =
    action ?? (candidate?.replaces ? 'Update' : candidate?.development ? 'Load' : 'Install');
  return (
    <Dialog open={candidate !== null} onOpenChange={(open) => !open && onDone()}>
      {candidate && level && (
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {verb} {candidate.manifest.name} {candidate.manifest.version}?
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
            <ApprovalDevices platforms={candidate.manifest.platforms} />
            {replacedParts(candidate.manifest).length > 0 && (
              <p>
                It replaces {listed.format(replacedParts(candidate.manifest))} with its own. You can
                use the app’s own again in Settings → Plugins.
              </p>
            )}
            {fencesOf(candidate.manifest).length > 0 && (
              <p>
                It draws {listed.format(fencesOf(candidate.manifest))} code blocks as its own, on
                every page you open, whoever wrote them. You can show them as code again in Settings
                → Plugins.
              </p>
            )}
            {candidate.replaces && <Replaces candidate={candidate} />}
            {candidate.development && (
              <p>
                Development:{' '}
                {keepsFolder
                  ? `its code is read from ${candidate.development} again at each Reload`
                  : `you choose ${candidate.development} again at each Reload`}
                , without asking again unless it asks for more.
                {!desktop &&
                  ' It runs in this tab only, until you close or reload the tab or remove it.'}
              </p>
            )}
            {candidate.hash && (
              <p className="text-muted-foreground">
                Its files’ SHA-256, which this approval is for:{' '}
                <code className="break-all">{candidate.hash}</code>
              </p>
            )}
            {children}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={onDone}>
              Cancel
            </Button>
            <Button onClick={() => void onApprove(candidate).then(onDone)}>{verb}</Button>
          </DialogFooter>
        </DialogContent>
      )}
    </Dialog>
  );
}

/**
 * Which plugin draws each part of the app that plugins replace, with **Use
 * the app's own** (ADR 0011): the first in this list's order that replaces
 * it, unless the person chose otherwise, kept as its on/off is. Choosing
 * one plugin's gives the app's own part back from those before it. Not in
 * safe mode, where nothing replaces anything.
 */
function ReplacedParts() {
  const { store: pluginStore, runtime: pluginRuntime } = useAppPlugins();
  const { plugins, safeMode } = usePlugins();
  const [error, setError] = useState<string | null>(null);
  // In safe mode every part is the app's own, as the notice above says.
  if (safeMode) return null;
  const rows = Object.keys(REGIONS)
    .filter(isReplaceable)
    .flatMap((region) => {
      const replacing = plugins
        .map(({ plugin }) => plugin)
        .filter(
          (plugin) =>
            plugin.enabled && plugin.level === 'app' && plugin.manifest.replaces?.includes(region),
        );
      if (replacing.length === 0) return [];
      const drawing = replacing.find((plugin) => !plugin.ownParts.includes(region)) ?? null;
      return [{ region, replacing, drawing }];
    });
  if (rows.length === 0) return null;

  /** Make `region` the app's own for each of `plugins`, and `chosen`'s if given. */
  const choose = (region: keyof Replacements, own: InstalledPlugin[], chosen?: InstalledPlugin) =>
    void (async () => {
      setError(null);
      try {
        for (const plugin of own) {
          if (!plugin.ownParts.includes(region))
            await pluginStore.setOwnParts(refOf(plugin), [...plugin.ownParts, region]);
        }
        if (chosen)
          await pluginStore.setOwnParts(
            refOf(chosen),
            chosen.ownParts.filter((part) => part !== region),
          );
      } catch (failure) {
        setError(message(failure));
      }
      await pluginRuntime.refresh();
    })();

  return (
    <section aria-label="Replaced parts" className="grid gap-2 text-sm">
      <h3 className="font-bold">Parts of the app plugins replace</h3>
      <ul className="grid gap-2">
        {rows.map(({ region, replacing, drawing }) => (
          <li key={region} className="flex flex-wrap items-center gap-2">
            <span className="min-w-48 flex-1">
              {capitalized(REPLACED[region].part)}:{' '}
              {drawing ? `${drawing.manifest.name} draws it.` : 'the app’s own.'}
            </span>
            {drawing && (
              <Button size="sm" variant="outline" onClick={() => choose(region, replacing)}>
                Use the app’s own
              </Button>
            )}
            {replacing
              .filter((plugin) => plugin !== drawing)
              .map((plugin) => (
                <Button
                  key={`${plugin.library}:${plugin.manifest.id}`}
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    choose(region, replacing.slice(0, replacing.indexOf(plugin)), plugin)
                  }
                >
                  Use {plugin.manifest.name}
                </Button>
              ))}
          </li>
        ))}
      </ul>
      {error && <FormMessage>{error}</FormMessage>}
    </section>
  );
}

/**
 * Which plugin draws each bare fence language plugins claim (`fences`,
 * #401), with **Show as code**: the first in this list's order that claims
 * it, unless the person chose otherwise, kept as a replaced part's choice
 * is (`fencePart` in its `ownParts`). Choosing one plugin's gives the
 * language back from those before it, so two plugins claiming one show
 * which draws it and let the person change that. Not in safe mode, where
 * every block is code.
 */
function ClaimedFences() {
  const { store: pluginStore, runtime: pluginRuntime } = useAppPlugins();
  const { plugins, safeMode, blocks } = usePlugins();
  const [error, setError] = useState<string | null>(null);
  if (safeMode) return null;
  // Only plugins that draw the block here, running with it registered, can draw the language.
  const drawers = plugins
    .map(({ plugin }) => plugin)
    .filter((plugin) => plugin.enabled && plugin.level === 'app');
  const draws = (plugin: InstalledPlugin, language: string) => {
    const type = plugin.manifest.fences?.[language];
    // As the runtime takes it: app code's view, not a script's form registered over it.
    return (
      type !== undefined && blocks.get(blockLanguage(plugin.manifest.id, type))?.part === 'app'
    );
  };
  const languages = [...new Set(drawers.flatMap((plugin) => fencesOf(plugin.manifest)))]
    .filter((language) => drawers.some((plugin) => draws(plugin, language)))
    .sort();
  if (languages.length === 0) return null;
  const rows = languages.map((language) => {
    const claiming = drawers.filter((plugin) => draws(plugin, language));
    // The plugin the runtime draws it with, so a claim whose block never registered isn't named.
    const drawer = blocks.get(language)?.pluginId;
    return {
      language,
      part: fencePart(language),
      claiming,
      drawing: claiming.find((plugin) => plugin.manifest.id === drawer) ?? null,
    };
  });

  /** `plugin`'s `ownParts` without the languages its manifest no longer claims, so they don't pile up. */
  const current = (plugin: InstalledPlugin) =>
    plugin.ownParts.filter(
      (own) =>
        !own.startsWith(fencePart('')) ||
        fencesOf(plugin.manifest).some((language) => fencePart(language) === own),
    );

  /** Show `part`'s blocks as code for each of `own`, and drawn by `chosen` if given. */
  const choose = (part: string, own: InstalledPlugin[], chosen?: InstalledPlugin) =>
    void (async () => {
      setError(null);
      try {
        for (const plugin of own) {
          if (plugin.ownParts.includes(part)) continue;
          const next = [...current(plugin), part];
          // What an approval keeps: more would make it unreadable.
          if (next.length > MAX_OWN_PARTS)
            throw new Error(
              `${plugin.manifest.name} already has ${MAX_OWN_PARTS} parts of the app given back.`,
            );
          await pluginStore.setOwnParts(refOf(plugin), next);
        }
        if (chosen)
          await pluginStore.setOwnParts(
            refOf(chosen),
            current(chosen).filter((own) => own !== part),
          );
      } catch (failure) {
        setError(message(failure));
      }
      await pluginRuntime.refresh();
    })();

  return (
    <section aria-label="Code blocks plugins draw" className="grid gap-2 text-sm">
      <h3 className="font-bold">Code blocks plugins draw</h3>
      <ul className="grid gap-2">
        {rows.map(({ language, part, claiming, drawing }) => (
          <li key={language} className="flex flex-wrap items-center gap-2">
            <span className="min-w-48 flex-1">
              <code>{language}</code> blocks:{' '}
              {drawing ? `${drawing.manifest.name} draws them.` : 'shown as code.'}
              {claiming.length > 1 &&
                ` Also claimed by ${listed.format(
                  claiming
                    .filter((plugin) => plugin !== drawing)
                    .map((plugin) => plugin.manifest.name),
                )}.`}
            </span>
            {drawing && (
              <Button size="sm" variant="outline" onClick={() => choose(part, claiming)}>
                Show as code
              </Button>
            )}
            {claiming
              .filter((plugin) => plugin !== drawing)
              .map((plugin) => (
                <Button
                  key={`${plugin.library}:${plugin.manifest.id}`}
                  size="sm"
                  variant="outline"
                  onClick={() => choose(part, claiming.slice(0, claiming.indexOf(plugin)), plugin)}
                >
                  Use {plugin.manifest.name}
                </Button>
              ))}
          </li>
        ))}
      </ul>
      {error && <FormMessage>{error}</FormMessage>}
    </section>
  );
}

/** The version an update replaces, and whether its trust level or page access change. */
function Replaces({ candidate }: { candidate: ApprovalRequest }) {
  const { replaces } = candidate;
  if (!replaces) return null;
  const levelChanges = replaces.level !== candidate.level;
  const accessChanges = replaces.access !== candidate.manifest.access;
  return (
    <p>
      It replaces version {replaces.version}.{' '}
      {levelChanges && (
        <strong>
          Its trust level changes from {LEVELS[replaces.level].label} to{' '}
          {LEVELS[candidate.level].label}.{' '}
        </strong>
      )}
      {accessChanges && (
        <strong>
          It asked for {ACCESS[replaces.access]}, and now asks for{' '}
          {ACCESS[candidate.manifest.access]}.
        </strong>
      )}
      {!levelChanges && !accessChanges && 'Its trust level and page access stay the same.'}
    </p>
  );
}

/**
 * One installed plugin on the Plugins page: its name, version, trust level,
 * where it came from and on/off (for a library plugin, for the account and,
 * while that is on, on this device), its description and any problem, Remove
 * beside `actions`, then its commands' shortcuts and its page access. Settings opens its settings
 * under it: those its manifest declares, drawn by the app, then its own
 * sections (`settings.section`). The page's `plugin` search, which a
 * plugin's `navigate({ kind: 'settings' })` sets, opens them at once.
 */
export function PluginRow({
  status: { plugin, problem },
  onEnabled,
  onRemove,
  actions,
  note,
  here = true,
  offHere,
}: {
  status: PluginStatus;
  onEnabled: (on: boolean) => void;
  onRemove: () => void;
  actions?: ReactNode;
  /** Shown under the description, such as an update waiting. */
  note?: ReactNode;
  /** False where another install of the ID runs instead: no page access or settings of its own. */
  here?: boolean;
  /** A library plugin's switch for this device only (#312), shown while it is on for the account. */
  offHere?: { off: boolean; onChange: (off: boolean) => void } | undefined;
}) {
  const { manifest, level, development, enabled } = plugin;
  const { regions } = usePlugins();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const sections = here
    ? regions['settings.section'].filter(({ pluginId }) => pluginId === manifest.id)
    : [];
  const declared = here && (manifest.settings?.length ?? 0) > 0;
  const hasSettings = declared || sections.length > 0;
  // Asked for by the plugin: its sections come once it runs, so this may turn true later.
  const asked = useSearch({ strict: false }).plugin === manifest.id && hasSettings;
  const row = useRef<HTMLLIElement>(null);
  const navigate = useNavigate();
  useEffect(() => {
    if (!asked) return;
    setSettingsOpen(true);
    row.current?.scrollIntoView({ block: 'start' });
    // Done with, so the Installed tab shows as current, and asking again opens them again.
    void navigate({ to: '/settings/plugins', search: {}, replace: true });
  }, [asked]);
  return (
    <li
      ref={row}
      className="grid gap-2 rounded-control border border-border p-3"
      aria-label={manifest.name}
    >
      <div className="flex flex-wrap items-center gap-2">
        <strong>{manifest.name}</strong>
        <span className="text-sm text-muted-foreground">{manifest.version}</span>
        <Badge variant="secondary">{LEVELS[level].label}</Badge>
        <Badge variant="outline">{plugin.library ? 'Library' : 'Folder'}</Badge>
        {!plugin.library && <ScopePill>{desktop ? THIS_DEVICE : 'This tab'}</ScopePill>}
        {development && <Badge variant="outline">Development</Badge>}
        <span className="flex-1" />
        <span className="flex items-center gap-2 text-sm text-muted-foreground">
          {offHere && 'Your account'}
          <Switch
            checked={enabled}
            aria-label={`${manifest.name} enabled`}
            onCheckedChange={onEnabled}
          />
        </span>
        {offHere && enabled && (
          <span className="flex items-center gap-2 text-sm text-muted-foreground">
            {THIS_DEVICE}
            <Switch
              checked={!offHere.off}
              aria-label={`${manifest.name} on ${THIS_DEVICE.toLowerCase()}`}
              onCheckedChange={(on) => offHere.onChange(!on)}
            />
          </span>
        )}
      </div>
      {manifest.description && <p className="text-sm">{manifest.description}</p>}
      {offHere?.off && enabled && (
        <p className="text-sm text-muted-foreground">
          Off {desktop ? 'on this computer' : 'in this browser'}. Your other devices still run it.
        </p>
      )}
      {development && <p className="text-sm text-muted-foreground">Read from {development}</p>}
      {note}
      {problem && (
        <p role="alert" className="text-sm text-destructive">
          {problem}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {hasSettings && (
          <Button
            size="sm"
            variant="outline"
            aria-expanded={settingsOpen}
            onClick={() => setSettingsOpen(!settingsOpen)}
          >
            Settings
          </Button>
        )}
        {actions}
        <Button
          aria-label={`Remove ${manifest.name}`}
          size="sm"
          variant="outline"
          onClick={onRemove}
        >
          Remove
        </Button>
      </div>
      {settingsOpen && declared && <DeclaredSettings plugin={plugin} />}
      {settingsOpen && <RegionPlace name="settings.section" pluginId={manifest.id} />}
      {here && <CommandShortcuts pluginId={manifest.id} />}
      {here && manifest.access !== 'none' && (
        <PageAccessEditor plugin={refOf(plugin)} most={manifest.access} />
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
function PageAccessEditor({ plugin, most }: { plugin: PluginRef; most: PageAccess }) {
  const vault = useVault();
  usePlugins();
  if (vault.status !== 'unlocked') {
    return <p className="text-sm text-muted-foreground">Unlock your vault to choose its pages.</p>;
  }
  return <PageAccessList ctx={vault.ctx} plugin={plugin} most={most} />;
}

function PageAccessList({
  ctx,
  plugin,
  most,
}: {
  ctx: ClientContext;
  plugin: PluginRef;
  most: PageAccess;
}) {
  const { runtime: pluginRuntime } = useAppPlugins();
  const places = usePlaces(ctx);
  const scopes = pluginRuntime.access(plugin.id);
  const [place, setPlace] = useState<string | null>(null);
  const [access, setAccess] = useState<PluginScope['access']>('read');
  const [error, setError] = useState<string | null>(null);
  const save = (next: readonly PluginScope[]) =>
    pluginRuntime.setAccess(plugin, next).catch((failure: unknown) => setError(message(failure)));
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
                variant="outline"
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
