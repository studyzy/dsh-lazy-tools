import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

/**
 * Test configuration for the plugin.
 *
 * The plugin resolves its state directory from the harness home, falling back
 * to `~/.dsh` exactly as DSH does. That fallback is correct in production but
 * dangerous under test: a case that forgets to inject `home` would read and
 * write the developer's real `~/.dsh`. The setup file below pins the home to a
 * throwaway directory for every suite, so a missed injection can only ever
 * pollute a temporary path.
 *
 * The browser half imports `@deepseek-ai/dsh-client-ui-primitives`, which is a
 * *runtime* module the shell seeds into the browser's module table — this package
 * deliberately does not depend on it (see `src/client/types/`). The alias below
 * teaches Vite the same resolution `tsconfig.json` already declares, so the page
 * can be imported and rendered under test without installing the browser stack.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@deepseek-ai/dsh-client-ui-primitives': fileURLToPath(
        new URL('./src/client/types/dsh-client-ui-primitives/index.d.ts', import.meta.url),
      ),
    },
  },
  test: {
    include: ['tests/**/*.spec.ts'],
    setupFiles: ['./tests/setup.ts'],
  },
})