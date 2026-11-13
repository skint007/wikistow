// Yjs v1 updates written by hand, byte by byte, for what Yjs itself would
// never write: GC and skip structs, other content, parents by ID, and the
// other forms a receiver must refuse (protocol section 5.10, **`update`**).
const encoder = new TextEncoder();

export const varuint = (value: number): number[] => {
  const out: number[] = [];
  let rest = value;
  while (rest > 0x7f) {
    out.push(0x80 | (rest % 128));
    rest = Math.floor(rest / 128);
  }
  out.push(rest);
  return out;
};

export const string = (text: string): number[] => {
  const bytes = encoder.encode(text);
  return [...varuint(bytes.length), ...bytes];
};

type Id = { client: number; clock: number };
const id = ({ client, clock }: Id) => [...varuint(client), ...varuint(clock)];

/** One struct, as `Item.write` writes it, or a raw one. */
export type Struct =
  | {
      origin?: Id;
      rightOrigin?: Id;
      /** A root by name, or a parent by ID (`{ id }`), when there is no origin. */
      parent?: string | { id: Id };
      parentSub?: string;
      /** Set the parent-key flag without writing a key, as Yjs does with an origin. */
      flagParentSub?: boolean;
      content:
        | { string: string }
        | { deleted: number }
        | { any: (string | number)[] }
        | { raw: number; bytes: number[] };
    }
  | { gc: number }
  | { skip: number };

function struct(s: Struct): number[] {
  if ('gc' in s) return [0, ...varuint(s.gc)];
  if ('skip' in s) return [10, ...varuint(s.skip)];
  const c = s.content;
  const ref = 'string' in c ? 4 : 'deleted' in c ? 1 : 'any' in c ? 8 : c.raw;
  const info =
    ref |
    (s.origin ? 0x80 : 0) |
    (s.rightOrigin ? 0x40 : 0) |
    (s.parentSub !== undefined || s.flagParentSub ? 0x20 : 0);
  const out = [info];
  if (s.origin) out.push(...id(s.origin));
  if (s.rightOrigin) out.push(...id(s.rightOrigin));
  if (!s.origin && !s.rightOrigin) {
    const parent = s.parent ?? 'body';
    if (typeof parent === 'string') out.push(1, ...string(parent));
    else out.push(0, ...id(parent.id));
    if (s.parentSub !== undefined) out.push(...string(s.parentSub));
  }
  if ('string' in c) out.push(...string(c.string));
  else if ('deleted' in c) out.push(...varuint(c.deleted));
  else if ('any' in c) {
    out.push(...varuint(c.any.length));
    for (const value of c.any) {
      if (typeof value === 'string') out.push(119, ...string(value));
      else out.push(125, value);
    }
  } else out.push(...c.bytes);
  return out;
}

/** An update: struct sections by client from a clock, then a delete set. */
export function update({
  sections = [],
  deletes = [],
}: {
  sections?: { client: number; clock: number; structs: Struct[] }[];
  deletes?: { client: number; ranges: [number, number][] }[];
}): Uint8Array {
  const out = [...varuint(sections.length)];
  for (const section of sections) {
    out.push(
      ...varuint(section.structs.length),
      ...varuint(section.client),
      ...varuint(section.clock),
    );
    for (const s of section.structs) out.push(...struct(s));
  }
  out.push(...varuint(deletes.length));
  for (const { client, ranges } of deletes) {
    out.push(...varuint(client), ...varuint(ranges.length));
    for (const [clock, length] of ranges) out.push(...varuint(clock), ...varuint(length));
  }
  return new Uint8Array(out);
}

/** A state: a delete set, then a state vector. */
export function state({
  deletes = [],
  vector = [],
}: {
  deletes?: { client: number; ranges: [number, number][] }[];
  vector?: [number, number][];
}): Uint8Array {
  const out = [...varuint(deletes.length)];
  for (const { client, ranges } of deletes) {
    out.push(...varuint(client), ...varuint(ranges.length));
    for (const [clock, length] of ranges) out.push(...varuint(clock), ...varuint(length));
  }
  out.push(...varuint(vector.length));
  for (const [client, clock] of vector) out.push(...varuint(client), ...varuint(clock));
  return new Uint8Array(out);
}
