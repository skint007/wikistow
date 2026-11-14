// Folding a draft written outside a live session into it (ADR 0015
// decision 8, protocol section 5.10, **Saving**), and Review of the parts
// of it that overlapped the session's own changes (section 5.5,
// `wikistow.overlaps`). Plaintext only: the participant makes the change.
//
// The fold merges by block with ADR 0013's merge: base is the latest
// session draft the outsider's save descends from, theirs is the
// outsider's draft, ours the shared document now. Where both changed one
// part, the session's text stays, and the part is named, by its place in
// theirs, for Review.
import { COVER_NAMESPACE } from '../cover.ts';
import { readProperties, splitFrontmatter } from '../markdown/index.ts';
import { edges, withinTime, writeBody, type Choice, type SegmentPick } from '../merge/body.ts';
import { takeKeys } from '../merge/frontmatter.ts';
import { mergePayloads, narrowMerge, resolve, type Merge, type Overlap } from '../merge/payload.ts';
import type { AttachmentRef, PagePayload } from '../payload.ts';

/** Namespaces a session's document never holds: saves work them out or drop them. */
export const UNHELD_NAMESPACES: ReadonlySet<string> = new Set([
  'wikistow.live',
  'wikistow.links',
  'wikistow.change',
  'wikistow.overlaps',
]);

/** `payload` without the namespaces the document never holds, as a fold and Review merge it. */
export function heldPayload(payload: PagePayload): PagePayload {
  const extensions = Object.fromEntries(
    Object.entries(payload.extensions).filter(([namespace]) => !UNHELD_NAMESPACES.has(namespace)),
  );
  return { ...payload, extensions };
}

/** The parts of the page a fold or Review writes into the document. */
export type FoldTarget = {
  title: string;
  /** The front matter block as `splitFrontmatter` gives it, '' for none. */
  frontmatter: string;
  body: string;
  attachments: readonly AttachmentRef[];
  extensions: PagePayload['extensions'];
};

type Json = PagePayload['extensions'][string];

/** What Review changes: the parts chosen otherwise than ours, each namespace's value or null to take it out. */
export type ReviewTarget = Partial<Omit<FoldTarget, 'extensions' | 'attachments'>> & {
  extensions?: Record<string, Json | null>;
};

/** A fold worked out: what the document becomes, and the parts of theirs that overlapped. */
export type Folded = { target: FoldTarget; parts: string[] };

/** What a payload's parts are as a fold or a restore writes them into the document. */
export const targetOf = (payload: PagePayload): FoldTarget => {
  const { frontmatter, body } = splitFrontmatter(payload.markdown);
  return {
    title: payload.title,
    frontmatter: frontmatter ?? '',
    body,
    attachments: payload.attachments,
    extensions: heldPayload(payload).extensions,
  };
};

/**
 * Fold `theirs`, a draft from outside the session, into `ours`, both grown
 * from `base`: theirs' changes where ours didn't change the same part, and
 * ours where both did, each such part named by its place in theirs.
 */
export function foldPayloads(base: PagePayload, ours: PagePayload, theirs: PagePayload): Folded {
  // Made on its own for every draft from outside: within a second, or not at all.
  return withinTime(FOLD_MS, () => foldWithin(base, ours, theirs));
}

/** How long a fold's or Review's merge may take before it is `MergeTooLarge`. */
export const FOLD_MS = 1_000;

function foldWithin(base: PagePayload, ours: PagePayload, theirs: PagePayload): Folded {
  const held = heldPayload(theirs);
  let merge = mergePayloads(heldPayload(base), heldPayload(ours), held);
  const parts = new Set<string>();
  // A resolve that comes back unfit names more overlaps; picking yours there ends it.
  for (let round = 0; round < 8; round++) {
    for (const overlap of merge.overlaps) {
      // Numbered over every namespace theirs has, as section 5.5 counts them.
      for (const part of partsOf(merge, overlap, theirs)) parts.add(part);
    }
    const choices = Object.fromEntries(
      merge.overlaps.map((overlap) => [overlap.id, 'yours' as const]),
    );
    const resolved = resolve(merge, choices, { review: false });
    if (resolved.ok) return { target: targetOf(resolved.payload), parts: sortParts([...parts]) };
    merge = resolved.merge;
  }
  throw new Error('The fold didn’t settle');
}

// Code point order, not JavaScript's default sort by code unit (section 5.5).
function byCodePoint(a: string, b: string): number {
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const [p, q] = [a.codePointAt(i) ?? 0, b.codePointAt(j) ?? 0];
    if (p !== q) return p - q;
    i += p > 0xffff ? 2 : 1;
    j += q > 0xffff ? 2 : 1;
  }
  return a.length - i - (b.length - j);
}

/** `payload`'s extension namespaces as `data:<n>` counts them: every one, in code point order. */
export const namespacesOf = (payload: PagePayload): string[] =>
  Object.keys(payload.extensions).sort(byCodePoint);

/** `payload`'s front matter keys as `property:<n>` counts them: in order, from 0. */
export function propertyKeysOf(payload: PagePayload): string[] {
  const read = readProperties(splitFrontmatter(payload.markdown).frontmatter);
  return read.ok ? read.properties.map((property) => property.key) : [];
}

// Parts in a stable order: the body by place, then the rest by name.
function sortParts(parts: string[]): string[] {
  const body = (part: string) => /^body:(\d+)-(\d+)$/.exec(part);
  return parts.sort((a, b) => {
    const [x, y] = [body(a), body(b)];
    if (x && y) return Number(x[1]) - Number(y[1]) || Number(x[2]) - Number(y[2]);
    if (x || y) return x ? -1 : 1;
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

/** The body segment an overlap ID names, by index, or null. */
const segmentOf = (id: string): number | null => {
  const match = /^body:(\d+)(?::fit)?$/.exec(id);
  return match ? Number(match[1]) : null;
};

/**
 * The parts of `theirs` an overlap of `merge` names (section 5.5): the
 * blocks of theirs it covers, without the blank lines at its edges, or at
 * the place theirs deleted; the title; the front matter, whole or by its
 * key's place; the banner or icon; a namespace by its place. A namespace
 * theirs doesn't have, which theirs took out, has no place to name.
 */
export function partsOf(merge: Merge, overlap: Overlap, theirs: PagePayload): string[] {
  switch (overlap.part) {
    case 'body': {
      const index = segmentOf(overlap.id);
      const segments = merge.plan.body.segments;
      const segment = index === null ? undefined : segments[index];
      if (index === null || !segment) return [];
      let offset = 0;
      for (const earlier of segments.slice(0, index)) offset += earlier.theirs.length;
      const [lead, trail] = edges(segment.theirs);
      const start = offset + lead.length;
      const end = Math.max(start, offset + segment.theirs.length - trail.length);
      return [`body:${start}-${end}`];
    }
    case 'title':
      return ['title'];
    case 'frontmatter':
      return ['frontmatter'];
    case 'property': {
      const at = overlap.key === null ? -1 : propertyKeysOf(theirs).indexOf(overlap.key);
      return [at === -1 ? 'frontmatter' : `property:${at}`];
    }
    case 'banner':
    case 'icon':
      return [overlap.part];
    case 'data': {
      const at = overlap.namespace === null ? -1 : namespacesOf(theirs).indexOf(overlap.namespace);
      return at === -1 ? [] : [`data:${at}`];
    }
  }
}

// Whether a part an overlap names is one a note names.
function named(part: string, noted: readonly string[]): boolean {
  const range = (text: string) => {
    const match = /^body:(\d+)-(\d+)$/.exec(text);
    return match ? [Number(match[1]), Number(match[2])] : null;
  };
  const frontmatter = (text: string) => text === 'frontmatter' || text.startsWith('property:');
  const ours = range(part);
  return noted.some((note) => {
    const theirs = range(note);
    if (ours && theirs) {
      const [a = 0, b = 0] = ours;
      const [s = 0, e = 0] = theirs;
      // An empty range, a deletion, is named by any range at its place.
      return a === b || s === e ? s <= b && a <= e : a < e && s < b;
    }
    if (ours || theirs) return false;
    if (part === note) return true;
    // The front matter cut whole, or by key, names the same lines.
    return (
      (part === 'frontmatter' || note === 'frontmatter') && frontmatter(part) && frontmatter(note)
    );
  });
}

/**
 * Review of a note (ADR 0015 decision 8): ADR 0013's merge of theirs with
 * the document now, from the fold's base, offering only the overlaps whose
 * parts the note names. Parts the fold took, or that someone since made
 * one side or the other, aren't overlaps any more, so aren't offered.
 */
export function reviewMerge(
  base: PagePayload,
  ours: PagePayload,
  theirs: PagePayload,
  parts: readonly string[],
): Merge {
  const held = heldPayload(theirs);
  const merge = withinTime(FOLD_MS, () =>
    mergePayloads(heldPayload(base), heldPayload(ours), held),
  );
  return narrowMerge(merge, (overlap) =>
    partsOf(merge, overlap, theirs).some((part) => named(part, parts)),
  );
}

// An overlap as the person saw it: what it is about, and both sides there.
function identity(overlap: Overlap): string {
  switch (overlap.part) {
    case 'body':
    case 'title':
    case 'frontmatter':
      return JSON.stringify([overlap.part, overlap.yours, overlap.theirs]);
    case 'property':
      return JSON.stringify(['property', overlap.key, overlap.yours, overlap.theirs]);
    default:
      return JSON.stringify([overlap.part, overlap.namespace, overlap.yours, overlap.theirs]);
  }
}

/**
 * The choices made in `chosen`'s overlaps, carried to `now`'s that are
 * about the same part with the same text on both sides, as when the
 * document changed elsewhere while the person chose. One whose text
 * changed meanwhile is left as it is now, so nobody's typing there is
 * replaced by a choice made before it.
 */
export function carryChoices(
  chosen: Merge,
  choices: Readonly<Record<string, Choice>>,
  now: Merge,
): Record<string, Choice> {
  const byIdentity = new Map<string, Choice>();
  for (const overlap of chosen.overlaps) {
    const choice = choices[overlap.id];
    if (choice !== undefined) byIdentity.set(identity(overlap), choice);
  }
  const carried: Record<string, Choice> = {};
  for (const overlap of now.overlaps) {
    const choice = byIdentity.get(identity(overlap));
    const offer = typeof choice === 'object' ? 'edit' : choice;
    carried[overlap.id] =
      choice !== undefined && offer && overlap.offers.includes(offer) ? choice : 'yours';
  }
  return carried;
}

/**
 * What Review's choices change, as the parts of ours they change and
 * nothing else (ADR 0015 decision 8: a choice goes in as a change to those
 * parts of the document as it is then, never as a whole merged payload).
 * Null when the choices don't resolve, as when blocks didn't fit.
 */
export function reviewTarget(
  merge: Merge,
  choices: Readonly<Record<string, Choice>>,
): ReviewTarget | null {
  return withinTime(FOLD_MS, () => reviewTargetWithin(merge, choices));
}

function reviewTargetWithin(
  merge: Merge,
  choices: Readonly<Record<string, Choice>>,
): ReviewTarget | null {
  const resolved = resolve(merge, choices, { review: false });
  if (!resolved.ok) return null;
  const { plan } = merge;
  const changed = (overlap: Overlap) => {
    const choice = choices[overlap.id];
    return choice !== undefined && choice !== 'yours';
  };
  const picked = merge.overlaps.filter(changed);
  const target: ReviewTarget = {};
  const written = targetOf(resolved.payload);
  if (picked.some((overlap) => overlap.part === 'title')) target.title = written.title;
  if (picked.some((overlap) => overlap.part === 'frontmatter' || overlap.part === 'property')) {
    // The keys chosen alone, unless the block was chosen whole.
    const whole = picked.some((overlap) => overlap.part === 'frontmatter');
    const keys = picked.flatMap((overlap) =>
      overlap.part === 'property' && overlap.key !== null ? [overlap.key] : [],
    );
    const ours = splitFrontmatter(plan.yours.markdown).frontmatter;
    const taken = whole ? undefined : takeKeys(ours, written.frontmatter || null, keys);
    target.frontmatter = taken === undefined ? written.frontmatter : (taken ?? '');
  }
  const bodyPicks = new Set(
    picked.flatMap((overlap) => {
      const index = overlap.part === 'body' ? segmentOf(overlap.id) : null;
      return index === null ? [] : [index];
    }),
  );
  if (bodyPicks.size > 0) {
    // Each segment as yours has it, but those chosen otherwise, as written.
    const picks = new Map<number, SegmentPick>();
    plan.body.segments.forEach((segment, index) => {
      const unfit = plan.unfit.has(index);
      if (segment.taken && !unfit) return;
      const id = unfit ? `body:${index}:fit` : `body:${index}`;
      picks.set(index, { choice: choices[id] ?? 'yours', fit: !unfit });
    });
    const segments = writeBody(plan.body, picks).segments;
    const body = plan.body.segments
      .map((segment, index) =>
        bodyPicks.has(index)
          ? (segments[index] ?? '')
          : segment.yours.map((block) => block.text).join(''),
      )
      .join('');
    // Blocks end with a line break, the last one too: ours ends as it did.
    const ours = splitFrontmatter(plan.yours.markdown).body;
    const ends = ours === '' || /\r?\n$/.test(ours);
    target.body = ends ? body : body.replace(/\r?\n$/, '');
  }
  const extensions: Record<string, Json | null> = {};
  const pickedCover = (part: 'banner' | 'icon') => picked.some((overlap) => overlap.part === part);
  if (pickedCover('banner') || pickedCover('icon')) {
    // Ours' cover, with only the field chosen as theirs: the banner, or the icon.
    const object = (value: unknown) =>
      typeof value === 'object' && value !== null && !Array.isArray(value)
        ? (value as Record<string, Json>)
        : null;
    const ours = object(plan.yours.extensions[COVER_NAMESPACE]);
    const chosen = object(resolved.payload.extensions[COVER_NAMESPACE]);
    const cover: Record<string, Json> = {
      ...(ours ?? (chosen ? { format: chosen['format'] ?? 1 } : {})),
    };
    const fields = [
      ...(pickedCover('banner') ? ['banner'] : []),
      ...(pickedCover('icon') ? ['emoji', 'icon', 'symbol'] : []),
    ];
    for (const field of fields) {
      if (chosen && Object.hasOwn(chosen, field)) cover[field] = chosen[field] as Json;
      else delete cover[field];
    }
    const empty = Object.keys(cover).every((field) => field === 'format');
    extensions[COVER_NAMESPACE] = empty && !ours ? null : cover;
  }
  for (const overlap of picked) {
    if (overlap.part !== 'data' || overlap.namespace === null) continue;
    // As an own property, a `__proto__` namespace included.
    Object.defineProperty(extensions, overlap.namespace, {
      value: resolved.payload.extensions[overlap.namespace] ?? null,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  if (Object.keys(extensions).length > 0) target.extensions = extensions;
  return target;
}
