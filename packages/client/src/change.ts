// What a version made by changes while reading changed (#213, ADR 0008),
// kept in the `wikistow.change` payload extension so history can say it:
// "Ticked 3, unticked 1". The publication their flush makes writes it,
// naming itself, and nothing else does: drafts are saved without it, and
// every other publish leaves it out. A version counts it only when it names that
// version, so a copy an app that doesn't know it carried into a later
// version never counts, nor does a draft published again (section 5.5).
import { z } from 'zod';
import { RevisionId } from './ids.ts';
import { propertyData } from './markdown/properties.ts';
import { splitFrontmatter } from './markdown/frontmatter.ts';
import { taskItems } from './markdown/tasks.ts';
import type { OpenedRevision } from './operations/records.ts';
import type { PagePayload } from './payload.ts';

export const CHANGE_NAMESPACE = 'wikistow.change';

/** What changes made while reading changed: tasks ticked and unticked, and the properties whose value changed, by key as written. */
export type ChangeSummary = { ticked: number; unticked: number; properties: string[] };

const Count = z.number().int().nonnegative();

/** The extension as written: what changed, in the publication `revision`. */
export const ChangeExtension = z.looseObject({
  format: z.literal(1),
  revision: RevisionId,
  ticked: Count,
  unticked: Count,
  properties: z.array(z.string()),
});

/** `payload` without the extension, as every write but the publication of changes made while reading has it. */
export function withoutChange<P extends Pick<PagePayload, 'extensions'>>(payload: P): P {
  const { [CHANGE_NAMESPACE]: _change, ...extensions } = payload.extensions;
  return { ...payload, extensions };
}

/**
 * What changed from `before` to `after`, the same page with changes made
 * while reading, which never add or remove a task: each task whose box
 * changed, and each property whose value did. So a box ticked and then
 * unticked again counts as nothing.
 */
export function summarizeChange(before: string, after: string): ChangeSummary {
  const was = taskItems(before);
  let ticked = 0;
  let unticked = 0;
  taskItems(after).forEach((task, index) => {
    if (task.checked === was[index]?.checked) return;
    if (task.checked) ticked++;
    else unticked++;
  });
  const values = (markdown: string) =>
    new Map(
      propertyData(splitFrontmatter(markdown).frontmatter).map(({ key, value }) => [
        key,
        JSON.stringify(value),
      ]),
    );
  const old = values(before);
  const properties = [...values(after)]
    .filter(([key, value]) => old.get(key) !== value)
    .map(([key]) => key);
  return { ticked, unticked, properties };
}

/**
 * What the version `revision` changed while reading, or null when it isn't
 * such a version: a publication whose extension names it.
 */
export function changeOf({ record, opened }: Pick<OpenedRevision, 'record' | 'opened'>) {
  if (opened.kind !== 'current' || record.audience !== 'published') return null;
  const change = ChangeExtension.safeParse(opened.payload.extensions[CHANGE_NAMESPACE]);
  if (!change.success || change.data.revision !== record.revisionId) return null;
  const { ticked, unticked, properties } = change.data;
  return { ticked, unticked, properties } satisfies ChangeSummary;
}

/** At most this many properties are named in a label; the rest are counted. */
const NAMED = 3;

/** A change as history says it: "Ticked 3, unticked 1, changed servings". */
export function changeLabel({ ticked, unticked, properties }: ChangeSummary): string {
  const parts: string[] = [];
  if (ticked > 0) parts.push(`ticked ${ticked}`);
  if (unticked > 0) parts.push(`unticked ${unticked}`);
  if (properties.length > 0) {
    const named = properties.length > NAMED ? properties.slice(0, NAMED) : properties.slice(0, -1);
    const last =
      properties.length > NAMED ? `${properties.length - NAMED} more` : properties.at(-1);
    parts.push(`changed ${named.length > 0 ? `${named.join(', ')} and ${last}` : last}`);
  }
  const label = parts.join(', ') || 'changed while reading';
  return label.charAt(0).toUpperCase() + label.slice(1);
}
