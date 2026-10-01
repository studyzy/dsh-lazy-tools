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
 */
export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts'],
    setupFiles: ['./tests/setup.ts'],
  },
})