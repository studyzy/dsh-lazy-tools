import { defineConfig } from 'tsdown'

/**
 * Build configuration for both halves of the plugin.
 *
 * The package is a **dual-face** DSH plugin: a Host (Node) half that installs the
 * lazy surface, and a browser half that renders the settings page. They are built
 * as two separate artifacts because they run in different worlds and are loaded
 * by different mechanisms:
 *
 * - `lib/index.js` — the package root, loaded by the cordis Loader in Node. ESM,
 *   platform `node`, with the `@deepseek-ai/*` Host packages left external so the
 *   running harness supplies its own copies.
 * - `lib/client.js` — the browser half, loaded by `dsh-client-modules` from the
 *   `dsh.client` declaration in `package.json`. It must be CJS-shaped and wrapped
 *   in `window.__ModuleLoader__.load({ id, factory })`, because the browser
 *   kernel materializes factories rather than executing ESM. Every module it
 *   `require`s is resolved against the shell's frozen module table, so all of them
 *   — React, the primitives, the client services — must stay external instead of
 *   being bundled in.
 *
 * The `client` output is hand-wrapped rather than produced by a DSH-internal
 * build preset, because those presets are not published with the harness. The
 * wrapper is small and its contract is stable: register one factory under the
 * package name, and let `require` resolve the externals.
 */
const CLIENT_ID = '@studyzy/dsh-lazy-tools'

/** Modules the browser kernel provides; none may be bundled into the client half. */
const CLIENT_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-primitives',
]

export default defineConfig([
  {
    entry: ['lib/types/index.js'],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
  },
  {
    entry: { client: 'lib/types/client/index.js' },
    outDir: 'lib',
    format: ['cjs'],
    platform: 'browser',
    target: 'es2022',
    dts: false,
    clean: false,
    deps: { neverBundle: CLIENT_EXTERNALS },
    outputOptions: {
      // The browser kernel does not execute ESM; it reads a factory off the
      // module-loader registry and calls it. The banner/footer below supply that
      // registry shape around the bundled module body.
      format: 'cjs',
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(CLIENT_ID)}, factory: (require) => { var module = { exports: {} }; var exports = module.exports;`,
      footer: 'return module.exports; } });',
    },
  },
])