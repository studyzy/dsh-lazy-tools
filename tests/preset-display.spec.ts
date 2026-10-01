/**
 * Tests that an unconfigured install shows the shipped preset in its form.
 *
 * The settings plane does not show a field whose projected value is
 * `undefined`: `projectForm` in `@deepseek-ai/dsh-settings` drops those keys
 * outright when it builds the settings document. This plugin deliberately keeps
 * `defer` / `noDefer` undefined while they are unconfigured, so both boxes
 * rendered empty while the Host was in fact deferring the long tail — the form
 * claimed "defer nothing" about a deployment doing the opposite (#186).
 *
 * The preset therefore cannot be a *schema* default: the Loader injects a schema
 * default into every resolved configuration, not just an empty one, so
 * `defer: ['glob']` would silently also gain the preset's `noDefer` core and
 * protect `glob` instead of deferring it — breaking "naming a key replaces the
 * preset". The tests below pin both halves of that trade-off:
 *
 * 1. The schema itself must NOT carry the preset (or the semantics above break).
 * 2. The form must still display the preset, and must display exactly what the
 *    Host enforces, so the shown and enforced values cannot drift apart.
 */
import { describe, expect, it } from 'vitest'
import { Config } from '../src/index.ts'
import { applyDefaultPreset } from '../src/config.ts'
import { DEFAULT_ACTIVE_TOOLS, DEFER_ALL_ENTRY, resolveDeferPatterns } from '../src/preset.ts'
import { LazyToolsController } from '../src/client/controller.ts'
import type { ConfigForm } from '../src/client/contracts.ts'

/** The schema node tree, as the settings plane's projection walks it. */
interface SchemaNode {
  meta?: { default?: unknown; volatile?: boolean }
  dict?: Record<string, SchemaNode>
}

const SCHEMA = Config as unknown as SchemaNode

/** Every field name the schema declares. */
const FIELD_NAMES = Object.keys(SCHEMA.dict ?? {})

/**
 * Project a value through a schema exactly as `@deepseek-ai/dsh-settings` does.
 * @param schema - the form schema node.
 * @param value - the plain config value.
 * @returns the fields the settings document would carry.
 */
function projectForm(schema: SchemaNode, value: unknown): Record<string, unknown> {
  if (schema.dict === undefined || value === null || typeof value !== 'object') return {}
  const out: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(schema.dict)) {
    const field = (value as Record<string, unknown>)[key]
    if (field !== undefined) out[key] = projectForm(child, field)
  }
  return out
}

/**
 * Build a controller over a fixed namespace value.
 * @param value - the resolved configuration the form reads.
 * @returns the form face the page renders.
 */
function controllerFor(value: Record<string, unknown>): {
  read: (field: string) => { text: string; overridden: boolean } | undefined
  dispose: () => void
} {
  const form = {
    getSnapshot: () => ({ status: 'ready', writable: true, revision: 1, value, base: {}, user: {} }),
    subscribe: () => () => {},
    mutate: async () => true,
  } as unknown as ConfigForm
  const page = new LazyToolsController(form)
  const store = page.inject().hooks.lazyTools
  return {
    read: (field) => store.getSnapshot()[field as 'defer'],
    dispose: () => { page.dispose() },
  }
}

describe('config schema', () => {
  it('declares exactly the fields the settings page edits', () => {
    // `deferToolLoading` was removed as redundant: `defer: []` already expresses
    // "defer nothing", so a second switch could only ever contradict the list.
    expect([...FIELD_NAMES].sort()).toEqual([
      'autoTune',
      'autoTuneMinSamples',
      'autoTuneTopN',
      'autoTuneWindowDays',
      'defer',
      'noDefer',
    ])
  })

  it('leaves the pattern pair undefaulted, so naming a key still replaces the preset', () => {
    // The counterweight to the display fix: a preset written here would be
    // injected into every configuration the Loader resolves, so an operator
    // writing `defer: ['glob']` would also silently inherit the preset's
    // `noDefer` core — and `glob` would be protected rather than deferred.
    expect(SCHEMA.dict?.defer.meta?.default).toBeUndefined()
    expect(SCHEMA.dict?.noDefer.meta?.default).toBeUndefined()
  })

  it('still defaults the fields whose default is a value, not a policy', () => {
    for (const name of ['autoTune', 'autoTuneWindowDays', 'autoTuneTopN', 'autoTuneMinSamples']) {
      expect(SCHEMA.dict?.[name].meta?.default, `field "${name}" needs a default`).not.toBeUndefined()
    }
  })
})

describe('unconfigured form display', () => {
  it('would drop an undefaulted field from the raw projection', () => {
    // Documents why the display layer has to do this at all: the Host projects
    // `{}` for an unconfigured namespace, so the page is what supplies the text.
    const projected = projectForm(SCHEMA, { autoTune: true })
    expect(projected).not.toHaveProperty('defer')
    expect(projected).not.toHaveProperty('noDefer')
  })

  it('shows the shipped preset rather than empty boxes', () => {
    const c = controllerFor({})
    expect(c.read('defer')?.text).toBe(DEFER_ALL_ENTRY)
    expect(c.read('noDefer')?.text).toBe(DEFAULT_ACTIVE_TOOLS.join(', '))
    c.dispose()
  })

  it('does not mark a preset as a user override', () => {
    // A schema/composition default is not something the user chose, so the
    // "Overridden" badge and its reset must stay off.
    const c = controllerFor({})
    expect(c.read('defer')?.overridden).toBe(false)
    expect(c.read('noDefer')?.overridden).toBe(false)
    c.dispose()
  })

  it('shows an explicit empty list as empty, not as the preset', () => {
    // `defer: []` means "defer nothing" and must read that way; substituting the
    // preset here would show `Defer(*)` for a deployment deferring nothing.
    const c = controllerFor({ defer: [], noDefer: [] })
    expect(c.read('defer')?.text).toBe('')
    expect(c.read('noDefer')?.text).toBe('')
    c.dispose()
  })

  it('shows an explicit config as written, without re-adding the preset core', () => {
    const c = controllerFor({ defer: ['glob'] })
    expect(c.read('defer')?.text).toBe('glob')
    expect(c.read('noDefer')?.text).toBe('')
    c.dispose()
  })
})

describe('displayed and enforced presets cannot drift', () => {
  it('resolves the same patterns the Host enforces', () => {
    // The form reads the preset through the client's own resolution; the request
    // path reads it through `applyDefaultPreset`. Both must be the same policy.
    const displayed = resolveDeferPatterns({})
    const enforced = applyDefaultPreset({})
    expect(displayed.defer).toEqual(enforced.defer)
    expect(displayed.noDefer).toEqual(enforced.noDefer)
  })

  it('keeps naming either key equal to replacing the preset on both sides', () => {
    for (const config of [{ defer: ['glob'] }, { noDefer: ['bash'] }, { defer: [] }, {}]) {
      const displayed = resolveDeferPatterns(config)
      const enforced = applyDefaultPreset(config)
      expect(displayed.defer).toEqual(enforced.defer)
      expect(displayed.noDefer).toEqual(enforced.noDefer)
    }
  })
})