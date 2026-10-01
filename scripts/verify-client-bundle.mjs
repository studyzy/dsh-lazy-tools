#!/usr/bin/env node
/**
 * Verify the built client bundle against the browser kernel's contract.
 *
 * The settings page reaches users only if `lib/client.js` satisfies rules that
 * are enforced in the *browser*, not at build time: the bundle must register a
 * factory under the package name, request only modules the shell seeds, and
 * export the face the kernel activates. A mistake in any of those fails at page
 * load for the user and nowhere in `pnpm run check`, so this script closes that
 * gap by executing the real artifact through a stand-in module loader.
 *
 * It also cross-checks the manifest, because the bundle is useless if
 * `dsh.client` is missing or `exports["./client"]` points somewhere else — the
 * two halves of the declaration are easy to update independently by accident.
 *
 * Usage: node scripts/verify-client-bundle.mjs
 * @module @deepseek-ai/dsh-lazy-tools/scripts/verify-client-bundle
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const manifestPath = join(packageRoot, 'package.json')

/** Failures collected so one run reports every problem, not just the first. */
const failures = []
const checks = []

/**
 * Record one check's outcome.
 * @param label - what was verified.
 * @param ok - whether it held.
 * @param detail - optional evidence to print.
 */
function check(label, ok, detail = '') {
  checks.push({ label, ok, detail })
  if (!ok) failures.push(label)
}

const pkg = JSON.parse(readFileSync(manifestPath, 'utf8'))
const packageName = pkg.name

// --- Manifest: the declaration the host scans -----------------------------
const decl = pkg.dsh?.client
check('manifest declares dsh.client', typeof decl === 'object' && decl !== null)
check('dsh.client.platform is "web"', decl?.platform === 'web', `platform=${decl?.platform}`)
check(
  'dsh.client.inject is a string array',
  decl?.inject === undefined || (Array.isArray(decl.inject) && decl.inject.every((v) => typeof v === 'string')),
  JSON.stringify(decl?.inject),
)

const clientExport = pkg.exports?.['./client']
const clientRel = typeof clientExport === 'string' ? clientExport : clientExport?.default
check('exports["./client"] resolves to a path', typeof clientRel === 'string', String(clientRel))

const bundlePath = clientRel === undefined ? undefined : join(packageRoot, clientRel)
check('built client bundle exists (run `pnpm run build`)', bundlePath !== undefined && existsSync(bundlePath), clientRel)

if (failures.length > 0) {
  report()
  process.exit(1)
}

// --- Bundle: the runtime contract the kernel enforces ---------------------
const bundle = readFileSync(bundlePath, 'utf8')
const registry = new Map()
globalThis.window = {
  __ModuleLoader__: {
    load(registration) {
      if (registry.has(registration.id)) failures.push(`registered "${registration.id}" twice`)
      registry.set(registration.id, registration.factory)
    },
  },
}

try {
  // Evaluate exactly as a browser <script> would.
  new Function(bundle)()
} catch (error) {
  check('bundle evaluates as a script', false, String(error))
  report()
  process.exit(1)
}

check('bundle registers a factory under the package name', registry.has(packageName), packageName)

const factory = registry.get(packageName)
// Only primitives and baseline React modules may be requested; anything else
// means the bundle inlined a dependency the shell also provides.
const ALLOWED_EXTERNALS = new Set([
  'react',
  'react/jsx-runtime',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-primitives',
])
const requested = []
const primitivesStub = { SettingsForm: (props) => props, SettingsValueField: (props) => props }

let face
try {
  face = factory((spec) => {
    requested.push(spec)
    if (!ALLOWED_EXTERNALS.has(spec)) throw new Error(`unexpected external "${spec}"`)
    if (spec === '@deepseek-ai/dsh-client-ui-primitives') return primitivesStub
    throw new Error(`"${spec}" is a baseline module the harness supplies; this check stubs only primitives`)
  })
} catch (error) {
  check('factory materializes with the shell module table', false, String(error))
  report()
  process.exit(1)
}

check(
  'factory requests only shell-provided modules',
  requested.every((s) => ALLOWED_EXTERNALS.has(s)),
  requested.join(', ') || '(none)',
)
check('exports apply()', typeof face.apply === 'function')
check('exports inject', Array.isArray(face.inject), JSON.stringify(face.inject))
check('exports the edited namespace', typeof face.LAZY_TOOLS_NS === 'string', face.LAZY_TOOLS_NS)
check('exports en and zh dictionaries', Boolean(face.locales?.en && face.locales?.zh))

// --- Apply: what the page actually registers ------------------------------
const seen = { dictionaries: [], watched: [], entries: [] }
const snapshot = { status: 'ready', writable: true, revision: 1, value: {}, base: {}, user: {} }
try {
  face.apply({
    effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} },
    locale: {
      register: (ns) => { seen.dictionaries.push(ns); return () => {} },
      bind: () => (key) => key,
    },
    configForms: {
      get: (ns) => { seen.formFor = ns; return { getSnapshot: () => snapshot, subscribe: () => () => {}, mutate: async () => true } },
      whileServed: (namespaces, register) => { seen.watched = [...namespaces]; return register(new Set(namespaces)) },
    },
    slots: {
      inject: (name, register) => { seen.slot = name; return register() },
      register: (options) => {
        seen.entries.push({ id: options.id, order: options.order, locale: options.locale })
        return () => {}
      },
    },
  })
} catch (error) {
  check('apply() runs against the client services', false, String(error))
  report()
  process.exit(1)
}

check('registers exactly one dictionary namespace', seen.dictionaries.length === 1, seen.dictionaries.join(', '))
check('follows the plugin namespace while served', seen.watched.includes(seen.formFor), `${seen.watched} / ${seen.formFor}`)
check('registers into the Built-in plugins tab list', seen.slot === 'settings.plugins.tab', String(seen.slot))
check('registers exactly one settings tab', seen.entries.length === 1, JSON.stringify(seen.entries))

report()
process.exit(failures.length === 0 ? 0 : 1)

/** Print every check with its evidence. */
function report() {
  for (const { label, ok, detail } of checks) {
    const mark = ok ? 'PASS' : 'FAIL'
    console.log(`${mark}  ${label}${detail ? `  [${detail}]` : ''}`)
  }
  if (failures.length === 0) console.log('\nclient bundle satisfies the browser kernel contract.')
  else console.log(`\n${failures.length} check(s) failed.`)
}