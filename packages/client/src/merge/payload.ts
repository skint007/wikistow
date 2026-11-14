// A whole page payload merged (ADR 0013, decisions 2 to 5): the title as
// one field, the front matter by key, the body by block, attachments by
// ID, the link table by entry, the banner and icon by field, and other
// data by namespace. Then resolved with the person's choices.
import { COVER_NAMESPACE } from '../cover.ts';
import { LINKS_NAMESPACE } from '../link-table.ts';
import { splitFrontmatter } from '../markdown/index.ts';
import type { AttachmentRef, PagePayload } from '../payload.ts';
import { blocksOf, linesOf, type Block } from './blocks.ts';
import {
  edges,
  mergeBlocks,
  writeBody,
  type BlockMerge,
  type Choice,
  type SegmentPick,
} from './body.ts';
import {
  frontmatterPieces,
  mergeFrontmatter,
  writeFrontmatter,
  type FrontmatterMerge,
} from './frontmatter.ts';
import { reviewLines, type Piece, type ReviewLine } from './review.ts';

type Json = PagePayload['extensions'][string];

/** What an overlap lets the person do. */
export type Offer = 'yours' | 'theirs' | 'both' | 'edit';

/**
 * A place both sides changed differently, for the person to choose at.
 * Text is Markdown source; `base` is what both started from, for marking
 * each side's changed words, and is empty where base had none.
 */
export type Overlap = { readonly id: string; readonly offers: readonly Offer[] } & (
  | {
      readonly part: 'body';
      readonly base: string;
      readonly yours: string;
      readonly theirs: string;
      /** False for a block that didn't fit where it went: "This didn't fit where it went". */
      readonly fits: boolean;
      /** The heading it sits under, and the block before it, for context. */
      readonly under: string | null;
      readonly before: string | null;
      /** What **Edit…** starts with. */
      readonly draft: string;
    }
  | {
      /** The title; a front matter key's lines; or the whole block, where it isn't keys or didn't fit. */
      readonly part: 'title' | 'property' | 'frontmatter';
      /** The property's key, else null. */
      readonly key: string | null;
      readonly base: string;
      readonly yours: string;
      readonly theirs: string;
      readonly draft: string;
    }
  | {
      /** The banner, the icon (an emoji, an icon from the set or an image), or a namespace's data. */
      readonly part: 'banner' | 'icon' | 'data';
      /** The data's namespace, else null. */
      readonly namespace: string | null;
      /** Each side's value as written in the payload; null where it has none. */
      readonly base: Json | null;
      readonly yours: Json | null;
      readonly theirs: Json | null;
    }
);

/** A merge of three payloads, for `resolve`. */
export type Merge = {
  /** The overlaps, in page order: banner, icon, title, front matter, body, data. */
  readonly overlaps: readonly Overlap[];
  /** How many of each side's changes combined on their own. */
  readonly combined: { readonly yours: number; readonly theirs: number };
  /** How each part merges. Only `resolve` reads it. */
  readonly plan: Plan;
  /**
   * The overlaps offered, where only some are (`narrowMerge`): every other
   * overlap is resolved as yours.
   */
  readonly only?: (overlap: Overlap) => boolean;
};

/**
 * `merge` offering only the overlaps `only` keeps, the others resolved as
 * yours, as Review offers only the parts a note names (ADR 0015 decision 8).
 */
export function narrowMerge(merge: Merge, only: (overlap: Overlap) => boolean): Merge {
  return { ...merge, overlaps: merge.overlaps.filter(only), only };
}

// A field merged whole: the value taken, or an overlap.
type Field<T> = { taken: T } | { overlap: { base: T; yours: T; theirs: T } };

type Plan = {
  readonly base: PagePayload;
  readonly yours: PagePayload;
  readonly theirs: PagePayload;
  readonly title: Field<string>;
  readonly frontmatter: FrontmatterMerge;
  /** Whether the front matter as merged didn't read as merged, and is now one overlap. */
  readonly frontmatterFits: boolean;
  readonly body: BlockMerge;
  /** The body segments whose blocks didn't fit where they went. */
  readonly unfit: ReadonlySet<number>;
  readonly cover: { banner: Field<Json | null>; icon: Field<Json | null> };
  readonly data: ReadonlyMap<string, Field<Json | null>>;
};

const ICON_KEYS = ['emoji', 'icon', 'symbol'] as const;

/**
 * Merge the person's version (`yours`) with `theirs`, both grown from
 * `base`. Overlaps are left for the person; `resolve` writes the result.
 */
export function mergePayloads(base: PagePayload, yours: PagePayload, theirs: PagePayload): Merge {
  const combined = { yours: 0, theirs: 0 };
  const field = <T extends Json>(b: T, y: T, t: T): Field<T> => {
    const [yoursChanged, theirsChanged] = [!same(y, b), !same(t, b)];
    if (yoursChanged && !theirsChanged) combined.yours++;
    if (theirsChanged && !yoursChanged) combined.theirs++;
    if (!yoursChanged || same(y, t)) return { taken: t };
    if (!theirsChanged) return { taken: y };
    return { overlap: { base: b, yours: y, theirs: t } };
  };
  const b = splitFrontmatter(base.markdown);
  const y = splitFrontmatter(yours.markdown);
  const t = splitFrontmatter(theirs.markdown);
  const frontmatter = mergeFrontmatter(b.frontmatter, y.frontmatter, t.frontmatter);
  combined.yours += frontmatter.combined.yours;
  combined.theirs += frontmatter.combined.theirs;
  const body = mergeBlocks(b.body, y.body, t.body);
  for (const segment of body.segments) {
    // Blank lines alone are no change a person sees.
    const blank = [segment.base, segment.yours, segment.theirs].every((blocks) =>
      blocks.every((block) => block.kind === 'blank'),
    );
    if (blank) continue;
    if (segment.from === 'yours' || segment.from === 'union') combined.yours++;
    if (segment.from === 'theirs' || segment.from === 'union') combined.theirs++;
  }
  const coverOf = (payload: PagePayload) => {
    const cover = payload.extensions[COVER_NAMESPACE];
    return isObject(cover) ? cover : {};
  };
  const icon = (payload: PagePayload) => {
    const cover = coverOf(payload);
    const parts = Object.fromEntries(
      ICON_KEYS.flatMap((key) => (key in cover ? [[key, cover[key] ?? null]] : [])),
    );
    return Object.keys(parts).length > 0 ? parts : null;
  };
  const cover = {
    banner: field(
      coverOf(base)['banner'] ?? null,
      coverOf(yours)['banner'] ?? null,
      coverOf(theirs)['banner'] ?? null,
    ),
    icon: field(icon(base), icon(yours), icon(theirs)),
  };
  const data = new Map<string, Field<Json | null>>();
  const namespaces = new Set(
    [base, yours, theirs].flatMap((payload) => Object.keys(payload.extensions)),
  );
  for (const namespace of namespaces) {
    if (namespace === COVER_NAMESPACE || namespace === LINKS_NAMESPACE) continue;
    const value = (payload: PagePayload) => payload.extensions[namespace] ?? null;
    data.set(namespace, field(value(base), value(yours), value(theirs)));
  }
  const plan: Plan = {
    base,
    yours,
    theirs,
    title: field(base.title, yours.title, theirs.title),
    frontmatter,
    frontmatterFits: true,
    body,
    unfit: new Set(),
    cover,
    data,
  };
  return { overlaps: overlapsOf(plan), combined, plan };
}

const text = (blocks: readonly Block[]) => blocks.map((block) => block.text).join('');

// A stretch's text as an overlap shows it: without the blank lines it
// starts and ends with, which stay where they are.
function shown(blocks: readonly Block[]): string {
  const [lead, trail] = edges(blocks);
  return text(blocks.slice(lead.length, blocks.length - trail.length));
}

// Written text as an overlap shows it, the same way.
function trimmed(written: string): string {
  const lines = linesOf(written);
  const blank = (line: string | undefined) => line !== undefined && /^[ \t>]*\r?\n?$/.test(line);
  while (blank(lines[0])) lines.shift();
  while (blank(lines.at(-1))) lines.pop();
  return lines.join('');
}

// The overlaps a plan leaves, in page order.
function overlapsOf(plan: Plan): Overlap[] {
  const overlaps: Overlap[] = [];
  const picture = (part: 'banner' | 'icon', merged: Field<Json | null>) => {
    if ('overlap' in merged)
      overlaps.push({
        id: part,
        part,
        namespace: null,
        offers: ['yours', 'theirs'],
        ...merged.overlap,
      });
  };
  picture('banner', plan.cover.banner);
  picture('icon', plan.cover.icon);
  const lines = (
    part: 'title' | 'property' | 'frontmatter',
    id: string,
    key: string | null,
    base: string,
    yours: string,
    theirs: string,
  ) =>
    overlaps.push({
      id,
      part,
      key,
      offers: ['yours', 'theirs', 'edit'],
      base,
      yours,
      theirs,
      draft: yours || theirs,
    });
  if ('overlap' in plan.title) {
    const { base, yours, theirs } = plan.title.overlap;
    lines('title', 'title', null, base, yours, theirs);
  }
  const { frontmatter } = plan;
  if (!plan.frontmatterFits || (frontmatter.kind === 'whole' && frontmatter.taken === undefined)) {
    const whole = plan.frontmatterFits ? 'frontmatter' : 'frontmatter:fit';
    const block = (payload: PagePayload) => splitFrontmatter(payload.markdown).frontmatter ?? '';
    lines('frontmatter', whole, null, block(plan.base), block(plan.yours), block(plan.theirs));
  } else if (frontmatter.kind === 'keys') {
    for (const change of frontmatter.keys) {
      if (change.from !== 'overlap') continue;
      lines(
        'property',
        `property:${change.key}`,
        change.key,
        change.base ?? '',
        change.yours ?? '',
        change.theirs ?? '',
      );
    }
  }
  // Each body overlap, and each segment that didn't fit, with the drafts
  // **Edit…** starts with: yours written into the list it lands in.
  const { segments } = plan.body;
  const yoursThere = new Map<number, SegmentPick>();
  segments.forEach((segment, index) => {
    if (!segment.taken || plan.unfit.has(index))
      yoursThere.set(index, { choice: 'yours', fit: true });
  });
  const drafts = writeBody(plan.body, yoursThere).segments;
  // Where yours has nothing there, Edit… starts with theirs, written the same way.
  const theirsThere = new Map(
    [...yoursThere].map(([index, pick]) => [index, { ...pick, choice: 'theirs' as const }]),
  );
  const theirsDrafts = writeBody(plan.body, theirsThere).segments;
  let under: string | null = null;
  let before: string | null = null;
  segments.forEach((segment, index) => {
    const fits = !plan.unfit.has(index);
    if (!segment.taken || !fits) {
      const yours = shown(segment.yours);
      const draft = yours === '' ? theirsDrafts[index] : drafts[index];
      overlaps.push({
        id: fits ? `body:${index}` : `body:${index}:fit`,
        part: 'body',
        offers: fits ? ['yours', 'theirs', 'both', 'edit'] : ['yours', 'theirs', 'edit'],
        base: shown(segment.base),
        yours,
        theirs: shown(segment.theirs),
        fits,
        under,
        before,
        draft: draft === undefined ? yours : trimmed(draft),
      });
    }
    for (const block of segment.taken ?? segment.theirs) {
      if (block.kind === 'blank') continue;
      if (block.heading !== null) under = block.heading;
      before = block.text;
    }
  });
  for (const [namespace, merged] of plan.data) {
    if ('overlap' in merged)
      overlaps.push({
        id: `data:${namespace}`,
        part: 'data',
        namespace,
        offers: ['yours', 'theirs'],
        ...merged.overlap,
      });
  }
  return overlaps;
}

// How each body segment the person chooses at is written.
function picksOf(plan: Plan, choiceOf: (id: string) => Choice): Map<number, SegmentPick> {
  const picks = new Map<number, SegmentPick>();
  plan.body.segments.forEach((segment, index) => {
    if (plan.unfit.has(index))
      picks.set(index, { choice: choiceOf(`body:${index}:fit`), fit: false });
    else if (!segment.taken) picks.set(index, { choice: choiceOf(`body:${index}`), fit: true });
  });
  return picks;
}

/** What the review lists besides the Markdown: what else the merge changes in theirs. */
export type ReviewField =
  | { part: 'title'; from: string; to: string }
  | { part: 'banner' | 'icon' }
  | { part: 'attachments'; added: number; removed: number }
  | { part: 'data'; namespace: string };

/** What saving the merged payload changes in theirs. */
export type Review = { lines: ReviewLine[]; fields: ReviewField[] };

/**
 * A merge resolved: the payload to save, on top of theirs, and the review
 * of what that changes in theirs; or, where some blocks didn't read as
 * chosen where they went, the merge again with them as new overlaps,
 * the others as they were.
 */
export type Resolved =
  | { ok: true; payload: PagePayload; review: Review }
  | { ok: false; merge: Merge };

/**
 * Write the merge with `choices`, by overlap ID: every overlap needs one
 * it offers. The body and front matter are read back first: anything that
 * doesn't read as chosen where it went comes back as an overlap.
 */
export function resolve(
  merge: Merge,
  choices: Readonly<Record<string, Choice>>,
  /** Whether to work out the review of what it changes, which only the merge view shows. */
  { review = true }: { review?: boolean } = {},
): Resolved {
  const { plan } = merge;
  const choiceOf = (id: string): Choice => {
    const choice = choices[id];
    const listed = merge.overlaps.find((other) => other.id === id);
    // Not offered in a narrowed merge: yours, which every overlap offers.
    if (!listed && merge.only) return 'yours';
    const offers = listed?.offers ?? [];
    if (choice === undefined || !offers.includes(typeof choice === 'object' ? 'edit' : choice))
      throw new Error(`No choice made for ${id}.`);
    return choice;
  };
  const pick = <T>(id: string, merged: Field<T>, edit: (text: string) => T): T => {
    if ('taken' in merged) return merged.taken;
    const choice = choiceOf(id);
    if (typeof choice === 'object') return edit(choice.edit);
    return choice === 'yours' ? merged.overlap.yours : merged.overlap.theirs;
  };
  const written = writeBody(plan.body, picksOf(plan, choiceOf));
  const frontmatter = mergedFrontmatter(plan, choiceOf);
  const newlyUnfit = written.unfit.filter((index) => !plan.unfit.has(index));
  if (newlyUnfit.length > 0 || frontmatter === undefined) {
    const next: Plan = {
      ...plan,
      unfit: new Set([...plan.unfit, ...newlyUnfit]),
      frontmatterFits: plan.frontmatterFits && frontmatter !== undefined,
    };
    // What comes back as an overlap no longer counts as combined.
    const combined = { ...merge.combined };
    const uncount = (from: { yours: number; theirs: number }) => {
      combined.yours -= from.yours;
      combined.theirs -= from.theirs;
    };
    for (const index of newlyUnfit) {
      const from = plan.body.segments[index]?.from;
      uncount({
        yours: Number(from === 'yours' || from === 'union'),
        theirs: Number(from === 'theirs' || from === 'union'),
      });
    }
    if (plan.frontmatterFits && !next.frontmatterFits) uncount(plan.frontmatter.combined);
    const overlaps = overlapsOf(next);
    const only = merge.only;
    return {
      ok: false,
      merge: only
        ? { overlaps: overlaps.filter(only), combined, plan: next, only }
        : { overlaps, combined, plan: next },
    };
  }
  const title = pick('title', plan.title, (typed) => typed);
  const noEdit = () => {
    throw new Error('Nothing to edit there.');
  };
  const extensions = { ...plan.theirs.extensions };
  const set = (namespace: string, value: Json | null) => {
    if (value === null) delete extensions[namespace];
    // As an own property, a `__proto__` namespace included.
    else
      Object.defineProperty(extensions, namespace, {
        value,
        enumerable: true,
        writable: true,
        configurable: true,
      });
  };
  for (const [namespace, merged] of plan.data)
    set(namespace, pick(`data:${namespace}`, merged, noEdit));
  set(LINKS_NAMESPACE, mergedLinks(plan));
  set(
    COVER_NAMESPACE,
    mergedCover(
      plan,
      pick('banner', plan.cover.banner, noEdit),
      pick('icon', plan.cover.icon, noEdit),
    ),
  );
  const markdown = joinMarkdown(frontmatter, written.body);
  const payload: PagePayload = {
    ...plan.theirs,
    format: {
      ...plan.theirs.format,
      minor: Math.max(plan.theirs.format.minor, plan.yours.format.minor),
    },
    title,
    markdown,
    attachments: mergedAttachments(plan, markdown, extensions),
    extensions,
  };
  return {
    ok: true,
    payload,
    review: review ? reviewOf(plan.theirs, payload) : { lines: [], fields: [] },
  };
}

// The merged front matter, or undefined where it didn't read as merged.
function mergedFrontmatter(
  plan: Plan,
  choiceOf: (id: string) => Choice,
): string | null | undefined {
  const { frontmatter } = plan;
  // A pick at the whole block: as that side has it, or as typed.
  const whole = (id: string) => {
    const choice = choiceOf(id);
    if (typeof choice === 'object') return choice.edit === '' ? null : choice.edit;
    return splitFrontmatter((choice === 'yours' ? plan.yours : plan.theirs).markdown).frontmatter;
  };
  if (!plan.frontmatterFits) return whole('frontmatter:fit');
  if (frontmatter.kind === 'whole') {
    return frontmatter.taken !== undefined ? frontmatter.taken : whole('frontmatter');
  }
  const choices = new Map<string, Choice>();
  for (const change of frontmatter.keys)
    if (change.from === 'overlap') choices.set(change.key, choiceOf(`property:${change.key}`));
  const written = writeFrontmatter(frontmatter, choices);
  return written.ok ? written.frontmatter : undefined;
}

// A front matter block and a body as one page's Markdown.
function joinMarkdown(frontmatter: string | null, body: string): string {
  if (frontmatter === null || frontmatter === '') return body;
  const lineBreak = frontmatter.match(/\r?\n/)?.[0] ?? '\n';
  return body !== '' && !frontmatter.endsWith('\n')
    ? frontmatter + lineBreak + body
    : frontmatter + body;
}

// Both sides' link table entries, theirs taking precedence for the same link text.
function mergedLinks(plan: Plan): Json | null {
  const linksOf = (payload: PagePayload) => {
    const table = payload.extensions[LINKS_NAMESPACE];
    const links = isObject(table) && table['format'] === 1 ? table['links'] : undefined;
    return isObject(table) && Array.isArray(links)
      ? { table, links: links.filter(isObject) }
      : null;
  };
  const raw = plan.theirs.extensions[LINKS_NAMESPACE];
  const [theirs, yours] = [linksOf(plan.theirs), linksOf(plan.yours)];
  if (!yours) return raw ?? null;
  if (!theirs) return raw === undefined ? yours.table : raw;
  const keys = new Set(theirs.links.map((entry) => entry['key']));
  return {
    ...theirs.table,
    links: [...theirs.links, ...yours.links.filter((entry) => !keys.has(entry['key']))],
  };
}

// Theirs' cover with the banner and icon as merged.
function mergedCover(plan: Plan, banner: Json | null, icon: Json | null): Json | null {
  const old = plan.theirs.extensions[COVER_NAMESPACE];
  const theirs = isObject(old) ? old : null;
  const yours = plan.yours.extensions[COVER_NAMESPACE];
  if (!theirs && banner === null && icon === null) return old ?? null;
  const cover: { [key: string]: Json } = {
    ...(theirs ?? (isObject(yours) ? { format: yours['format'] ?? 1 } : { format: 1 })),
  };
  if (banner === null) delete cover['banner'];
  else cover['banner'] = banner;
  for (const key of ICON_KEYS) delete cover[key];
  if (isObject(icon)) Object.assign(cover, icon);
  return cover;
}

// Attachments on either side, less any either side removed, unless the
// merged payload still names one.
function mergedAttachments(
  plan: Plan,
  markdown: string,
  extensions: PagePayload['extensions'],
): AttachmentRef[] {
  const ids = (payload: PagePayload) => new Set(payload.attachments.map((ref) => ref.id));
  const [base, yours, theirs] = [ids(plan.base), ids(plan.yours), ids(plan.theirs)];
  const named = `${markdown}\u0000${JSON.stringify(extensions)}`;
  const candidates = [
    ...plan.theirs.attachments,
    ...plan.yours.attachments.filter((ref) => !theirs.has(ref.id)),
  ];
  return candidates.filter(
    ({ id }) => !(base.has(id) && (!yours.has(id) || !theirs.has(id))) || named.includes(id),
  );
}

/** What saving `merged` changes in `theirs`. */
export function reviewOf(theirs: PagePayload, merged: PagePayload): Review {
  const pieces = (payload: PagePayload): Piece[] => {
    const { frontmatter, body } = splitFrontmatter(payload.markdown);
    const ended = body === '' || body.endsWith('\n') ? body : `${body}\n`;
    return [...frontmatterPieces(frontmatter), ...blocksOf(ended)];
  };
  const fields: ReviewField[] = [];
  if (merged.title !== theirs.title)
    fields.push({ part: 'title', from: theirs.title, to: merged.title });
  const cover = (payload: PagePayload) => {
    const value = payload.extensions[COVER_NAMESPACE];
    return isObject(value) ? value : {};
  };
  const [was, now] = [cover(theirs), cover(merged)];
  if (!same(was['banner'] ?? null, now['banner'] ?? null)) fields.push({ part: 'banner' });
  if (ICON_KEYS.some((key) => !same(was[key] ?? null, now[key] ?? null)))
    fields.push({ part: 'icon' });
  const before = new Set(theirs.attachments.map((ref) => ref.id));
  const after = new Set(merged.attachments.map((ref) => ref.id));
  const added = [...after].filter((id) => !before.has(id)).length;
  const removed = [...before].filter((id) => !after.has(id)).length;
  if (added + removed > 0) fields.push({ part: 'attachments', added, removed });
  const namespaces = new Set([
    ...Object.keys(theirs.extensions),
    ...Object.keys(merged.extensions),
  ]);
  for (const namespace of namespaces) {
    if (namespace === COVER_NAMESPACE || namespace === LINKS_NAMESPACE) continue;
    if (!same(theirs.extensions[namespace] ?? null, merged.extensions[namespace] ?? null))
      fields.push({ part: 'data', namespace });
  }
  return { lines: reviewLines(pieces(theirs), pieces(merged)), fields };
}

const isObject = (value: Json | undefined): value is { [key: string]: Json } =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Whether two JSON values are the same, whatever their keys' order. */
function same(a: Json | undefined, b: Json | undefined): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((item, i) => same(item, b[i]))
    );
  }
  if (!isObject(a) || !isObject(b)) return false;
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length && keys.every((key) => key in b && same(a[key], b[key]))
  );
}
