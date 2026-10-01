/**
 * Tests for the built browser bundle.
 *
 * The settings page only reaches users if `lib/client.js` satisfies the browser
 * kernel's contract, and that contract is easy to break silently: the bundle is
 * built and consumed by DSH machinery this package does not own, so a wrong
 * wrapper or a bundled-in external would fail at page load in the browser rather
 * than at build time. These tests load the real artifact through a stand-in
 * `window.__ModuleLoader__` and drive `apply`, which is what turns a build
 * mistake into a test failure.
 *
 * The suite is skipped when the bundle has not been built, so `vitest` stays
 * usable on a fresh checkout; `pnpm run build` is what makes it run.
 */
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const bundlePath = join(packageRoot, 'lib/client.js')
const packageName = '@deepseek-ai/dsh-lazy-tools'
const PRIMITIVES = '@deepseek-ai/dsh-client-ui-primitives'

/** The bundle's exported face, as the kernel materializes it. */
interface ClientFace {
  apply(ctx: unknown): void
  inject: readonly string[]
  locales: Record<string, Record<string, string>>
  LAZY_TOOLS_NS: string
}

/** Load the built bundle the way a browser `<script>` would. */
function loadBundle(): ClientFace {
  const registry = new Map<string, (require: (spec: string) => unknown) => ClientFace>()
  const globals = globalThis as unknown as { window?: unknown }
  globals.window = {
    __ModuleLoader__: {
      load(registration: { id: string; factory: (require: (spec: string) => unknown) => ClientFace }) {
        registry.set(registration.id, registration.factory)
      },
    },
  }
  try {
    // eslint-disable-next-line no-new-func -- the bundle is a script, not a module
    new Function(readFileSync(bundlePath, 'utf8'))()
    const factory = registry.get(packageName)
    if (factory === undefined) throw new Error(`bundle registered no factory for ${packageName}`)
    const primitives = {
      SettingsForm: (props: Record<string, unknown>) => props,
      SettingsValueField: (props: Record<string, unknown>) => props,
    }
    return factory((spec: string) => {
      if (spec === PRIMITIVES) return primitives
      throw new Error(`bundle requested unexpected external "${spec}"`)
    })
  } finally {
    delete globals.window
  }
}

/** Record what the bundle did to the stubbed client services. */
interface StubLog {
  watched: readonly string[]
  formFor?: string
  slot?: string
  entries: { id?: string; order?: number; label?: string; locale?: string }[]
  dictionaries: string[]
}

/** Drive the bundle's `apply` against stubbed browser services. */
function runApply(face: ClientFace): StubLog {
  const log: StubLog = { watched: [], entries: [], dictionaries: [] }
  const form = {
    getSnapshot: () => ({ status: 'ready', writable: true, revision: 1, value: {}, base: {}, user: {} }),
    subscribe: () => () => {},
    mutate: async () => true,
  }
  const ctx = {
    effect(effect: () => unknown) {
      const disposer = effect()
      return typeof disposer === 'function' ? disposer : () => {}
    },
    locale: {
      register(namespace: string) {
        log.dictionaries.push(namespace)
        return () => {}
      },
      bind: (namespace: string) => (key: string) => `${namespace}.${key}`,
    },
    configForms: {
      get(namespace: string) {
        log.formFor = namespace
        return form
      },
      whileServed(namespaces: readonly string[], register: (served: ReadonlySet<string>) => () => void) {
        log.watched = namespaces
        return register(new Set(namespaces))
      },
    },
    slots: {
      inject(_name: string, register: () => () => void) {
        log.slot = _name
        return register()
      },
      register(options: { id?: string; order?: number; label?: () => string; locale?: string }) {
        log.entries.push({
          id: options.id,
          order: options.order,
          label: options.label?.(),
          locale: options.locale,
        })
        return () => {}
      },
    },
  }
  face.apply(ctx)
  return log
}

const built = existsSync(bundlePath)

describe.skipIf(!built)('built client bundle', () => {
  let face: ClientFace
  beforeAll(() => { face = loadBundle() })

  it('registers a factory under the package name', () => {
    expect(face).toBeDefined()
  })

  it('exports the face the kernel activates', () => {
    expect(typeof face.apply).toBe('function')
    expect(face.inject).toEqual(['slots', 'locale', 'configForms'])
    expect(face.LAZY_TOOLS_NS).toBe('lazy-tools')
  })

  it('ships both dictionaries', () => {
    expect(Object.keys(face.locales).sort()).toEqual(['en', 'zh'])
    for (const dictionary of Object.values(face.locales)) {
      expect(dictionary.title).toBeTruthy()
      expect(dictionary.defer).toBeTruthy()
    }
  })

  it('registers the page into the Built-in plugins tab list while the namespace is served', () => {
    const log = runApply(face)
    expect(log.watched).toEqual(['lazy-tools'])
    expect(log.formFor).toBe('lazy-tools')
    expect(log.slot).toBe('settings.plugins.tab')
    expect(log.entries).toEqual([
      { id: 'lazy-tools', order: 40, label: 'settings.lazyTools.title', locale: 'settings.lazyTools' },
    ])
    expect(log.dictionaries).toEqual(['settings.lazyTools'])
  })
})
