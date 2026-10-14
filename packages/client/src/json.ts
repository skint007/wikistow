import { CryptoError } from './errors.ts';

export type JsonPath = readonly (string | number)[];

export type JsonDefect = {
  /** Where the defect is: the object holding a duplicate member, or the value itself. */
  path: JsonPath;
  problem:
    | 'duplicate-member'
    /** A string or member name holding a lone surrogate. */
    | 'ill-formed-string'
    /** A number whose raw token isn't a safe integer written as `0` or `-?[1-9][0-9]*`. */
    | 'number-token'
    | 'non-finite';
};

/**
 * Parse RFC 8259 JSON text the way `JSON.parse` would, but report what
 * `JSON.parse` hides: duplicate member names, ill-formed strings, and the raw
 * text of numbers (`1.0`, `1e3` and `-0` all parse as integers). Defects are
 * returned with their paths rather than thrown, so a caller can tell whose
 * part of a larger document is at fault; syntax errors throw `malformed`.
 *
 * Every member becomes an own data property, as with `JSON.parse`. A member
 * named `__proto__` is therefore an ordinary key, never a prototype change.
 *
 *   const { value, defects } = parseJsonText('{"a":1,"a":2}');
 *   // defects: [{ path: [], problem: 'duplicate-member' }]
 */
export function parseJsonText(text: string): { value: unknown; defects: JsonDefect[] } {
  const parser = new Parser(text);
  const value = parser.document();
  return { value, defects: parser.defects };
}

/**
 * `value` with every ill-formed string, member names included, made
 * well-formed: each lone surrogate becomes U+FFFD. Milestone 1 clients could
 * write such text, and readers still open it, but no writer seals it, so an
 * operation carrying it into a new version repairs it first. `repaired` says
 * whether anything changed, so the app can say a broken character was replaced.
 * Two member names that repair to the same name are refused as `malformed`
 * rather than merged, since either value could be the one meant.
 *
 *   repairText({ title: 'Cut off \ud83d' }); // { value: { title: 'Cut off \ufffd' }, repaired: true }
 */
export function repairText<T>(value: T): { value: T; repaired: boolean } {
  const repaired = wellFormed(value);
  // Only strings change, so the copy has the shape of `value`.
  return { value: repaired as T, repaired: repaired !== value };
}

// `value` itself when it is already well-formed, otherwise a copy that is.
function wellFormed(value: unknown): unknown {
  if (typeof value === 'string') return value.toWellFormed();
  if (Array.isArray(value)) {
    const items = value.map(wellFormed);
    return items.every((item, index) => Object.is(item, value[index])) ? value : items;
  }
  if (typeof value !== 'object' || value === null) return value;
  const original = Object.entries(value);
  const entries = original.map(([key, item]) => [key.toWellFormed(), wellFormed(item)] as const);
  const same = entries.every(
    ([key, item], index) => key === original[index]?.[0] && Object.is(item, original[index]?.[1]),
  );
  if (same) return value;
  if (new Set(entries.map(([key]) => key)).size !== entries.length) {
    throw new CryptoError('malformed', 'Two member names are the same once repaired');
  }
  // `fromEntries` defines each member, so one named `__proto__` stays a member.
  return Object.fromEntries(entries);
}

/**
 * A path pattern: `'*'` matches one segment, and a trailing `'**'` matches
 * the rest of the path, including nothing.
 */
export type JsonPathPattern = readonly string[];

export function matchesPath(path: JsonPath, pattern: JsonPathPattern): boolean {
  for (const [index, segment] of pattern.entries()) {
    if (segment === '**') return true;
    if (index >= path.length) return false;
    if (segment !== '*' && segment !== String(path[index])) return false;
  }
  return path.length === pattern.length;
}

// Deep enough for any document we write; deeper input would only exhaust the stack.
const MAX_DEPTH = 256;
const NUMBER = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
const INTEGER_TOKEN = /^(?:0|-?[1-9][0-9]*)$/;
const HEX4 = /^[0-9A-Fa-f]{4}$/;
const ESCAPES: Record<string, string> = {
  '"': '"',
  '\\': '\\',
  '/': '/',
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
};

class Parser {
  readonly defects: JsonDefect[] = [];
  #i = 0;
  readonly #text: string;

  constructor(text: string) {
    this.#text = text;
  }

  document(): unknown {
    const value = this.#value([], 0);
    this.#whitespace();
    if (this.#i !== this.#text.length) this.#fail('Unexpected text after the value');
    return value;
  }

  #fail(why: string): never {
    throw new CryptoError('malformed', `Invalid JSON at offset ${this.#i}: ${why}`);
  }

  #whitespace(): void {
    const text = this.#text;
    while (this.#i < text.length) {
      const c = text.charCodeAt(this.#i);
      if (c !== 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) return;
      this.#i++;
    }
  }

  #value(path: JsonPath, depth: number): unknown {
    if (depth > MAX_DEPTH) this.#fail('Nested too deeply');
    this.#whitespace();
    const text = this.#text;
    const c = text[this.#i];
    if (c === '{') return this.#object(path, depth);
    if (c === '[') return this.#array(path, depth);
    if (c === '"') {
      const value = this.#string();
      if (!value.isWellFormed()) this.defects.push({ path, problem: 'ill-formed-string' });
      return value;
    }
    for (const [word, value] of [
      ['true', true],
      ['false', false],
      ['null', null],
    ] as const) {
      if (text.startsWith(word, this.#i)) {
        this.#i += word.length;
        return value;
      }
    }
    return this.#number(path);
  }

  #object(path: JsonPath, depth: number): Record<string, unknown> {
    this.#i++;
    const out: Record<string, unknown> = {};
    const seen = new Set<string>();
    this.#whitespace();
    if (this.#text[this.#i] === '}') {
      this.#i++;
      return out;
    }
    for (;;) {
      this.#whitespace();
      if (this.#text[this.#i] !== '"') this.#fail('Expected a member name');
      const key = this.#string();
      if (!key.isWellFormed()) this.defects.push({ path, problem: 'ill-formed-string' });
      this.#whitespace();
      if (this.#text[this.#i] !== ':') this.#fail('Expected a colon');
      this.#i++;
      const value = this.#value([...path, key], depth + 1);
      if (seen.has(key)) this.defects.push({ path, problem: 'duplicate-member' });
      seen.add(key);
      // Never `out[key] = value`: for "__proto__" that would set the prototype.
      Object.defineProperty(out, key, {
        value,
        enumerable: true,
        writable: true,
        configurable: true,
      });
      this.#whitespace();
      const next = this.#text[this.#i++];
      if (next === '}') return out;
      if (next !== ',') this.#fail('Expected a comma or a closing brace');
    }
  }

  #array(path: JsonPath, depth: number): unknown[] {
    this.#i++;
    const out: unknown[] = [];
    this.#whitespace();
    if (this.#text[this.#i] === ']') {
      this.#i++;
      return out;
    }
    for (;;) {
      out.push(this.#value([...path, out.length], depth + 1));
      this.#whitespace();
      const next = this.#text[this.#i++];
      if (next === ']') return out;
      if (next !== ',') this.#fail('Expected a comma or a closing bracket');
    }
  }

  #string(): string {
    const text = this.#text;
    let out = '';
    let start = ++this.#i;
    for (;;) {
      if (this.#i >= text.length) this.#fail('Unterminated string');
      const c = text.charCodeAt(this.#i);
      if (c === 0x22) {
        out += text.slice(start, this.#i++);
        break;
      }
      if (c < 0x20) this.#fail('Raw control character in a string');
      if (c !== 0x5c) {
        this.#i++;
        continue;
      }
      out += text.slice(start, this.#i);
      const escape = text[this.#i + 1] ?? '';
      if (escape === 'u') {
        const hex = text.slice(this.#i + 2, this.#i + 6);
        if (!HEX4.test(hex)) this.#fail('Invalid unicode escape');
        out += String.fromCharCode(Number.parseInt(hex, 16));
        this.#i += 6;
      } else {
        const unescaped = ESCAPES[escape];
        if (unescaped === undefined) this.#fail('Invalid escape');
        out += unescaped;
        this.#i += 2;
      }
      start = this.#i;
    }
    return out;
  }

  #number(path: JsonPath): number {
    NUMBER.lastIndex = this.#i;
    const token = NUMBER.exec(this.#text)?.[0];
    if (token === undefined) this.#fail('Expected a value');
    this.#i += token.length;
    const value = Number(token);
    if (!Number.isFinite(value)) this.defects.push({ path, problem: 'non-finite' });
    else if (!INTEGER_TOKEN.test(token) || !Number.isSafeInteger(value)) {
      this.defects.push({ path, problem: 'number-token' });
    }
    return value;
  }
}
