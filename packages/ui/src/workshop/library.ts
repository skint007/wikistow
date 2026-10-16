// What a workshop build may import (#257): the plugin SDK and React, as
// this app carries them. The web build's `vite.config.ts` reads these files
// into the build worker as `virtual:workshop-library`; no other import
// resolves, so a build fetches nothing and installs nothing.

/** The packages plugin code may import, and the library file that answers each. */
export const OFFERED = {
  '@wikistow/plugin-sdk': 'plugin-sdk/index.ts',
  '@wikistow/plugin-sdk/react': 'plugin-sdk/react.tsx',
  react: 'react/react.production.js',
  'react/jsx-runtime': 'react/react-jsx-runtime.production.js',
  'react-dom/client': 'react-dom/react-dom-client.production.js',
};

/** Every package import that resolves: those offered, and what React's own files import. */
export const IMPORTS: Readonly<Record<string, string>> = {
  ...OFFERED,
  'react-dom': 'react-dom/react-dom.production.js',
  scheduler: 'scheduler/scheduler.production.js',
};

/** React's production builds the library holds: each package's files, from its `cjs/` folder. */
export const REACT_FILES = {
  react: ['react.production.js', 'react-jsx-runtime.production.js'],
  'react-dom': ['react-dom.production.js', 'react-dom-client.production.js'],
  scheduler: ['scheduler.production.js'],
} as const;
