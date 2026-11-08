import type { AiMessage } from '@wikistow/client';
import { aiRoutes } from '@wikistow/contracts';
import { z } from 'zod';

/*
 * What the workshop keeps with its plugin draft (#314), so it comes back
 * as it was left: the conversation, the numbered versions and the sample
 * pages, as plain JSON on the server like the draft's files. Copies of
 * the person's real pages are left out: their text is encrypted page
 * content. A turn that made one says only that it did. The SDK reference
 * the model reads is left out too: it is the app's own, and long.
 */

const Diagnostic = z.object({
  severity: z.enum(['error', 'warning']),
  file: z.string().nullable(),
  line: z.number().nullable(),
  column: z.number().nullable(),
  message: z.string(),
});

/**
 * A version as kept: its number, what its build said, and for one that
 * built its hash and its manifest's name and version. Its build isn't
 * kept; the newest one is built again from the draft's files.
 */
const KeptVersion = z.object({
  version: z.number().int().positive(),
  diagnostics: z.array(Diagnostic),
  hash: z.string().nullable(),
  plugin: z.object({ name: z.string(), version: z.string() }).nullable(),
});

const KeptSample = z.object({
  pageId: z.string(),
  title: z.string(),
  markdown: z.string(),
  data: z.json().nullable(),
});

export const KeptWorkshop = z.object({
  /** This shape's number, for a later app to tell it apart. */
  kept: z.literal(1),
  /** The conversation as the model is sent it. */
  messages: z.array(aiRoutes.AiMessage),
  /** Each message the person sent, as they wrote it, and whether they copied a page with it. */
  turns: z.array(z.object({ text: z.string(), copied: z.boolean() })),
  /** The model was told the draft is a copy of another plugin. */
  toldCopy: z.boolean(),
  versions: z.array(KeptVersion),
  samples: z.array(KeptSample),
  /** How many samples were made, kept or not, so none is numbered again. */
  made: z.number().int().nonnegative(),
});
export type KeptWorkshop = z.infer<typeof KeptWorkshop>;

/** Where a copy of a real page was, in the kept conversation. */
export const COPY_LEFT_OUT = 'A copy of one of the person’s pages was here. It isn’t kept.';
const REFERENCE_LEFT_OUT =
  'The SDK reference was here. It isn’t kept with the conversation: call sdk_reference again for it.';

const Report = z.looseObject({
  samples: z.array(z.looseObject({ pageId: z.string() })).optional(),
  preview: z.looseObject({ samples: z.array(z.looseObject({ pageId: z.string() })) }).optional(),
});

const parsed = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

/** A tool's answer without the copies (`copies`, by sample ID) its preview report shows. */
function withoutCopies(output: string, copies: ReadonlySet<string>): string {
  if (copies.size === 0) return output;
  const report = Report.safeParse(parsed(output));
  if (!report.success) return output;
  const scrub = (samples: { pageId: string }[]) =>
    samples.map((sample) =>
      copies.has(sample.pageId) ? { pageId: sample.pageId, left: COPY_LEFT_OUT } : sample,
    );
  const { samples, preview } = report.data;
  if (!samples && !preview) return output;
  return JSON.stringify({
    ...report.data,
    ...(samples ? { samples: scrub(samples) } : {}),
    ...(preview ? { preview: { ...preview, samples: scrub(preview.samples) } } : {}),
  });
}

const SampleInput = z.looseObject({ pageId: z.string() });

/**
 * `messages` as kept: each of the person's messages as `said` has it (in
 * order, without a copied page's title), and without what the copies
 * (`copies`, by sample ID) hold or the SDK reference's text.
 */
export function keptMessages(
  messages: readonly AiMessage[],
  said: readonly string[],
  copies: ReadonlySet<string>,
): AiMessage[] {
  const names = new Map<string, string>();
  let turn = 0;
  return messages.map((message): AiMessage => {
    switch (message.role) {
      case 'user':
        return { role: 'user', text: said[turn++] ?? message.text };
      case 'assistant':
        return {
          ...message,
          toolCalls: message.toolCalls.map((call) => {
            names.set(call.id, call.name);
            const sample = SampleInput.safeParse(call.input);
            // What it wrote over a copy may be the copy's text.
            return call.name === 'write_sample_page' &&
              sample.success &&
              copies.has(sample.data.pageId)
              ? { ...call, input: { pageId: sample.data.pageId, left: COPY_LEFT_OUT } }
              : call;
          }),
        };
      case 'tool':
        return {
          role: 'tool',
          results: message.results.map((result) => ({
            ...result,
            output:
              names.get(result.callId) === 'sdk_reference' && !result.isError
                ? REFERENCE_LEFT_OUT
                : withoutCopies(result.output, copies),
          })),
        };
    }
  });
}
