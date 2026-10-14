import { UNSAFE_TEXT } from '@wikistow/contracts';

/**
 * Encode a string the CLI didn't write (server text, decrypted content,
 * signed data, typed input) for a terminal. Each control, line-separator or
 * bidi code point becomes `\u{hex}`, and a backslash becomes `\\`, so escaped
 * and literal text never look alike. When the output isn't UTF-8, every code
 * point above U+007E is escaped too, so a byte of a UTF-8 sequence can't be
 * read as an 8-bit control. During enrollment, always pass `utf8: false`.
 *
 *   forTerminal(`${ESC}[2A`, { utf8: true }) // "\u{1b}[2A"
 */
export function forTerminal(text: string, { utf8 }: { utf8: boolean }): string {
  let out = '';
  for (const char of text) {
    const codePoint = char.codePointAt(0) ?? 0;
    if (char === '\\') out += '\\\\';
    else if (UNSAFE_TEXT.test(char) || (!utf8 && codePoint > 0x7e) || !char.isWellFormed()) {
      out += `\\u{${codePoint.toString(16)}}`;
    } else out += char;
  }
  return out;
}

/**
 * Whether the locale says output is UTF-8. On POSIX the first of `LC_ALL`,
 * `LC_CTYPE` and `LANG` that is set and not empty decides, by its codeset
 * compared case-insensitively with every `-` removed: `en_US.UTF-8`, `C.utf8`
 * and `C.UTF-8` all are. A value with no `.` is all codeset, as in macOS's
 * `LC_CTYPE=UTF-8`. Anything else, unset included, is not.
 */
export function isUtf8Locale(env: Readonly<Record<string, string | undefined>>): boolean {
  const locale = [env.LC_ALL, env.LC_CTYPE, env.LANG]
    .find((value) => value !== undefined && value !== '')
    ?.split('@')[0];
  const codeset = locale?.includes('.') ? locale.split('.')[1] : locale;
  return codeset?.toLowerCase().replaceAll('-', '') === 'utf8';
}

/**
 * `--json` output that holds only printable ASCII inside strings: every other
 * UTF-16 unit is a lowercase `\uXXXX` escape, so astral characters become a
 * surrogate pair. The only raw control character is the line feed between
 * members and at the end. `JSON.stringify` alone writes DEL, C1 controls,
 * U+2028, U+2029 and bidi controls raw. Otherwise it writes what
 * `JSON.stringify(value, null, 2)` would, `toJSON` included, and throws
 * where that would return `undefined`.
 */
export function toAsciiJson(value: unknown): string {
  const json = asciiJson(value, '', '');
  if (json === undefined) throw new TypeError(`Can't write ${typeof value} as JSON`);
  return `${json}\n`;
}

// As in JSON.stringify: `toJSON` gets the member's key, and a value with no
// JSON form (undefined, a function or a symbol) is `undefined` here, so it is
// left out of an object and written as null in an array.
function asciiJson(raw: unknown, key: string, indent: string): string | undefined {
  const value = hasToJson(raw) ? raw.toJSON(key) : raw;
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') {
    return undefined;
  }
  if (value === null || typeof value === 'boolean') return String(value);
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'null';
  if (typeof value === 'string') return asciiString(value);
  if (typeof value !== 'object') throw new TypeError(`Can't write ${typeof value} as JSON`);
  const inner = `${indent}  `;
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    // Array.from, not map, so holes are visited and written as null too.
    const items = Array.from(
      value,
      (item: unknown, index) => `${inner}${asciiJson(item, String(index), inner) ?? 'null'}`,
    );
    return `[\n${items.join(',\n')}\n${indent}]`;
  }
  const lines = Object.entries(value).flatMap(([name, member]) => {
    const json = asciiJson(member, name, inner);
    return json === undefined ? [] : [`${inner}${asciiString(name)}: ${json}`];
  });
  if (lines.length === 0) return '{}';
  return `{\n${lines.join(',\n')}\n${indent}}`;
}

const hasToJson = (value: unknown): value is { toJSON: (key: string) => unknown } =>
  typeof value === 'object' &&
  value !== null &&
  'toJSON' in value &&
  typeof value.toJSON === 'function';

function asciiString(text: string): string {
  let out = '"';
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit === 0x22) out += '\\"';
    else if (unit === 0x5c) out += '\\\\';
    else if (unit >= 0x20 && unit <= 0x7e) out += text[i];
    else out += `\\u${unit.toString(16).padStart(4, '0')}`;
  }
  return `${out}"`;
}
