// Which desktop app this copy is. The AUR's `wikistow-desktop-beta-bin`
// installs beside `wikistow-desktop-bin`, under names of its own
// (aur/wikistow-desktop-bin/PKGBUILD): its folder, launcher, launcher entry,
// icon, data folder and sign-in link. Every other copy is the stable app,
// whatever version it runs; a prerelease's own downloads still install as it.
import type { desktopRoutes } from '@wikistow/contracts';
import { join } from 'node:path';

type DesktopApp = desktopRoutes.DesktopApp;

/** Where the Linux packages install each app, with its `install-source` (docs/desktop.md). */
export const PACKAGED: Record<DesktopApp, string> = {
  stable: '/usr/lib/wikistow-desktop',
  beta: '/usr/lib/wikistow-desktop-beta',
};

/**
 * The package's folder for the app at `appPath`, if it runs from inside one
 * on Linux, as `app.asar` or the .deb's `resources/app.asar`; else null.
 */
export function packagedFolder(appPath: string, platform = process.platform): string | null {
  if (platform !== 'linux') return null;
  return Object.values(PACKAGED).find((folder) => appPath.startsWith(`${folder}/`)) ?? null;
}

/** The app at `appPath`: the beta only when it runs from the beta package's folder. */
export function desktopApp(appPath: string, platform = process.platform): DesktopApp {
  return packagedFolder(appPath, platform) === PACKAGED.beta ? 'beta' : 'stable';
}

/** The names each app goes by. */
export const APP_NAMES = {
  stable: { name: 'WikiStow', entry: 'wikistow-desktop.desktop', icon: 'wikistow-desktop.png' },
  beta: {
    name: 'WikiStow Beta',
    entry: 'wikistow-desktop-beta.desktop',
    icon: 'wikistow-desktop-beta.png',
  },
} as const satisfies Record<DesktopApp, { name: string; entry: string; icon: string }>;

/** The window icon packed in the app (scripts/asar.ts). */
export const windowIcon = (appPath: string, which: DesktopApp) =>
  join(appPath, 'packaging', APP_NAMES[which].icon);
