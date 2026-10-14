import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';

// What the visual editor marks its copies with. This module loads with the
// page editor, before the visual editor, so it doesn't bring Milkdown.
//
// Each node copied carries this tab's token (`COPIED`), as pasted HTML
// keeps its data attributes, which say what's a wikilink, image or
// footnote, only if this tab copied it (`unstyled`).
//
// Another of this browser's WikiStow tabs can't vouch for that HTML, so it
// reads a copy's text instead, if that's Markdown. The editor copies its
// text as Markdown only for some selections: one starting inside a list
// item, quote or cell, for one, or a code block's contents, goes as plain
// text. So when it does, a copy or a drag says so with a mark under a type
// of its own (`MARKDOWN_MARK`). The mark is a random nonce and the HMAC of
// it and the text, under a key this browser's WikiStow tabs share in
// localStorage, which no other site can read, and which never goes on the
// clipboard.
// A page that sees a copy, as one pasted into it does, learns the mark of
// that text alone. It can put that text and mark beside HTML of its own,
// so the paste reads as that text, which it could write alone anyway, as
// text alone is read as Markdown from anywhere. It can't mark other text.
// The nonce makes each copy's mark its own, so two copies of the same text
// don't show they came from the same browser.

/** This tab's token, which another page learns only from a copy or drag of this tab's put into it. */
export const TAB = Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) =>
  b.toString(16).padStart(2, '0'),
).join('');

// Whether HTML on the clipboard has a node this tab copied, as it writes them (`COPIED`).
const copiedHereIn = (html: string) => html.includes(`data-copied="${TAB}"`);

/** The clipboard type a copy's mark goes under. */
export const MARKDOWN_MARK = 'application/x-wikistow-markdown';

const KEY = 'wikistow.copy-key';
const HEX = /^[0-9a-f]{64}$/;

// This browser's key for marking copies, made if `make` and there's none;
// null if there's none, or storage can't be used.
function keyOf(make: boolean): Uint8Array | null {
  try {
    let key = localStorage.getItem(KEY);
    if (!(key !== null && HEX.test(key)) && make) {
      key = bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
      localStorage.setItem(KEY, key);
    }
    return key !== null && HEX.test(key) ? hexToBytes(key) : null;
  } catch {
    return null;
  }
}

// A mark: a 16-byte nonce, then a 32-byte HMAC, in hex.
const MARK = /^([0-9a-f]{32})([0-9a-f]{64})$/;

// `text`'s HMAC under `key` with `nonce`, its line breaks as LF, as a
// clipboard may give them back as CRLF.
const hmacOf = (key: Uint8Array, nonce: string, text: string) =>
  bytesToHex(
    hmac(sha256, key, concatBytes(hexToBytes(nonce), utf8ToBytes(text.replace(/\r\n?/g, '\n')))),
  );

/** The mark saying `text` is Markdown this editor copied, or null if it can't make one. */
export function markOf(text: string): string | null {
  const key = keyOf(true);
  const nonce = bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
  return key && `${nonce}${hmacOf(key, nonce, text)}`;
}

// Whether `mark` says `text` is Markdown one of this browser's WikiStow tabs copied.
function markedMarkdown(text: string, mark: string): boolean {
  const key = keyOf(false);
  const [, nonce, given] = MARK.exec(mark) ?? [];
  if (!key || nonce === undefined || given === undefined) return false;
  const expected = hmacOf(key, nonce, text);
  // Compared in full, so how long it takes says nothing of the mark.
  let differs = 0;
  for (let i = 0; i < expected.length; i++) differs |= expected.charCodeAt(i) ^ given.charCodeAt(i);
  return differs === 0;
}

/**
 * Whether `data`, pasted or dropped, is rich text another of this
 * browser's WikiStow tabs copied or dragged, its text Markdown, as its mark
 * says. This tab's own copies aren't, as all their HTML is kept.
 */
export function fromAnotherTab(data: Pick<DataTransfer, 'getData'>): boolean {
  const html = data.getData('text/html');
  return (
    html !== '' &&
    !copiedHereIn(html) &&
    markedMarkdown(data.getData('text/plain'), data.getData(MARKDOWN_MARK))
  );
}
