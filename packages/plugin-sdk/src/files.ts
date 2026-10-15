/*
 * A built plugin folder's files, checked and hashed the same way wherever
 * they are read: by the desktop app from a folder on disk, and by the
 * server from an upload to its library.
 */
import { Manifest, MANIFEST_FILE, manifestFiles } from './manifest.ts';

/** A plugin folder can't be read as one; the message says why, for the person. */
export class PluginFolderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PluginFolderError';
  }
}

/** Refusing a folder with no manifest at the top: likely not a built plugin's at all. */
export const noManifest = () =>
  new PluginFolderError(
    `This folder has no readable ${MANIFEST_FILE}. Choose a built plugin’s folder (its dist).`,
  );

/** A built plugin's files, by their path from the top with `/` between names. */
export type PluginFiles = ReadonlyMap<string, Uint8Array>;

/** A built plugin's files, read and checked. */
export type CheckedPlugin = {
  manifest: Manifest;
  /** Every file's path, sorted. */
  files: string[];
  /** SHA-256 over every file's path and contents, which approval binds to. */
  hash: string;
};

/**
 * The plugin's hash, in hex: SHA-256 over each file in path order, as its
 * path, a NUL, its length in bytes, a NUL, then its contents.
 */
export async function pluginHash(files: PluginFiles): Promise<string> {
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];
  for (const [path, contents] of [...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    parts.push(encoder.encode(`${path}\0${contents.length}\0`), contents);
  }
  const all = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let at = 0;
  for (const part of parts) {
    all.set(part, at);
    at += part.length;
  }
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', all));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Check a built plugin's files as one folder: a valid manifest at the top,
 * every file it names present. Throws `PluginFolderError` saying what is
 * wrong. Limits, links and unsafe paths are the reader's to refuse.
 */
export async function checkPlugin(files: PluginFiles): Promise<CheckedPlugin> {
  const text = files.get(MANIFEST_FILE);
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(text));
  } catch {
    parsed = undefined;
  }
  if (text === undefined || parsed === undefined) throw noManifest();
  const checked = Manifest.safeParse(parsed);
  if (!checked.success) {
    const issue = checked.error.issues[0];
    throw new PluginFolderError(
      `${MANIFEST_FILE} isn’t valid: ${issue?.path.join('.') || 'it'}: ${issue?.message ?? 'unknown'}`,
    );
  }
  const manifest = checked.data;
  const missing = manifestFiles(manifest).filter((file) => !files.has(file));
  if (missing.length > 0) {
    throw new PluginFolderError(
      `${MANIFEST_FILE} names files the folder lacks: ${missing.join(', ')}`,
    );
  }
  return { manifest, files: [...files.keys()].sort(), hash: await pluginHash(files) };
}

const TYPES: Record<string, string> = {
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
};

/** What a plugin's file is served as, by its extension. */
export const fileType = (file: string) => {
  const name = file.slice(file.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return (dot > 0 && TYPES[name.slice(dot).toLowerCase()]) || 'application/octet-stream';
};
