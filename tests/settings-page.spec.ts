/**
 * Tests for the settings page's browser half.
 *
 * The page is a client plugin: `apply` registers a slot entry and a staged form
 * over the plugin's own settings namespace. Neither needs a DOM — the slots and
 * locale services are the only collaborators, so both are stubbed here, and the
 * form model is a plain object. That is what lets the editing rules (what a
 * draft means, which write a save produces) be tested directly, without a
 * browser or a React renderer.
 *
 * The bundle itself is exercised separately by `tests/client-bundle.spec.ts`,
 * which loads the real built artifact through a stand-in module loader.
 */
import { describe, expect, it, vi } from 'vitest'
import { booleanField, LazyToolsController, numberField, parseEntries, toolsField } from '../src/client/controller.ts'
import { LazyToolsCard, primitives } from '../src/client/page.ts'
import type { ConfigForm, ConfigOp } from '../src/client/contracts.ts'
import { DEFAULT_ACTIVE_TOOLS, DEFER_ALL_ENTRY } from '../src/config.ts'

/** One recorded write. */
interface RecordedWrite {
  ops: readonly ConfigOp[]
  revision: number | undefined
}

/**
 * Build a stub settings form.
 * @param options - the values to serve and the user layer's key set.
 * @returns the form and the writes it recorded.
 */
function stubForm(options: {
  value?: Record<string, unknown>
  user?: Record<string, unknown>
  base?: Record<string, unknown>
  writable?: boolean
  status?: string
  accept?: boolean
} = {}): { form: ConfigForm; writes: RecordedWrite[] } {
  const writes: RecordedWrite[] = []
  const form = {
    getSnapshot: () => ({
      status: (options.status ?? 'ready') as 'ready',
      writable: options.writable ?? true,
      revision: 4,
      value: options.value ?? {},
      base: options.base ?? {},
      user: options.user ?? {},
    }),
    subscribe: () => () => {},
    mutate: async (ops: readonly ConfigOp[], revision?: number) => {
      writes.push({ ops, revision })
      return options.accept ?? true
    },
  }
  return { form: form as unknown as ConfigForm, writes }
}

describe('list field drafts', () => {
  it('splits on commas and newlines, dropping blanks and trimming', () => {
    // Both separators work: a single-line input carries commas, while a pasted
    // multi-line value still arrives newline-separated.
    expect(parseEntries('glob, web_fetch')).toEqual(['glob', 'web_fetch'])
    expect(parseEntries('  glob \n\n\tweb_fetch\n   \n')).toEqual(['glob', 'web_fetch'])
    expect(parseEntries('a, b\nc ,, d')).toEqual(['a', 'b', 'c', 'd'])
  })

  it('treats an empty draft as a reset rather than an empty list', () => {
    // An empty array would pin an explicit "defer nothing" over the deployment's
    // own list; a clear restores inheritance instead.
    expect(toolsField('defer').parse('   \n  \n')).toEqual({ kind: 'clear' })
  })

  it('formats a list so it survives a single-line input', () => {
    // The shared value control renders <input type="text">, which strips
    // newlines from a rendered value. Formatting with newlines collapsed
    // ['bash','read'] to 'bashread' and wrote that back as ONE entry, so the
    // list must round-trip through a single line.
    const spec = toolsField('defer')
    expect(spec.format(['a', 'b'])).toBe('a, b')
    expect(spec.format(undefined)).toBe('')
    // The critical property: format -> parse is the identity for a list.
    const list = ['Defer(*)', 'web_fetch', 'glob']
    expect(spec.parse(spec.format(list))).toEqual({ kind: 'set', value: list })
  })
})

describe('scalar field drafts', () => {
  it('rejects non-numeric text instead of coercing it', () => {
    expect(numberField('autoTuneTopN').parse('abc')).toBeUndefined()
    expect(numberField('autoTuneTopN').parse('12')).toEqual({ kind: 'set', value: 12 })
    expect(numberField('autoTuneTopN').parse('')).toEqual({ kind: 'clear' })
  })

  it('treats a boolean draft as a value, never a clear', () => {
    expect(booleanField('autoTune').parse('false')).toEqual({ kind: 'set', value: false })
    expect(booleanField('autoTune').parse('true')).toEqual({ kind: 'set', value: true })
  })
})

describe('staged form', () => {
  it('reports a field the user layer carries as overridden', () => {
    const { form } = stubForm({ value: { defer: ['glob'] }, user: { defer: ['glob'] } })
    const page = new LazyToolsController(form)
    const projected = page.inject().hooks.lazyTools.getSnapshot()
    expect(projected.defer.overridden).toBe(true)
    expect(projected.noDefer.overridden).toBe(false)
    page.dispose()
  })

  it('writes one set op carrying the whole list', async () => {
    const { form, writes } = stubForm({ value: { defer: [] } })
    const page = new LazyToolsController(form)
    const face = page.inject()
    face.edit('defer', 'Defer(*), web_fetch')
    await face.save()
    expect(writes).toHaveLength(1)
    expect(writes[0].ops).toEqual([{ op: 'set', path: ['defer'], value: ['Defer(*)', 'web_fetch'] }])
    expect(face.hooks.lazyTools.getSnapshot().dirty).toBe(false)
    page.dispose()
  })

  it('refuses to save a draft its field does not accept', async () => {
    const { form, writes } = stubForm({ value: {} })
    const page = new LazyToolsController(form)
    const face = page.inject()
    face.edit('autoTuneTopN', 'not-a-number')
    expect(face.hooks.lazyTools.getSnapshot().invalid).toBe(true)
    await face.save()
    expect(writes).toHaveLength(0)
    page.dispose()
  })

  it('resets a user-layer field with an unset and stages nothing otherwise', async () => {
    const { form, writes } = stubForm({ value: { defer: ['glob'] }, user: { defer: ['glob'] } })
    const page = new LazyToolsController(form)
    const face = page.inject()
    face.resetField('defer')
    await face.save()
    expect(writes[0].ops).toEqual([{ op: 'unset', path: ['defer'] }])

    face.resetField('noDefer')
    await face.save()
    expect(writes).toHaveLength(1)
    page.dispose()
  })

  it('keeps drafts when the Host refuses the write', async () => {
    const { form } = stubForm({ accept: false })
    const page = new LazyToolsController(form)
    const face = page.inject()
    face.edit('autoTune', 'false')
    await face.save()
    const projected = face.hooks.lazyTools.getSnapshot()
    expect(projected.failed).toBe(true)
    expect(projected.dirty).toBe(true)
    page.dispose()
  })

  it('does not write when the profile is read-only', async () => {
    const { form, writes } = stubForm({ writable: false })
    const page = new LazyToolsController(form)
    const face = page.inject()
    face.edit('autoTune', 'false')
    await face.save()
    expect(writes).toHaveLength(0)
    page.dispose()
  })

  it('clears every draft on discard', () => {
    const { form } = stubForm({})
    const page = new LazyToolsController(form)
    const face = page.inject()
    face.edit('defer', 'glob')
    expect(face.hooks.lazyTools.getSnapshot().dirty).toBe(true)
    face.discard()
    expect(face.hooks.lazyTools.getSnapshot().dirty).toBe(false)
    page.dispose()
  })

  it('returns a referentially stable snapshot until something changes', () => {
    // useSyncExternalStore compares consecutive getSnapshot() results by
    // identity. Rebuilding the projection per call made React re-render forever
    // and throw "Maximum update depth exceeded" (#185) — observed in a real
    // browser as a blank page, which no Node-side test would have caught.
    const { form } = stubForm({ value: { defer: ['glob'] } })
    const page = new LazyToolsController(form)
    const face = page.inject()
    const store = face.hooks.lazyTools
    const first = store.getSnapshot()
    expect(store.getSnapshot()).toBe(first)
    expect(store.getSnapshot()).toBe(first)

    // A change must produce a NEW object, or React would never re-render.
    face.edit('defer', 'glob, web_fetch')
    expect(store.getSnapshot()).not.toBe(first)
    const second = store.getSnapshot()
    expect(store.getSnapshot()).toBe(second)
    page.dispose()
  })

  it('notifies subscribers when a draft changes', () => {
    const { form } = stubForm({})
    const page = new LazyToolsController(form)
    const face = page.inject()
    const listener = vi.fn()
    const off = face.hooks.lazyTools.subscribe(listener)
    face.edit('defer', 'glob')
    expect(listener).toHaveBeenCalled()
    off()
    page.dispose()
  })
})

/** One control the page drew, as recorded from the primitives seam. */
interface RenderedField {
  id: string
  label: string
  text: string
  overridden: boolean
  numeric: boolean
  disabled: boolean
}

/**
 * Render the page over a controller bound to a stub form.
 *
 * The shared primitives are swapped for recorders through the page's own seam,
 * so this observes exactly what would be drawn: which controls, with which
 * staged text, and which are marked overridden.
 *
 * The Plugins page calls a `plugins.item` entry twice, so the harness renders
 * the `page` view by default — that is the render that draws the form — and
 * callers needing the card's one-liner pass `view: 'summary'`. Both are
 * exercised because a wrong branch here is invisible to the type checker: the
 * slot component is cast at the registration site and returns `unknown`.
 * @param options - the namespace state to serve.
 * @param view - which half of the page to render; defaults to the form.
 * @returns the rendered controls, the form state, and what the entry returned.
 */
function renderPage(
  options: Parameters<typeof stubForm>[0] = {},
  view: 'summary' | 'page' = 'page',
): {
  fields: RenderedField[]
  state: Record<string, unknown>
  rendered: unknown
} {
  const { form } = stubForm(options)
  const page = new LazyToolsController(form)
  const face = page.inject()
  const fields: RenderedField[] = []
  let state: Record<string, unknown> = {}
  primitives.SettingsForm = (props) => {
    state = props.state as unknown as Record<string, unknown>
    return props.children
  }
  primitives.SettingsValueField = (props) => {
    fields.push({
      id: props.id,
      label: props.label,
      text: props.text,
      overridden: props.overridden,
      numeric: props.numeric === true,
      disabled: props.disabled === true,
    })
    return props.id
  }
  const props = {
    view,
    t: (key: string) => key,
    useLazyTools: (selector: (snapshot: unknown) => unknown) => selector(face.hooks.lazyTools.getSnapshot()),
    edit: face.edit,
    resetField: face.resetField,
    save: face.save,
    discard: face.discard,
  }
  const rendered = LazyToolsCard(props)
  page.dispose()
  return { fields, state, rendered }
}

describe('rendered page', () => {
  it('draws one control per configurable field, in a stable order', () => {
    const { fields } = renderPage({
      value: { defer: ['Defer(*)'], noDefer: ['bash'], autoTune: true },
      user: { defer: ['Defer(*)'] },
    })
    expect(fields.map((f) => f.label)).toEqual([
      'defer',
      'noDefer',
      'autoTune',
      'windowDays',
      'topN',
      'minSamples',
    ])
  })

  it('renders list fields one entry per line and numbers as numeric controls', () => {
    const { fields } = renderPage({
      value: {
        defer: ['Defer(*)', 'mcp_*'],
        noDefer: ['bash', 'read'],
        autoTuneWindowDays: 30,
        autoTuneTopN: 20,
        autoTuneMinSamples: 200,
      },
    })
    const byLabel = new Map(fields.map((f) => [f.label, f]))
    expect(byLabel.get('defer')?.text).toBe('Defer(*), mcp_*')
    expect(byLabel.get('noDefer')?.text).toBe('bash, read')
    expect(fields.filter((f) => f.numeric).map((f) => f.label)).toEqual([
      'windowDays',
      'topN',
      'minSamples',
    ])
    expect(byLabel.get('defer')?.numeric).toBe(false)
  })

  it('marks only the fields the user layer carries as overridden', () => {
    const { fields } = renderPage({
      value: { defer: ['glob'], autoTune: false },
      user: { autoTune: false },
    })
    const overridden = fields.filter((f) => f.overridden).map((f) => f.label)
    expect(overridden).toEqual(['autoTune'])
  })

  it('shows the shipped preset when the namespace is unconfigured', () => {
    // The regression this guards (#186): the settings plane drops any field
    // whose projected value is `undefined`, so a schema without a default made
    // both list boxes render empty while the plugin was deferring the long
    // tail — the form said "defer nothing" about a deployment doing the
    // opposite. The Host now resolves the preset into the field's default, so
    // the control is populated from the same value the request path enforces.
    const { fields } = renderPage({
      value: {
        defer: [DEFER_ALL_ENTRY],
        noDefer: [...DEFAULT_ACTIVE_TOOLS],
      },
    })
    const byLabel = new Map(fields.map((f) => [f.label, f]))
    expect(byLabel.get('defer')?.text).toBe(DEFER_ALL_ENTRY)
    expect(byLabel.get('noDefer')?.text).toBe(DEFAULT_ACTIVE_TOOLS.join(', '))
    // A schema default is not a user override, so neither box is marked as one.
    expect(byLabel.get('defer')?.overridden).toBe(false)
    expect(byLabel.get('noDefer')?.overridden).toBe(false)
  })

  it('renders the form only for the page view, and the one-liner only for the summary', () => {
    // The Plugins page renders a `plugins.item` entry twice: `summary` for the
    // card's one-liner and `page` for the body of the plugin's own detail page.
    // Getting the branches the wrong way round is silent — the registration
    // casts the component — so both directions are asserted.
    const page = renderPage({})
    expect(page.fields).toHaveLength(6)

    const summary = renderPage({}, 'summary')
    expect(summary.fields).toHaveLength(0)
    expect(summary.rendered).toBe('description')
  })

  it('disables every control on a read-only deployment', () => {
    const { fields, state } = renderPage({ writable: false })
    expect(state.writable).toBe(false)
    expect(fields).toHaveLength(6)
    expect(fields.every((f) => f.disabled)).toBe(true)
  })
})
