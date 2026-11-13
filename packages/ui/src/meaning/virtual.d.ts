/**
 * The model's files in this build (`apps/web/meaning.ts`): where the model
 * and its tokenizer are served, and the tokenizer's settings, which are
 * small enough to carry in the worker.
 */
declare module 'virtual:meaning-model' {
  export const files: { readonly model: string; readonly tokenizer: string };
  export const tokenizerConfig: Readonly<Record<string, unknown>>;
}
