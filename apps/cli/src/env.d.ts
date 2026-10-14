// Values the bundler writes into the CLI at build time (`vite.config.ts`).
interface ImportMeta {
  readonly env?: {
    /** "yes" only in the build the CLI's own tests run: see `requireTrustedTool`. */
    readonly WIKISTOW_TEST_TRUST_ANY_SECRET_TOOL?: string;
  };
}
