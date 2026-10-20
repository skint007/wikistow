// Page templates: the pages in a folder named Templates, and the
// `{{variables}}` filled in when a page is made from one
// (`pageOperations.createFromTemplate`).

/** Whether a folder by this name holds templates: Templates, in any case. */
export const isTemplatesFolder = (name: string | null) =>
  name?.trim().toLowerCase() === 'templates';

type Node = { id: string; parentId: string | null };

/**
 * Every page in a folder named Templates, at any depth, with the names of
 * the folders between it and the outermost such folder, outermost first:
 * `[]` for a page right in it. Sorted by those names, a folder's own pages
 * first, then by title.
 */
export function templatesIn<P extends Node & { title: string | null }>(
  folders: readonly (Node & { name: string | null })[],
  pages: readonly P[],
): { page: P; path: string[] }[] {
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  const pathOf = (parentId: string | null) => {
    let path: string[] | null = null;
    const above: string[] = [];
    const seen = new Set<string>();
    for (let folder = parentId === null ? undefined : byId.get(parentId); folder;) {
      // A lying tree could loop; a folder seen twice ends the walk.
      if (seen.has(folder.id)) break;
      seen.add(folder.id);
      if (isTemplatesFolder(folder.name)) path = above.toReversed();
      above.push(folder.name ?? '');
      folder = folder.parentId === null ? undefined : byId.get(folder.parentId);
    }
    return path;
  };
  return pages
    .flatMap((page) => {
      const path = pathOf(page.parentId);
      return path ? [{ page, path }] : [];
    })
    .sort((a, b) => {
      // A folder's own pages before its subfolders'.
      for (let i = 0; i < Math.min(a.path.length, b.path.length); i++) {
        const order = (a.path[i] ?? '').localeCompare(b.path[i] ?? '');
        if (order !== 0) return order;
      }
      return (
        a.path.length - b.path.length || (a.page.title ?? '').localeCompare(b.page.title ?? '')
      );
    });
}

/**
 * `{{name}}`, `{{name|default}}` or `{{name:format}}`. A name starts with a
 * letter or digit and holds only those, spaces, `_` and `-`, so text such
 * as `{{#each}}` or `{{ }}` is left as it is.
 */
const VARIABLE = /\{\{\s*([\p{L}\p{N}][\p{L}\p{N} _-]*?)\s*(?:([|:])([^}\n]*))?\}\}/gu;

/** A field the person fills in: its value replaces every variable with `key`. */
export type TemplateField = { key: string; label: string; initial: string };

type Variable =
  | ({ kind: 'asked' } & TemplateField)
  | { kind: 'date' | 'time'; format: string }
  | { kind: 'title' | 'me' };

// What one match stands for, or null for text left as it is: a format
// only goes on a date or time, and a default only on an asked variable.
function variableOf(name: string, mark: string | undefined, rest = ''): Variable | null {
  const label = name.replace(/\s+/g, ' ');
  const key = label.toLowerCase();
  if (key === 'date' || key === 'time') {
    if (mark === '|') return null;
    const format = rest.trim() || (key === 'date' ? 'YYYY-MM-DD' : 'HH:mm');
    return { kind: key, format };
  }
  if (key === 'title' || key === 'me') return mark === undefined ? { kind: key } : null;
  if (mark === ':') return null;
  return { kind: 'asked', key, label, initial: rest.trim() };
}

/**
 * The fields `texts` ask for, in the order they first appear: one per
 * name, whatever its case or spacing, with the first default given.
 */
export function templateFields(...texts: string[]): TemplateField[] {
  const fields = new Map<string, TemplateField>();
  for (const text of texts) {
    for (const [, name = '', mark, rest] of text.matchAll(VARIABLE)) {
      const variable = variableOf(name, mark, rest);
      if (variable?.kind === 'asked' && !fields.has(variable.key)) {
        const { key, label, initial } = variable;
        fields.set(key, { key, label, initial });
      }
    }
  }
  return [...fields.values()];
}

/** What fills a template in: the new page's title, the person's name, the time now, and the fields' values by key. */
export type TemplateValues = {
  title: string;
  me: string;
  now: Date;
  asked: Readonly<Record<string, string>>;
};

/** `text` with its variables filled in. An asked one with no value gets its default. */
export function fillTemplate(text: string, values: TemplateValues): string {
  return text.replace(VARIABLE, (match, name: string, mark?: string, rest?: string) => {
    const variable = variableOf(name, mark, rest);
    switch (variable?.kind) {
      case undefined:
        return match;
      case 'asked':
        return values.asked[variable.key] ?? variable.initial;
      case 'date':
      case 'time':
        return formatDate(values.now, variable.format);
      case 'title':
        return values.title;
      case 'me':
        return values.me;
    }
  });
}

const DATE_TOKENS = /\[([^\]]*)\]|YYYY|YY|MMMM|MMM|MM|M|dddd|ddd|DD|D|HH|H|hh|h|mm|ss|A|a/g;

/**
 * `date` in local time by `format`, as Moment and Obsidian write them:
 * YYYY YY, MMMM MMM MM M, DD D, dddd ddd, HH H hh h, mm ss, A a. Text in
 * square brackets is kept as written. Month and day names are in `locale`,
 * by default the app's.
 */
export function formatDate(date: Date, format: string, locale?: string): string {
  const pad = (n: number, width = 2) => String(n).padStart(width, '0');
  const name = (options: Intl.DateTimeFormatOptions) => date.toLocaleString(locale, options);
  const hour12 = date.getHours() % 12 || 12;
  return format.replace(DATE_TOKENS, (token, kept?: string) => {
    if (kept !== undefined) return kept;
    switch (token) {
      case 'YYYY':
        return pad(date.getFullYear(), 4);
      case 'YY':
        return pad(date.getFullYear() % 100);
      case 'MMMM':
        return name({ month: 'long' });
      case 'MMM':
        return name({ month: 'short' });
      case 'MM':
        return pad(date.getMonth() + 1);
      case 'M':
        return String(date.getMonth() + 1);
      case 'dddd':
        return name({ weekday: 'long' });
      case 'ddd':
        return name({ weekday: 'short' });
      case 'DD':
        return pad(date.getDate());
      case 'D':
        return String(date.getDate());
      case 'HH':
        return pad(date.getHours());
      case 'H':
        return String(date.getHours());
      case 'hh':
        return pad(hour12);
      case 'h':
        return String(hour12);
      case 'mm':
        return pad(date.getMinutes());
      case 'ss':
        return pad(date.getSeconds());
      case 'A':
        return date.getHours() < 12 ? 'AM' : 'PM';
      default:
        return date.getHours() < 12 ? 'am' : 'pm';
    }
  });
}
