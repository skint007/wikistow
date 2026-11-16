// Zips the clipper's builds and its source the same way every time: the
// files in a fixed order with a fixed time, so a build can be compared
// byte for byte.
import { zipSync } from 'fflate';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

/** The files under `folder`, as paths relative to it with `/`, in order, skipping folders named in `skip`. */
export async function files(folder: string, skip: string[] = []): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(folder, { withFileTypes: true, recursive: true })) {
    const path = relative(folder, join(entry.parentPath, entry.name)).split('\\').join('/');
    if (entry.isFile() && !path.split('/').some((part) => skip.includes(part))) found.push(path);
  }
  return found.sort();
}

// SOURCE_DATE_EPOCH, or the earliest day a zip can hold. A zip keeps a
// time without its zone, which fflate reads from the Date as local time:
// so the Date is made of the UTC time's parts, read the same in any zone.
const utc = new Date(Number(process.env['SOURCE_DATE_EPOCH'] ?? 315_532_800) * 1000);
const mtime = new Date(
  utc.getUTCFullYear(),
  utc.getUTCMonth(),
  utc.getUTCDate(),
  utc.getUTCHours(),
  utc.getUTCMinutes(),
  utc.getUTCSeconds(),
);

/** Writes `zip` with each entry's bytes, read from `from` under its path unless given. */
export async function writeZip(
  zip: string,
  from: string,
  paths: string[],
  given: Record<string, Uint8Array> = {},
) {
  const entries: Record<string, [Uint8Array, { mtime: Date }]> = {};
  for (const path of [...paths, ...Object.keys(given)].sort()) {
    entries[path] = [given[path] ?? (await readFile(join(from, path))), { mtime }];
  }
  await writeFile(zip, zipSync(entries));
}
