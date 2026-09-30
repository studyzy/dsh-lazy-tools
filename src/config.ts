/**
 * CodeBuddy-style defer semantics for DeepSeek Harness, adapted from pi-lazy-tools.
 *
 * The plugin reads its `defer` / `noDefer` / `deferToolLoading` from the cordis
 * plugin config (see `Config` in ./index.ts), which schemastery validates. This
 * module compiles those entries into concrete deferred/active name sets given
 * the current set of registered global tool names.
 *
 * Semantics (highest precedence first): `noDefer` > `defer` > `deferToolLoading`.
 * `*` is the only wildcard and matches any character sequence; `Defer(*)`
 * defers everything except the guards. A config that names neither `defer` nor
 * `noDefer` gets the shipped preset (defer everything, keep
 * {@link DEFAULT_ACTIVE_TOOLS} callable) via {@link applyDefaultPreset}.
 * @module @deepseek-ai/dsh-lazy-tools/config
 */

import { RUN_CODE_NAME } from '@deepseek-ai/dsh-tools'

/**
 * Tools that must never be deferred: the search/execute pair would self-lock,
 * and the reserved presentation transport is not a capability the model may be
 * locked out of (a PTC-mode agent whose only tool was hidden would see nothing).
 */
export const GUARD_TOOLS = ['tool_search', 'defer_execute_tool', RUN_CODE_NAME] as const

/** Resolved plugin config surface after schemastery validation. */
export interface LazyToolsConfig {
  /** Tool names / `Defer(pattern)` entries to defer. Bare names = `Defer(name)`. */
  readonly defer?: readonly string[]
  /** Tool names / `NoDefer(pattern)` entries that must stay active. */
  readonly noDefer?: readonly string[]
  /** Global switch; false disables all deferring. Default true. */
  readonly deferToolLoading?: boolean
}

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

/**
 * Resolve the configured patterns, applying the shipped preset when the config
 * names neither `defer` nor `noDefer`.
 *
 * A zero-config install must be useful out of the box: defer the long tail and
 * keep {@link DEFAULT_ACTIVE_TOOLS} callable. Naming either key replaces the
 * preset completely, so the established semantics hold — `defer: []` still means
 * "defer nothing", and `defer: ['glob']` still defers exactly `glob` (it is not
 * re-protected by the preset).
 * @param config - plugin config; an absent key stays `undefined`.
 * @returns the patterns to compile.
 */
export function applyDefaultPreset(config: LazyToolsConfig): LazyToolsConfig {
  const unconfigured = config.defer === undefined && config.noDefer === undefined
  return {
    defer: unconfigured ? [DEFER_ALL_ENTRY] : (config.defer ?? []),
    noDefer: unconfigured ? [...DEFAULT_ACTIVE_TOOLS] : (config.noDefer ?? []),
    deferToolLoading: config.deferToolLoading ?? true,
  }
}

/** Outcome of compiling one config entry. */
export type DeferAction = 'defer' | 'noDefer'

export interface ParsedEntry {
  readonly action: DeferAction
  readonly pattern: string
}

/**
 * Parse one config entry: `"X"`, `"Defer(X)"`, or `"NoDefer(X)"`. Returns null
 * when the entry is blank, an empty modifier, or a nested modifier.
 *
 * A bare name carries no action of its own; it takes `defaultAction`, so a bare
 * name in the `defer` list defers and a bare name in the `noDefer` list keeps
 * the tool active (CodeBuddy overlay semantics).
 * @param entry - raw config string.
 * @param defaultAction - action a bare name inherits from its enclosing list.
 * @returns the parsed entry, or null for invalid input.
 */
export function parseEntry(entry: string, defaultAction: DeferAction = 'defer'): ParsedEntry | null {
  const trimmed = entry.trim()
  if (!trimmed) return null
  // Reject empty-modifier forms like "Defer()" / "NoDefer()" rather than
  // treating them as literal tool-name patterns.
  if (/^(?:Defer|NoDefer)\(\s*\)$/i.test(trimmed)) return null
  const deferMatch = /^Defer\((.+)\)$/i.exec(trimmed)
  if (deferMatch) {
    const inner = deferMatch[1].trim()
    if (!inner || /^[Nn]oDefer\(/i.test(inner)) return null // reject nested/empty
    return { action: 'defer', pattern: inner }
  }
  const noDeferMatch = /^NoDefer\((.+)\)$/i.exec(trimmed)
  if (noDeferMatch) {
    const inner = noDeferMatch[1].trim()
    if (!inner || /^Defer\(/i.test(inner)) return null
    return { action: 'noDefer', pattern: inner }
  }
  // Bare name => inherit the enclosing list's intent.
  return { action: defaultAction, pattern: trimmed }
}

/** Compile a glob-ish pattern (only `*` supported) into a matcher. */
export function compilePattern(pattern: string): (name: string) => boolean {
  if (pattern === '*') return () => true
  if (!pattern.includes('*')) return (name) => name === pattern
  const regex = new RegExp(
    `^${pattern
      .split('*')
      .map((part) => part.replace(/[.+^${}()|[\]\\]/g, '\\$&'))
      .join('.*')}$`,
  )
  return (name) => regex.test(name)
}

export interface ResolvedDeferConfig {
  /** Tool names that should be deferred. */
  readonly deferNames: ReadonlySet<string>
  /** Tool names that must stay active. */
  readonly noDeferNames: ReadonlySet<string>
  /** Whether deferring is enabled at all. */
  readonly enabled: boolean
}

/**
 * Resolve plugin config into deferred/active name sets against the currently
 * registered global tool names.
 * @param allToolNames - every callable tool name visible in the global registry.
 * @param config - validated plugin config.
 * @returns the resolved name sets and whether deferring is enabled.
 */
export function resolveDeferConfig(
  allToolNames: readonly string[],
  config: LazyToolsConfig,
): ResolvedDeferConfig {
  const deferToolLoading = config.deferToolLoading ?? true
  if (!deferToolLoading) {
    return { deferNames: new Set(), noDeferNames: new Set(), enabled: false }
  }

  const deferMatchers = (config.defer ?? [])
    .map((entry) => parseEntry(entry, 'defer'))
    .filter((entry): entry is ParsedEntry => entry !== null)
  const noDeferMatchers = (config.noDefer ?? [])
    .map((entry) => parseEntry(entry, 'noDefer'))
    .filter((entry): entry is ParsedEntry => entry !== null)

  const noDeferNames = new Set<string>()
  for (const name of allToolNames) {
    for (const matcher of noDeferMatchers) {
      if (matcher.action === 'noDefer' && compilePattern(matcher.pattern)(name)) noDeferNames.add(name)
    }
  }

  const deferNames = new Set<string>()
  for (const name of allToolNames) {
    if (noDeferNames.has(name) || (GUARD_TOOLS as readonly string[]).includes(name)) continue
    for (const matcher of deferMatchers) {
      if (matcher.action === 'defer' && compilePattern(matcher.pattern)(name)) {
        deferNames.add(name)
        break
      }
    }
  }

  return { deferNames, noDeferNames, enabled: true }
}
