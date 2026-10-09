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
const packageName = '@studyzy/dsh-lazy-tools'
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
  slots: string[]
  entries: {
    slot?: string
    id?: string
    key?: string
    order?: number
    label?: string
    locale?: string
    inject?: () => object
  }[]
  dictionaries: string[]
}

/** Drive the bundle's `apply` against stubbed browser services. */
function runApply(face: ClientFace): StubLog {
  const log: StubLog = { watched: [], slots: [], entries: [], dictionaries: [] }
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
        log.slots.push(_name)
        return register()
      },
      register(options: {
        name: string
        id?: string
        key?: string
        order?: number
        label?: () => string
        locale?: string
        inject?: () => object
      }) {
        log.entries.push({
          slot: options.name,
          id: options.id,
          key: options.key,
          order: options.order,
          label: options.label?.(),
          locale: options.locale,
          inject: options.inject,
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

  it('registers the configuration form on both Plugins-page surfaces', () => {
    // Two registrations, because the Plugins page files this plugin as a
    // package card (it is a profile dependency) AND as an official-plugin card.
    // Registering only one leaves whichever page the user opens without a form,
    // and nothing at build time would say so.
    const log = runApply(face)
    expect(log.watched).toEqual(['lazy-tools'])
    expect(log.formFor).toBe('lazy-tools')
    expect(log.slots).toEqual(['plugins.item', 'plugins.bundle.config'])
    expect(log.dictionaries).toEqual(['settings.lazyTools'])

    const [item, bundle] = log.entries
    expect(item).toMatchObject({
      slot: 'plugins.item',
      id: 'lazy-tools',
      order: 40,
      label: 'settings.lazyTools.title',
      locale: 'settings.lazyTools',
    })
    expect(bundle).toMatchObject({
      slot: 'plugins.bundle.config',
      key: packageName,
      locale: 'settings.lazyTools',
    })
    // The package page asks only for `view: 'page'`, so this entry carries no
    // id, order, or label; it is addressed by its key alone.
    expect(bundle?.id).toBeUndefined()
    expect(bundle?.label).toBeUndefined()
  })

  it('shares one controller face across both surfaces', () => {
    // Both pages must read and stage through the SAME controller. Two
    // controllers over one namespace would give each page its own draft map, so
    // an edit staged on the Official card would be invisible on the package
    // page and a save there would write nothing.
    //
    // The comparison is on what the `inject` functions RETURN, not on the
    // functions: each is its own closure over the shared face, so identity of
    // the closures would prove nothing either way.
    const log = runApply(face)
    const [item, bundle] = log.entries
    expect(item?.inject).toBeDefined()
    expect(item?.inject?.()).toBe(bundle?.inject?.())
  })
})
