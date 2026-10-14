import { extname, isAbsolute, join, relative, resolve } from 'node:path';

/** The app's own origin. Its pages, workers and API requests all live here. */
export const APP_ORIGIN = 'app://wikistow';

/**
 * The built web app's file for a path under `app://wikistow`, as the server
 * serves it: the file itself, or `index.html` for any extensionless path, so
 * a reload on a nested route still loads the app. Null for API paths and for
 * anything outside the build.
 */
export function appFile(dist: string, pathname: string): string | null {
  if (pathname.startsWith('/api/')) return null;
  let path: string;
  try {
    path = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const root = resolve(dist);
  const file = resolve(join(root, path));
  const inside = relative(root, file);
  if (inside.startsWith('..') || isAbsolute(inside)) return null;
  if (inside === '' || extname(file) === '') return join(root, 'index.html');
  return file;
}
