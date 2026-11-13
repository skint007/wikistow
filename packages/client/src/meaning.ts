import { openOnDevice, sealOnDevice } from './device-seal.ts';
import { canonical, decodeUtf8, fromBase64, toBase64, utf8 } from './encoding.ts';
import type { PrivateIdentity } from './identity.ts';
import { RevisionId, type InstallationId } from './ids.ts';
import { sodium } from './sodium.ts';

// Search by meaning (ADR 0016, decision 4): a page's reduced text cut into
// passages, each passage's vector kept as signed bytes, the scan that finds
// the pages nearest a query, and the sealed file the vectors are kept in.
// The model that makes the vectors runs elsewhere, in a worker; nothing
// here knows it but by its hash.

/** The most tokens a passage holds, its title and heading included (ADR 0016, decision 4). */
export const PASSAGE_TOKENS = 256;

/**
 * How passages are cut and kept, bound into the kept file
 * (`sealMeaningIndex`): a change to the rules here, or to the file's
 * layout, changes it, so a file kept before opens as nothing.
 */
export const MEANING_PASSAGES_VERSION = 1;

/** One passage of a page, as its vector is made from it. */
export type Passage = {
  /** What is embedded: the page's title, the heading it is under, and its text. */
  text: string;
  /** Where its own text starts in the page's text, or its heading does if it has none. */
  start: number;
  /** The heading it is under, or null before the first, or for a page that is one passage. */
  heading: string | null;
  /** A hash of `text` (`passageHash`), by which its vector is kept. */
  hash: string;
};

export type PassageOptions = {
  /** At least 4. */
  maxTokens?: number;
  /**
   * How many tokens the model makes of a word, a run without spaces. The
   * model's tokenizer splits text at spaces first, so a text's tokens are
   * its words' added up.
   */
  countTokens?: (word: string) => number;
};

/**
 * A page's text cut into passages, from its text as the index reduces it
 * (`reducedText`), with where its headings start in it:
 *
 * - A page whose title and text fit in one passage is one passage of both,
 *   and a page with no text but a title, of its title.
 * - Else it is cut at its headings: the text before the first, and each
 *   heading with what follows it up to the next. Each passage of a section
 *   starts with the page's title, and the heading it is under, on lines of
 *   their own; a title takes at most half a passage and a heading a quarter,
 *   cut short if longer. A heading with nothing under it is a passage of the
 *   title and heading alone.
 * - A section longer than a passage is cut at its paragraphs (its lines),
 *   each passage holding as many as fit; a paragraph longer than that,
 *   between words, and a word longer than that, between characters.
 *
 * The text is the index's, so at most its 65,536 characters are cut.
 */
export function meaningPassages(
  page: { title: string; text: string; headings: readonly number[] },
  { maxTokens = PASSAGE_TOKENS, countTokens = estimateTokens }: PassageOptions = {},
): Passage[] {
  if (!Number.isInteger(maxTokens) || maxTokens < 4) {
    throw new RangeError('A passage holds at least 4 tokens');
  }
  const { text } = page;
  const title = page.title.trim();
  const count = (from: string) => {
    let tokens = 0;
    for (const [word] of from.matchAll(WORD)) tokens += countTokens(word);
    return tokens;
  };
  const passage = (passageText: string, start: number, heading: string | null): Passage => ({
    text: passageText,
    start,
    heading,
    hash: passageHash(passageText),
  });
  if (count(title) + count(text) <= maxTokens) {
    const whole = [title, text].filter(Boolean).join('\n');
    return whole ? [passage(whole, 0, null)] : [];
  }
  /** `from` cut to its first `tokens` tokens. */
  const first = (from: string, tokens: number) => {
    const [chunk] = chunks(from, 0, from.length, tokens, countTokens);
    return chunk ? from.slice(0, chunk.end) : '';
  };
  const titlePart = first(title, Math.floor(maxTokens / 2));
  // Each heading's start, in order, at a line's start in the text.
  const starts = [
    ...new Set(
      page.headings.filter(
        (at) =>
          Number.isInteger(at) &&
          at >= 0 &&
          at < text.length &&
          (at === 0 || text[at - 1] === '\n'),
      ),
    ),
  ].sort((a, b) => a - b);
  const passages: Passage[] = [];
  const section = (heading: string | null, headingAt: number, from: number, to: number) => {
    const headingPart = heading === null ? '' : first(heading, Math.floor(maxTokens / 4));
    const prefix = [titlePart, headingPart].filter(Boolean).join('\n');
    const budget = maxTokens - count(prefix);
    const withPrefix = (body: string) => (prefix && body ? `${prefix}\n${body}` : prefix || body);
    // Each paragraph's pieces, packed into passages as long as they can be.
    let open: { start: number; end: number; tokens: number } | null = null;
    const close = () => {
      if (open)
        passages.push(passage(withPrefix(text.slice(open.start, open.end)), open.start, heading));
      open = null;
    };
    for (let line = from; line < to;) {
      const lineEnd = Math.min(to, text.indexOf('\n', line) < 0 ? to : text.indexOf('\n', line));
      for (const piece of chunks(text, line, lineEnd, budget, countTokens)) {
        if (open && open.tokens + piece.tokens <= budget) {
          open.end = piece.end;
          open.tokens += piece.tokens;
        } else {
          close();
          open = { ...piece };
        }
      }
      line = lineEnd + 1;
    }
    const before = passages.length;
    close();
    if (passages.length === before && heading !== null && prefix) {
      passages.push(passage(prefix, headingAt, heading));
    }
  };
  section(null, 0, 0, starts[0] ?? text.length);
  for (const [i, at] of starts.entries()) {
    const lineEnd = text.indexOf('\n', at);
    const headingEnd = lineEnd < 0 ? text.length : lineEnd;
    section(text.slice(at, headingEnd), at, headingEnd + 1, starts[i + 1] ?? text.length);
  }
  return passages;
}

/** A run without spaces. */
const WORD = /\S+/g;

/**
 * `text` from `from` to `to` in pieces of whole words, each as long as it
 * can be in `budget` tokens, but a word longer than that, which is cut
 * between characters, each piece of it as long as it can be.
 */
function* chunks(
  text: string,
  from: number,
  to: number,
  budget: number,
  countTokens: (word: string) => number,
): Generator<{ start: number; end: number; tokens: number }> {
  let open: { start: number; end: number; tokens: number } | null = null;
  const words = new RegExp(WORD.source, 'g');
  words.lastIndex = from;
  for (let match = words.exec(text); match !== null && match.index < to; match = words.exec(text)) {
    const start = match.index;
    const end = Math.min(to, start + match[0].length);
    const tokens = countTokens(text.slice(start, end));
    if (tokens > budget) {
      if (open) yield open;
      open = null;
      yield* cutWord(text, start, end, budget, countTokens);
      continue;
    }
    if (open && open.tokens + tokens <= budget) {
      open.end = end;
      open.tokens += tokens;
    } else {
      if (open) yield open;
      open = { start, end, tokens };
    }
  }
  if (open) yield open;
}

/** The word from `start` to `end` in pieces of whole characters, each as long as fits in `budget`. */
function* cutWord(
  text: string,
  start: number,
  end: number,
  budget: number,
  countTokens: (word: string) => number,
): Generator<{ start: number; end: number; tokens: number }> {
  // Where each character starts, and the word's end.
  const bounds: number[] = [];
  for (let at = start; at < end; at += (text.codePointAt(at) ?? 0) > 0xffff ? 2 : 1)
    bounds.push(at);
  bounds.push(end);
  for (let first = 0; first < bounds.length - 1;) {
    // The most characters from `first` that fit, and at least one.
    let low = first + 1;
    let high = bounds.length - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (countTokens(text.slice(bounds[first], bounds[middle])) <= budget) low = middle;
      else high = middle - 1;
    }
    const pieceStart = bounds[first]!;
    const pieceEnd = bounds[low]!;
    yield {
      start: pieceStart,
      end: pieceEnd,
      tokens: countTokens(text.slice(pieceStart, pieceEnd)),
    };
    first = low;
  }
}

/**
 * About as many tokens as the model's tokenizer (BERT's, uncased) makes of
 * `word`, a run without spaces, or more for prose, so a passage cut by it
 * holds no more than it should. Accents go, as the tokenizer drops them.
 * Each mark of punctuation or symbol is a token, and so is each character
 * of any script but Latin. A run of Latin letters that reads as a word
 * (cased as one, at most 20 letters, a quarter of them vowels) is one token
 * up to 6 letters long, and one each 4 letters past that; any other run of
 * Latin letters and digits, such as a number, an ID or a hash, one a
 * character, as no token is shorter than one. An estimate all the same:
 * where the tokenizer is at hand, its count is the one to pass.
 */
export function estimateTokens(word: string): number {
  let tokens = 0;
  let run = '';
  const flush = () => {
    if (run)
      tokens += WORDLIKE.test(run) && vowels(run) * 4 >= run.length ? wordTokens(run) : run.length;
    run = '';
  };
  for (const char of word.normalize('NFKD')) {
    if (MARK.test(char)) continue;
    if (LATIN.test(char)) {
      run += char;
      continue;
    }
    flush();
    if (!SPACE.test(char)) tokens++;
  }
  flush();
  return tokens;
}

const MARK = /^\p{M}$/u;
const LATIN = /^[\p{Script=Latin}\p{Nd}]$/u;
const SPACE = /^\s$/u;
/** Letters cased as a word is: all small, all capitals, or a capital first. */
const WORDLIKE = /^(?:\p{Lu}?\p{Ll}{1,19}|\p{Lu}{1,20})$/u;
const vowels = (run: string) => run.match(/[aeiouy]/gi)?.length ?? 0;
const wordTokens = (run: string) => (run.length <= 6 ? 1 : Math.ceil(run.length / 4));

/** A passage's text, hashed: 16 bytes of BLAKE2b, as base64url. */
export const passageHash = (text: string): string =>
  toBase64(sodium.crypto_generichash(HASH_BYTES, utf8(text), null));

const HASH_BYTES = 16;

/** A vector kept as signed bytes, each `scale` times the value it stands for. */
export type Vector8 = { scale: number; values: Int8Array };

/**
 * `vector` in 8 bits: each value times 127 over the largest value's size,
 * rounded to the nearest integer, halves away from zero, so -127 to 127;
 * with one scale, that size over 127 (a 32-bit float, as it's kept). A
 * vector of zeros keeps a scale of 0.
 */
export function quantizeVector(vector: ArrayLike<number>): Vector8 {
  let largest = 0;
  for (let i = 0; i < vector.length; i++) {
    const value = vector[i]!;
    if (!Number.isFinite(value)) throw new RangeError('A vector holds only numbers');
    largest = Math.max(largest, Math.abs(value));
  }
  const values = new Int8Array(vector.length);
  if (largest === 0) return { scale: 0, values };
  for (let i = 0; i < vector.length; i++) {
    const value = (vector[i]! * 127) / largest;
    values[i] = Math.sign(value) * Math.round(Math.abs(value));
  }
  return { scale: Math.fround(largest / 127), values };
}

/** A page found by `nearestPages`: its key, which of its passages matched best, and how well. */
export type NearestPage<K> = { key: K; passage: number; score: number };

/**
 * The `limit` pages whose vectors are nearest `query`, best first, each by
 * its best passage, the first of those as good. A score is the query's
 * cosine with a passage's vector, which the model gives at unit length, so
 * its dot product with the query made unit length: 1 is the same meaning.
 * A page with no passages isn't found, and neither is any for a query of
 * zeros. Takes time linear in the passages' values, with no index: 20,000
 * passages, of a library of 10,000 pages, take some milliseconds.
 */
export function nearestPages<K>(
  query: ArrayLike<number>,
  pages: Iterable<readonly [K, readonly { readonly vector: Vector8 }[]]>,
  limit: number,
): NearestPage<K>[] {
  const unit = Float32Array.from(query);
  let norm = 0;
  for (const value of unit) norm += value * value;
  norm = Math.sqrt(norm);
  if (limit < 1 || !(norm > 0) || !Number.isFinite(norm)) return [];
  for (let i = 0; i < unit.length; i++) unit[i]! /= norm;
  const found: NearestPage<K>[] = [];
  for (const [key, passages] of pages) {
    let score = -Infinity;
    let best = -1;
    for (const [at, { vector }] of passages.entries()) {
      const { values, scale } = vector;
      if (values.length !== unit.length) {
        throw new RangeError('A vector of another length than the query');
      }
      let dot = 0;
      for (let i = 0; i < unit.length; i++) dot += unit[i]! * values[i]!;
      if (dot * scale > score) {
        score = dot * scale;
        best = at;
      }
    }
    if (best < 0 || (found.length === limit && score <= found[limit - 1]!.score)) continue;
    let place = found.length;
    while (place > 0 && found[place - 1]!.score < score) place--;
    found.splice(place, 0, { key, passage: best, score });
    if (found.length > limit) found.pop();
  }
  return found;
}

/** A passage's vector as it is kept: by its text's hash, with where it starts in the page. */
export type MeaningPassage = { hash: string; start: number; vector: Vector8 };

/** The vectors kept of each version, by its revision ID, its passages in order. */
export type KeptMeaning = ReadonlyMap<RevisionId, readonly MeaningPassage[]>;

/** Who the vectors are kept for, on which server: a `ClientContext` will do. */
export type MeaningKeeper = { identity: PrivateIdentity; installationId: InstallationId };

// The vectors are kept in a file of their own (ADR 0016, decision 4),
// sealed for this person (`sealOnDevice`) as the word index is, and bound to
// the installation, the person, the model and how passages are cut, but not
// to the app's build: an app update doesn't make every page's vectors again.
const MEANING_KEY = 'meaning-index-key/v1';
const meaningAd = (keeper: MeaningKeeper, modelHash: string) =>
  canonical('meaning-index/v1', [
    keeper.installationId,
    keeper.identity.public.id,
    modelHash,
    MEANING_PASSAGES_VERSION,
  ]);

/** `kept`, sealed for this person on this server, for the model whose hash is `modelHash`. */
export function sealMeaningIndex(
  keeper: MeaningKeeper,
  kept: KeptMeaning,
  modelHash: string,
): Uint8Array {
  return sealOnDevice(
    keeper.identity,
    MEANING_KEY,
    meaningAd(keeper, modelHash),
    meaningBytes(kept),
  );
}

/**
 * What `sealMeaningIndex` sealed, or null if it isn't this person's on this
 * server for this model and way of cutting passages, or is damaged.
 */
export function openMeaningIndex(
  keeper: MeaningKeeper,
  sealed: Uint8Array,
  modelHash: string,
): KeptMeaning | null {
  const plaintext = openOnDevice(
    keeper.identity,
    MEANING_KEY,
    meaningAd(keeper, modelHash),
    sealed,
  );
  return plaintext && readMeaningBytes(plaintext);
}

/**
 * The kept vectors as bytes, integers big-endian: the vectors' length (2
 * bytes) and the number of versions (4); then each version's revision ID's
 * length (2) and its UTF-8, and its number of passages (4); then each
 * passage's hash (16), start (4), scale (a 32-bit float) and values (a
 * signed byte each). Every vector has the same length.
 */
export function meaningBytes(kept: KeptMeaning): Uint8Array {
  let dimensions: number | null = null;
  let size = 2 + 4;
  const ids = new Map<RevisionId, Uint8Array>();
  for (const [revisionId, passages] of kept) {
    const id = utf8(revisionId);
    if (id.length > 0xffff) throw new RangeError('A revision ID too long to keep');
    ids.set(revisionId, id);
    size += 2 + id.length + 4;
    for (const { vector } of passages) {
      dimensions ??= vector.values.length;
      if (vector.values.length !== dimensions) throw new RangeError('Vectors of different lengths');
      size += HASH_BYTES + 4 + 4 + dimensions;
    }
  }
  if ((dimensions ?? 0) > 0xffff) throw new RangeError('A vector too long to keep');
  const bytes = new Uint8Array(size);
  const view = new DataView(bytes.buffer);
  view.setUint16(0, dimensions ?? 0);
  view.setUint32(2, kept.size);
  let at = 6;
  for (const [revisionId, passages] of kept) {
    const id = ids.get(revisionId)!;
    view.setUint16(at, id.length);
    bytes.set(id, at + 2);
    at += 2 + id.length;
    view.setUint32(at, passages.length);
    at += 4;
    for (const { hash, start, vector } of passages) {
      const hashBytes = fromBase64(hash);
      if (hashBytes.length !== HASH_BYTES) throw new RangeError('A passage hash of another length');
      if (!Number.isInteger(start) || start < 0 || start > 0xffffffff) {
        throw new RangeError('A passage start out of range');
      }
      if (!Number.isFinite(vector.scale) || vector.scale < 0) {
        throw new RangeError('A vector scale out of range');
      }
      bytes.set(hashBytes, at);
      view.setUint32(at + HASH_BYTES, start);
      view.setFloat32(at + HASH_BYTES + 4, vector.scale);
      bytes.set(
        new Uint8Array(vector.values.buffer, vector.values.byteOffset, vector.values.length),
        at + HASH_BYTES + 8,
      );
      at += HASH_BYTES + 8 + vector.values.length;
    }
  }
  return bytes;
}

/** What `meaningBytes` wrote, or null if it isn't that, whole. */
export function readMeaningBytes(bytes: Uint8Array): KeptMeaning | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // One copy for every vector, so each is a view of it.
  const signed = new Int8Array(bytes.length);
  signed.set(bytes);
  const kept = new Map<RevisionId, MeaningPassage[]>();
  let at = 0;
  const has = (length: number) => at + length <= bytes.length;
  if (!has(6)) return null;
  const dimensions = view.getUint16(0);
  const versions = view.getUint32(2);
  at = 6;
  for (let version = 0; version < versions; version++) {
    if (!has(2)) return null;
    const idLength = view.getUint16(at);
    at += 2;
    if (!has(idLength + 4)) return null;
    let revisionId: RevisionId;
    try {
      const parsed = RevisionId.safeParse(
        decodeUtf8(bytes.subarray(at, at + idLength), 'revision ID'),
      );
      if (!parsed.success) return null;
      revisionId = parsed.data;
    } catch {
      return null;
    }
    if (kept.has(revisionId)) return null;
    at += idLength;
    const count = view.getUint32(at);
    at += 4;
    const each = HASH_BYTES + 8 + dimensions;
    if (!has(count * each)) return null;
    const passages: MeaningPassage[] = [];
    for (let passage = 0; passage < count; passage++) {
      const scale = view.getFloat32(at + HASH_BYTES + 4);
      if (!Number.isFinite(scale) || scale < 0) return null;
      passages.push({
        hash: toBase64(bytes.slice(at, at + HASH_BYTES)),
        start: view.getUint32(at + HASH_BYTES),
        vector: { scale, values: signed.subarray(at + HASH_BYTES + 8, at + each) },
      });
      at += each;
    }
    kept.set(revisionId, passages);
  }
  return at === bytes.length ? kept : null;
}
