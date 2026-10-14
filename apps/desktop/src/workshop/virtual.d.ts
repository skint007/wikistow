/** The plugin SDK's sources and React's production builds, by library path (`library.ts`). */
declare module 'virtual:workshop-library' {
  const files: Readonly<Record<string, string>>;
  export default files;
}
