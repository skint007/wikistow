// Merging conflicting edits (ADR 0013): a three-way merge of a page's
// payload, in the client, on plaintext. No UI here; the merge view in
// `packages/ui/src/page/merge/` is built on these.
//
// Using it:
//
//   const merge = mergePayloads(base, yours, theirs);
//
// - `base` is the version the person's edit grew from, `theirs` the version
//   saved meanwhile, `yours` what the person has (ADR 0013, decision 2).
// - `merge.combined` counts each side's changes that combined on their
//   own ("4 of your changes and 3 of Sam's combined").
// - `merge.overlaps` lists, in page order, each place both changed
//   differently. Each says which choices it `offers`: `yours`, `theirs`,
//   `both` (theirs, then yours) and `edit`, whose text field starts with
//   its `draft`. Body overlaps show their Markdown source; mark each side's
//   words with `wordMarks(overlap.base, overlap.yours)` and the same for
//   theirs. A body overlap with `fits: false` is a block that didn't fit
//   where it went ("This didn't fit where it went").
//
//   const resolved = resolve(merge, { 'body:3': 'yours', title: { edit: 'Soup' } });
//
// - Choices are by overlap ID; each overlap needs one it offers. With no
//   overlaps, resolve with `{}`.
// - `resolved.ok` false means some blocks didn't read as chosen where they
//   went, or the front matter didn't read as merged: `resolved.merge` is the
//   merge again, with them as new overlaps (`body:<n>:fit`, or the whole
//   block as `frontmatter:fit`), and any overlap they replace gone. Keep
//   the choices made, show its overlaps, and resolve it once they're
//   chosen. A pick at a block that didn't fit is taken as it reads, so
//   this ends.
// - `resolved.ok` true gives the `payload` to save on top of theirs, and
//   the `review` of what saving changes in theirs: its Markdown line by
//   line (`same` runs to fold, `changed` with word marks, `added`,
//   `removed`), and the other `fields` it changes (title, banner, icon,
//   attachments, a namespace's data).
//
// The parts below are exported for their tests: `blocksOf` cuts a body into
// blocks, `mergeBlocks` and `writeBody` merge and write a body,
// `mergeFrontmatter` and `writeFrontmatter` the front matter.

export { blocksOf, type Block, type BlockKind, type Container } from './blocks.ts';
export {
  mergeBlocks,
  MergeTooLarge,
  withinTime,
  writeBody,
  type BlockMerge,
  type Choice,
  type Segment,
} from './body.ts';
export { mergeFrontmatter, writeFrontmatter, type FrontmatterMerge } from './frontmatter.ts';
export {
  mergePayloads,
  narrowMerge,
  resolve,
  reviewOf,
  type Merge,
  type Offer,
  type Overlap,
  type Resolved,
  type Review,
  type ReviewField,
} from './payload.ts';
export { wordMarks, type Mark, type ReviewLine } from './review.ts';
