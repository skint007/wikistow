import { kilobytes, type importOperations, type JoplinExport } from '@wikistow/client';
import { pageRoutes } from '@wikistow/contracts';

const count = (n: number, one: string, many = `${one}s`) =>
  `${n.toLocaleString()} ${n === 1 ? one : many}`;

/** What a Joplin export holds, as the dialog says it before importing. */
export function foundStatus({ notes, notebooks, resources, encrypted }: JoplinExport): string {
  const found = `Found ${count(notes.length, 'note')} in ${count(notebooks.length, 'notebook')}, with ${count(resources.size, 'attachment')}.`;
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

/** What an import made, as the dialog says it once it has finished. */
export function doneStatus(summary: importOperations.ImportSummary): string {
  const { folders, pages, existing, attachments } = summary;
  const made = `Imported ${count(pages.length, 'page')}, ${count(folders, 'folder')} and ${count(attachments, 'attachment')}.`;
  return existing === 0
    ? made
    : `${made} ${count(existing, 'page was', 'pages were')} already imported, and left as ${existing === 1 ? 'it was' : 'they were'}.`;
}

/** Why a note was left out, in words. */
export const skipReason = (reason: importOperations.ImportSkipped['reason']) =>
  reason === 'encrypted'
    ? 'encrypted: decrypt it in Joplin first'
    : `too large: a page holds at most ${kilobytes(pageRoutes.MAX_MARKDOWN_BYTES)}`;
