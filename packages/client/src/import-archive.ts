// The files an import reads (wikistow.md, Import): from a folder the caller
// lists, or from a tar (Joplin's JEX) or zip archive read here. Paths are
// `/`-separated and relative to the export's top.
import { unzipSync } from 'fflate';

/** One file of an export, read only when its bytes are wanted. */
export type ImportFile = { path: string; size: number; read: () => Promise<Uint8Array> };

/** An archive this app doesn't read, or one cut short. */
export class UnreadableArchive extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnreadableArchive';
  }
}

/**
 * `path` with `\` as `/`, without empty or `.` parts, and each `..` taking
 * off the part before it; null if it climbs out of the top or names nothing.
 */
export function cleanPath(path: string): string | null {
  const parts: string[] = [];
  for (const part of path.replaceAll('\\', '/').split('/')) {
    if (part === '' || part === '.') continue;
    if (part !== '..') parts.push(part);
    else if (parts.pop() === undefined) return null;
  }
  return parts.length === 0 ? null : parts.join('/');
}

/** What macOS adds to a zip or a copied folder: `__MACOSX/` and `._name` resource forks. */
export const macOsExtra = (path: string) =>
  path.split('/').some((part) => part === '__MACOSX' || part.startsWith('._'));

const isTar = (bytes: Uint8Array) =>
  bytes.length >= 512 && new TextDecoder().decode(bytes.subarray(257, 262)) === 'ustar';
const isZip = (bytes: Uint8Array) =>
  bytes.length >= 4 &&
  bytes[0] === 0x50 &&
  bytes[1] === 0x4b &&
  bytes[2] === 0x03 &&
  bytes[3] === 0x04;

/** The files in a tar or zip archive, folders left out. */
export function archiveFiles(bytes: Uint8Array): ImportFile[] {
  if (isTar(bytes)) return tarFiles(bytes);
  if (isZip(bytes)) return zipFiles(bytes);
  throw new UnreadableArchive('This is not a JEX, tar or zip file.');
}

function zipFiles(bytes: Uint8Array): ImportFile[] {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes);
  } catch (cause) {
    throw new UnreadableArchive(`This zip file can’t be read: ${String(cause)}`);
  }
  const files: ImportFile[] = [];
  for (const [name, data] of Object.entries(entries)) {
    const path = name.endsWith('/') ? null : cleanPath(name);
    if (path === null || macOsExtra(path)) continue;
    files.push({ path, size: data.length, read: async () => data });
  }
  return withoutWrapper(files);
}

const BLOCK = 512;

/**
 * The regular files of a ustar archive, as Joplin's JEX export writes it:
 * a 512-byte header before each file's blocks. A pax header's `path`, or a
 * GNU long name, names the file after it.
 */
function tarFiles(bytes: Uint8Array): ImportFile[] {
  const text = new TextDecoder();
  const field = (at: number, length: number) => {
    const raw = bytes.subarray(at, at + length);
    const end = raw.indexOf(0);
    return text.decode(end < 0 ? raw : raw.subarray(0, end));
  };
  const files: ImportFile[] = [];
  let longName: string | null = null;
  for (let at = 0; at + BLOCK <= bytes.length;) {
    // Two zero blocks end it; one is enough to stop.
    if (bytes.subarray(at, at + BLOCK).every((byte) => byte === 0)) break;
    const size = Number.parseInt(field(at + 124, 12).trim() || '0', 8);
    const type = field(at + 156, 1);
    const prefix = field(at + 345, 155);
    const name = longName ?? (prefix ? `${prefix}/${field(at, 100)}` : field(at, 100));
    const start = at + BLOCK;
    if (!Number.isSafeInteger(size) || start + size > bytes.length) {
      throw new UnreadableArchive('This archive is cut short or damaged.');
    }
    const data = bytes.subarray(start, start + size);
    at = start + Math.ceil(size / BLOCK) * BLOCK;
    longName = null;
    if (type === 'x') longName = paxPath(text.decode(data));
    else if (type === 'L') longName = text.decode(data).replace(/\0+$/, '');
    else if (type === '0' || type === '') {
      const path = cleanPath(name);
      if (path !== null) files.push({ path, size, read: async () => data });
    }
  }
  return files;
}

/** The `path` record of a pax header (`<length> path=<value>\n`), or null. */
function paxPath(records: string): string | null {
  for (const line of records.split('\n')) {
    const match = /^\d+ path=(.*)$/s.exec(line);
    if (match?.[1] !== undefined) return match[1];
  }
  return null;
}

/**
 * `files` without the one folder around them all, when it is the export's
 * own: a zip made from a Markdown export's folder holds it. A Joplin export
 * has notes only in notebooks, so a lone folder at the top holding no
 * notes, only folders, or one holding `_resources`, is that folder.
 */
function withoutWrapper(files: ImportFile[]): ImportFile[] {
  const tops = new Set(files.map((file) => file.path.split('/')[0]));
  const [top] = tops;
  if (tops.size !== 1 || top === undefined || files.some((file) => file.path === top)) {
    return files;
  }
  const inner = files.map((file) => file.path.slice(top.length + 1));
  const notesAtTop = inner.some((path) => !path.includes('/') && /\.(md|html)$/i.test(path));
  const resources = inner.some((path) => path.startsWith('_resources/'));
  if (notesAtTop && !resources) return files;
  return files.map((file, i) => ({ ...file, path: inner[i] ?? file.path }));
}
