import { z } from 'zod';
import type { PageRef, PluginErrorCode, PluginEvent } from './host.ts';

/*
 * The messages between a script's worker and the host. The host checks
 * every message a worker sends against these schemas, and each call's
 * arguments against its method's, before doing anything with them.
 * Arguments drop keys they don't name, so a whole page version passes as
 * its reference.
 */

const Id = z.string().min(1).max(100);
const Json = z.json();
const PageRef = z.object({ spaceId: Id, pageId: Id });
const FolderRef = z.object({ spaceId: Id, folderId: Id.nullable() });
const NodeRef = z.object({ spaceId: Id, id: Id });
const Title = z.string().max(1000);
// The page's own limit is checked when it is saved; this only bounds a message.
const Markdown = z.string().max(1024 * 1024);
const Change = { title: Title.optional(), markdown: Markdown.optional(), data: Json.optional() };

/** Each method a worker can call, with its arguments. */
export const METHODS = {
  'pages.read': z.tuple([PageRef]),
  'pages.list': z.tuple([FolderRef]),
  'pages.search': z.tuple([
    z.string().max(1000),
    z.object({ limit: z.number().int().min(1).max(200).optional() }).optional(),
  ]),
  'pages.create': z.tuple([
    FolderRef,
    z.object({ title: Title, markdown: Markdown.optional(), data: Json.optional() }),
  ]),
  'pages.createFolder': z.tuple([FolderRef, z.string().min(1).max(1000)]),
  'pages.saveDraft': z.tuple([PageRef, z.object({ ...Change, base: Id })]),
  'pages.move': z.tuple([NodeRef, FolderRef]),
  /** The page handle of the invocation named in the call. */
  'page.read': z.tuple([]),
  'page.edit': z.tuple([z.object(Change)]),
} as const;
export type Method = keyof typeof METHODS;
const MethodName = z.custom<Method>(
  (value) => typeof value === 'string' && Object.hasOwn(METHODS, value),
);

const EventName = z.enum(['page.shown', 'draft.saved']);

// A script's blocks (#260): what it declares, and what its outputs answer.
const BlockType = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/);
const FieldId = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,39}$/);
const Label = z.string().min(1).max(100);
const Value = z.union([z.number(), z.string().max(1000)]);
/**
 * A page property's name, by the template-variable rule the app's
 * references follow (`isPropertyName` in the client, which a test holds
 * this to): a letter or digit, then letters, combining marks, digits,
 * spaces, `_` and `-`.
 */
export const PROPERTY_NAME = /^[\p{L}\p{N}][\p{L}\p{M}\p{N} _-]*$/u;
const PropertyName = z.string().max(100).regex(PROPERTY_NAME);

/** A field a block declares, as the host draws it. */
export const BlockField = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('number'),
    label: Label,
    default: z.number().optional(),
    min: z.number().optional(),
    max: z.number().optional(),
    property: PropertyName.optional(),
  }),
  z.strictObject({
    type: z.literal('text'),
    label: Label,
    default: z.string().max(1000).optional(),
    property: PropertyName.optional(),
  }),
]);

/** A block a script declares: its fields and outputs, without the code. */
export const BlockSpec = z
  .strictObject({
    type: BlockType,
    fields: z.record(FieldId, BlockField),
    outputs: z.record(FieldId, z.strictObject({ label: Label })),
  })
  .refine(
    ({ fields, outputs }) =>
      Object.keys(fields).length + Object.keys(outputs).length <= 50 &&
      !Object.keys(outputs).some((id) => Object.hasOwn(fields, id)),
    'At most 50 fields and outputs, with IDs of their own',
  );
export type BlockSpec = z.infer<typeof BlockSpec>;

/** An output's answer, or why there is none. */
export const OutputResult = z.union([
  z.strictObject({ value: Value }),
  z.strictObject({ error: z.string().max(2000) }),
]);
export type OutputResult = z.infer<typeof OutputResult>;

/** What a worker may send. */
export const WorkerMessage = z.discriminatedUnion('type', [
  /** Its activation finished. */
  z.strictObject({ type: z.literal('ready') }),
  /** Its activation threw. */
  z.strictObject({ type: z.literal('failed'), message: z.string().max(2000) }),
  z.strictObject({
    type: z.literal('register'),
    command: z.strictObject({ id: Id, title: Title }),
  }),
  z.strictObject({ type: z.literal('unregister'), command: Id }),
  z.strictObject({ type: z.literal('block'), block: BlockSpec }),
  z.strictObject({ type: z.literal('unblock'), block: BlockType }),
  z.strictObject({ type: z.literal('listen'), event: EventName, on: z.boolean() }),
  z.strictObject({
    type: z.literal('call'),
    call: z.number().int().nonnegative(),
    method: MethodName,
    args: z.array(z.unknown()).max(4),
    /** The command run whose page handle this is, for `page.*`. */
    invocation: z.number().int().nonnegative().optional(),
  }),
  z.strictObject({
    type: z.literal('done'),
    invocation: z.number().int().nonnegative(),
    error: z.string().max(2000).optional(),
    /** A calculation's answers, by output. */
    outputs: z.record(FieldId, OutputResult).optional(),
  }),
]);
export type WorkerMessage = z.infer<typeof WorkerMessage>;

/** What the host sends a worker. Made by the host, so not checked there. */
export type HostMessage =
  | {
      type: 'invoke';
      invocation: number;
      target:
        | { kind: 'command'; id: string; page: PageRef; editable: boolean }
        | ({ kind: 'event' } & PluginEvent)
        /** A block's outputs, from its valid fields' values (the rest are left out). */
        | {
            kind: 'calculate';
            block: string;
            page: PageRef;
            values: Record<string, number | string>;
          };
    }
  | { type: 'answer'; call: number; ok: true; value: unknown }
  | { type: 'answer'; call: number; ok: false; code: PluginErrorCode; message: string };
