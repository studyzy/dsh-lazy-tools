/**
 * The shipped defer preset, in a module both halves of the plugin can load.
 *
 * These constants are consumed twice: the Host half enforces them when a
 * configuration names neither `defer` nor `noDefer`, and the browser half shows
 * them in the settings form for that same unconfigured state. Both need the
 * same values, so they live here rather than in `./config.ts`.
 *
 * That split is not cosmetic. `./config.ts` imports `RUN_CODE_NAME` from
 * `@deepseek-ai/dsh-tools` to build {@link GUARD_TOOLS}, and that is a
 * Host-only package: the browser's module table cannot resolve it, so a client
 * bundle that reached through `config.ts` would fail to load in the page. This
 * module deliberately imports nothing, which keeps the client's dependency
 * surface exactly the shell-provided externals.
 * @module @deepseek-ai/dsh-lazy-tools/preset
 */

/**
 * The defer entry a fresh install uses: defer everything the guards do not
 * protect.
 */
export const DEFER_ALL_ENTRY = 'Defer(*)'

/**
 * Tools a fresh install keeps directly callable. Everything else is deferred, so
 * the model starts with a working coding core and loads the long tail on demand
 * through `tool_search` — no configuration required.
 */
export const DEFAULT_ACTIVE_TOOLS = [
  'read',
  'write',
  'edit',
  'bash',
  'glob',
  'grep',
  'web_search',
  'web_fetch',
  'ask_user_question',
  'skill',
] as const

/** Resolved pattern pair after the shipped preset is applied. */
export interface DeferPatterns {
  /** Entries to defer. */
  readonly defer: readonly string[]
  /** Entries that must stay active. */
  readonly noDefer: readonly string[]
}

/**
 * Resolve the configured patterns, substituting the shipped preset when the
 * config names neither `defer` nor `noDefer`.
 *
 * A zero-config install must be useful out of the box: defer the long tail and
 * keep {@link DEFAULT_ACTIVE_TOOLS} callable. Naming either key replaces the
 * preset completely, so `defer: []` still means "defer nothing" and
 * `defer: ['glob']` still defers exactly `glob` (it is not re-protected by the
 * preset's core).
 *
 * This is the single source of that policy. The Host calls it on every request
 * to decide what to withhold; the settings form calls it to decide what to
 * display, so the shown value cannot drift from the enforced one.
 * @param config - the configured pair; an absent key stays `undefined`.
 * @returns the patterns to compile.
 */
export function resolveDeferPatterns(config: {
  defer?: readonly string[] | undefined
  noDefer?: readonly string[] | undefined
}): DeferPatterns {
  const unconfigured = config.defer === undefined && config.noDefer === undefined
  return {
    defer: unconfigured ? [DEFER_ALL_ENTRY] : (config.defer ?? []),
    noDefer: unconfigured ? [...DEFAULT_ACTIVE_TOOLS] : (config.noDefer ?? []),
  }
}