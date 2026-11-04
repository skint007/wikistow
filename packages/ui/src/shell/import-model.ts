import { kilobytes, type importOperations, type ImportSource } from '@wikistow/client';
import { pageRoutes } from '@wikistow/contracts';

const count = (n: number, one: string, many = `${one}s`) =>
  `${n.toLocaleString()} ${n === 1 ? one : many}`;

/** What an export or vault holds, as the dialog says it before importing. */
export function foundStatus({ format, notes, folders, files, encrypted }: ImportSource): string {
  const found =
    format === 'obsidian'
      ? `Found an Obsidian vault: ${count(notes.length, 'note')} in ${count(folders.length, 'folder')}, with ${count(files.size, 'other file')}.`
      : `Found ${count(notes.length, 'note')} in ${count(folders.length, 'notebook')}, with ${count(files.size, 'attachment')}.`;
  return encrypted === 0
    ? found
    : `${found} ${count(encrypted, 'item is', 'items are')} still encrypted and can’t be imported.`;
}

/** How far an import has got, as the dialog says it. */
export function importStatus({ phase, done, total }: importOperations.ImportProgress): string {
  const what =
    phase === 'folders' ? 'Making folders' : phase === 'pages' ? 'Making pages' : 'Saving pages';
  return `${what}: ${done.toLocaleString()} of ${total.toLocaleString()}`;
}

/** What an import stopped partway left, as the dialog says it. */
export function stoppedStatus(unfinished: number): string {
  return unfinished === 0
    ? 'Import stopped. Import again to finish: what is already imported stays as it is.'
    : unfinished === 1
      ? 'Import stopped. 1 page is still an empty draft. Import again to finish it: what is already imported stays as it is.'
      : `Import stopped. ${unfinished.toLocaleString()} pages are still empty drafts. Import again to finish them: what is already imported stays as it is.`;
}

/** What an import made, as the dialog says it once it has finished. */
export function doneStatus(summary: importOperations.ImportSummary): string {
  const { folders, pages, existing, attachments } = summary;
  const made = `Imported ${count(pages.length, 'page')}, ${count(folders, 'folder')} and ${count(attachments, 'attachment')}.`;
  return existing === 0
    ? made
    : `${made} ${count(existing, 'page was', 'pages were')} already imported, and left as ${existing === 1 ? 'it was' : 'they were'}.`;
}

/** Why a note or file was left out, in words. */
export const skipReason = (reason: importOperations.ImportSkipped['reason']) =>
  reason === 'encrypted'
    ? 'encrypted: decrypt it in Joplin first'
    : reason === 'unused'
      ? 'no imported note links to it or embeds it'
      : `too large: a page holds at most ${kilobytes(pageRoutes.MAX_MARKDOWN_BYTES)}`;
