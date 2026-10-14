import { exportOperations, FolderId, PageId, SpaceId, type ClientContext } from '@wikistow/client';
import { accountRoutes } from '@wikistow/contracts';
import type { useNavigate } from '@tanstack/react-router';
import { z } from 'zod';
import { ChosenTheme, pluginTheme } from '../theme/plugin-theme';
import type { Theme } from '../theme/theme';
import { vaultStore } from '../vault/store';
import type { Command, CommandEnv, Requirement } from './command';
import { exportZip, saveFile, zipName } from '../shell/export-zip';

type Navigate = ReturnType<typeof useNavigate>;
const PageRef = z.object({ spaceId: SpaceId, pageId: PageId });
const NoInput = z.object({});

/**
 * What holds in the app now. `editor`: the person can edit the page in view.
 * `owner`: they own the space in view.
 */
export const requirementsHere =
  ({ editor = false, owner = false } = {}) =>
  (requirement: Requirement) => {
    switch (requirement) {
      case 'unlocked-vault':
        return vaultStore.get().status === 'unlocked';
      case 'page-editor':
        return editor;
      case 'space-owner':
        return owner;
    }
  };

/** Lock the vault; editors save first, or ask (see `vaultStore.requestLock`). */
export const lockVault: Command<typeof NoInput, CommandEnv> = {
  id: 'vault.lock',
  input: NoInput,
  requires: ['unlocked-vault'],
  run: async () => {
    await vaultStore.requestLock();
  },
};

/** Open search across every space (Ctrl+K, Cmd+K on Apple systems, or Search on the rail). */
export const openSearch: Command<typeof NoInput, CommandEnv & { openSearch: () => void }> = {
  id: 'search.open',
  input: NoInput,
  requires: ['unlocked-vault'],
  run: async (_input, { openSearch }) => openSearch(),
};

export const setTheme: Command<
  z.ZodObject<{ theme: typeof accountRoutes.Theme }>,
  CommandEnv & { setTheme: (theme: Theme) => void }
> = {
  id: 'theme.set',
  input: z.object({ theme: accountRoutes.Theme }),
  requires: [],
  run: async ({ theme }, env) => env.setTheme(theme),
};

const PluginThemeChoice = z.object({ theme: ChosenTheme.nullable() });

/** Show a plugin's theme on this device, or with null the account's palette again. */
export const setPluginTheme: Command<typeof PluginThemeChoice, CommandEnv> = {
  id: 'theme.plugin',
  input: PluginThemeChoice,
  requires: [],
  run: async ({ theme }) => pluginTheme.choose(theme),
};

/** Open a page's draft. */
export const editPage: Command<typeof PageRef, CommandEnv & { navigate: Navigate }> = {
  id: 'page.edit',
  input: PageRef,
  requires: ['unlocked-vault', 'page-editor'],
  run: async (page, { navigate }) => {
    await navigate({ to: '/s/$spaceId/p/$pageId', params: page, search: { view: 'draft' } });
  },
};

/** Save the draft and go back to the publication. */
export const finishEditing: Command<
  typeof PageRef,
  CommandEnv & { navigate: Navigate; flushDraft: () => Promise<void> }
> = {
  id: 'page.done',
  input: PageRef,
  requires: ['unlocked-vault', 'page-editor'],
  run: async (page, { navigate, flushDraft }) => {
    await flushDraft();
    await navigate({ to: '/s/$spaceId/p/$pageId', params: page, search: {} });
  },
};

/** Open the banner picker on the draft in view. */
export const changeBanner: Command<typeof PageRef, CommandEnv & { openBannerPicker: () => void }> =
  {
    id: 'page.change-banner',
    input: PageRef,
    requires: ['unlocked-vault', 'page-editor'],
    run: async (_page, { openBannerPicker }) => openBannerPicker(),
  };

/** Open the emoji picker on the draft in view. */
export const changeEmoji: Command<typeof PageRef, CommandEnv & { openEmojiPicker: () => void }> = {
  id: 'page.change-emoji',
  input: PageRef,
  requires: ['unlocked-vault', 'page-editor'],
  run: async (_page, { openEmojiPicker }) => openEmojiPicker(),
};

const ExportInput = z.object({
  spaceId: SpaceId,
  folderId: FolderId.nullable(),
  /** What is exported, by name, for the zip's file name. */
  name: z.string(),
});

/**
 * Download what the person can read in a space, or a folder of it, as a
 * zip of Markdown files (`exportZip`), each page as they see it.
 */
export const exportMarkdown: Command<
  typeof ExportInput,
  CommandEnv & {
    ctx: ClientContext;
    onProgress?: (progress: exportOperations.ExportProgress) => void;
    onExported?: (summary: exportOperations.ExportSummary) => void;
    signal?: AbortSignal;
  }
> = {
  id: 'space.export',
  input: ExportInput,
  requires: ['unlocked-vault'],
  run: async ({ spaceId, folderId, name }, { ctx, onProgress, onExported, signal }) => {
    const { zip, summary } = await exportZip(
      ctx,
      { spaceId, ...(folderId === null ? {} : { folderId }) },
      { ...(onProgress ? { onProgress } : {}), ...(signal ? { signal } : {}) },
    );
    signal?.throwIfAborted();
    saveFile(zip, zipName(name));
    onExported?.(summary);
  },
};
