/**
 * Staged form over the plugin's `lazy-tools` settings namespace.
 *
 * The controller owns the two things the page needs and nothing else: the
 * plugin's own field specs, and the projection the slot entry injects. It exists
 * as a separate module from the page so the editing rules — what a draft means,
 * which fields count as overridden — are testable without a DOM.
 *
 * Two of the plugin's Config fields are string lists (`defer`, `noDefer`), which
 * no shared field spec renders. {@link toolsField} adds that: it shows one entry
 * per line and writes the whole array as a single `set`, which is exactly how the
 * settings wire models a list replacement. Writing the array wholesale (rather
 * than per index) keeps a save to one atomic operation, so a partially applied
 * edit — half a list — is not a reachable state.
 * @module @studyzy/dsh-lazy-tools/client/controller
 */

import type { ConfigForm, ConfigFormSnapshot, FieldSpec, SettingsFieldState, SettingsFormState } from './contracts.ts'
// From ./preset.ts, not ../config.ts: that module imports the Host-only
// `@deepseek-ai/dsh-tools` for its guard list, which the browser's module table
// cannot resolve, so reaching through it would break the client bundle.
import { resolveDeferPatterns } from '../preset.ts'

/** Fields this page edits, in render order. */
export const FIELDS = ['defer', 'noDefer', 'autoTune', 'autoTuneWindowDays', 'autoTuneTopN', 'autoTuneMinSamples'] as const

/** One editable field name. */
export type FieldName = (typeof FIELDS)[number]

/** Fields whose drafts are whole numbers. */
const NUMERIC_FIELDS: ReadonlySet<FieldName> = new Set(['autoTuneWindowDays', 'autoTuneTopN', 'autoTuneMinSamples'])

/** Fields whose drafts are tool-name lists. */
const LIST_FIELDS: ReadonlySet<FieldName> = new Set(['defer', 'noDefer'])

/**
 * Split one list field's draft into its entries.
 *
 * Entries are separated by **commas or newlines**, and blank entries are
 * dropped. Both separators are accepted because the shared `SettingsValueField`
 * renders a single-line `<input type="text">`: a newline can be *typed into* the
 * draft the user pastes, but the browser strips it from the rendered value, so a
 * newline-only format would silently join `bash, read` into `bashread` and then
 * write that single mangled entry back. Commas keep the list intact through a
 * single-line control; newlines keep a pasted multi-line list working.
 *
 * Commas are safe as a separator because a tool name cannot contain one: tool
 * names are identifiers, and the `Defer(...)` wrapper is matched from the
 * outside, so a comma inside it would already be part of a name no tool has.
 * @param text - the control's raw draft.
 * @returns the trimmed, non-empty entries.
 */
export function parseEntries(text: string): string[] {
  return text
    .split(/[,\n]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
}

/**
 * A comma-separated spec for one string-list field.
 *
 * An empty draft is a *clear*, not an empty array: clearing the control must
 * restore inheritance from the composition layer, which is what lets a
 * deployment's own `defer` list show through again. Writing `[]` instead would
 * pin an explicit "defer nothing" over it — a different, and much more
 * surprising, configuration.
 * @param field - list field name inside the namespace section.
 * @returns the field's conversion spec.
 */
export function toolsField(field: string): FieldSpec {
  return {
    field,
    // Rendered with ", " so the value round-trips through a single-line input
    // unchanged, and reads the way the README examples write these lists.
    format: (value) => (Array.isArray(value) ? value.join(', ') : ''),
    parse: (text) => {
      const entries = parseEntries(text)
      return entries.length === 0 ? { kind: 'clear' } : { kind: 'set', value: entries }
    },
  }
}

/**
 * A whole-number spec that keeps an empty draft as a clear and rejects
 * non-numeric text instead of silently coercing it.
 * @param field - numeric field name inside the namespace section.
 * @returns the field's conversion spec.
 */
export function numberField(field: string): FieldSpec {
  return {
    field,
    format: (value) => (typeof value === 'number' ? String(value) : ''),
    parse: (text) => {
      const trimmed = text.trim()
      if (trimmed === '') return { kind: 'clear' }
      const parsed = Number(trimmed)
      return Number.isFinite(parsed) ? { kind: 'set', value: parsed } : undefined
    },
  }
}

/**
 * A boolean spec over a checkbox draft.
 *
 * Booleans have no empty state — unchecked is a value, not a clear — so this
 * always stages a write. That is what makes the two switches behave like
 * switches: toggling one and saving must record the choice even when it equals
 * the schema default, and only the reset action restores inheritance.
 * @param field - boolean field name inside the namespace section.
 * @returns the field's conversion spec.
 */
export function booleanField(field: string): FieldSpec {
  return {
    field,
    format: (value) => (value === false ? 'false' : 'true'),
    parse: (text) => ({ kind: 'set', value: text === 'true' }),
  }
}

/** One staged draft. */
interface Staged {
  text: string
  clear: boolean
}

/**
 * Bridge the `lazy-tools` settings namespace onto the page's staged form.
 *
 * Writes are staged until the user saves, matching every other settings page:
 * each write is a durable document mutation, so committing per keystroke would
 * turn one edit into a series of writes the user never asked for and could not
 * preview.
 */
export class LazyToolsController {
  private readonly form: ConfigForm
  private readonly specs: Map<string, FieldSpec>
  private readonly staged = new Map<string, Staged>()
  private readonly listeners = new Set<() => void>()
  private readonly unsubscribe: () => void
  private baseline: number | undefined
  private saving = false
  private failed = false
  private disposed = false
  /**
   * The projection last handed to a subscriber.
   *
   * `useSyncExternalStore` compares consecutive `getSnapshot()` results by
   * identity and re-renders whenever they differ, so this must stay referentially
   * stable between changes. Rebuilding it per call instead makes React re-render
   * forever and throw "Maximum update depth exceeded" (#185) — verified in a real
   * browser, which is why the cache is not an optimization here but the
   * difference between a working page and a blank one.
   */
  private cached: LazyToolsProjection | undefined

  /** @param form - the shared configuration form for the plugin's own entry. */
  constructor(form: ConfigForm) {
    this.form = form
    this.specs = new Map<string, FieldSpec>(
      FIELDS.map((field) => {
        if (LIST_FIELDS.has(field)) return [field, toolsField(field)]
        if (NUMERIC_FIELDS.has(field)) return [field, numberField(field)]
        return [field, booleanField(field)]
      }),
    )
    this.unsubscribe = form.subscribe(() => { this.publish() })
  }

  /**
   * Build the face the page's slot entry injects.
   *
   * The shape is the slot contract's business share: a `hooks` seat the
   * component reads through, plus the form actions. The page never touches the
   * form or the transport directly.
   * @returns the page's snapshot hook and its actions.
   */
  inject(): LazyToolsPageFace {
    return {
      hooks: { lazyTools: this.bind() },
      edit: (field, text) => { this.stage(field, { text, clear: false }) },
      resetField: (field) => { this.resetField(field) },
      save: () => { void this.save() },
      discard: () => { this.discard() },
    }
  }

  /** Release the accepted-value subscription. */
  dispose(): void {
    this.disposed = true
    this.unsubscribe()
    this.listeners.clear()
  }

  /**
   * The store the slot's `useLazyTools` selector reads.
   *
   * A snapshot store would normally come from a client package, but that package
   * is not a dependency of this one, so the store is built here. The one contract
   * that matters is {@link snapshot}: identical until the next change.
   * @returns the read/subscribe pair the component consumes.
   */
  private bind(): LazyToolsStore {
    return {
      getSnapshot: () => this.snapshot(),
      subscribe: (listener) => {
        this.listeners.add(listener)
        return () => { this.listeners.delete(listener) }
      },
    }
  }

  /**
   * The current projection, rebuilt only after a change.
   * @returns the cached projection, referentially stable until the next change.
   */
  private snapshot(): LazyToolsProjection {
    this.cached ??= this.projection()
    return this.cached
  }

  /** Invalidate the cache and notify subscribers. */
  private publish(): void {
    this.cached = undefined
    for (const listener of this.listeners) {
      try {
        listener()
      } catch {
        // A subscriber that throws must not stop the remaining ones; the page
        // re-reads on the next change either way.
      }
    }
  }

  /** Build the page's whole projection from the form and the local drafts. */
  private projection(): LazyToolsProjection {
    const snapshot = this.form.getSnapshot()
    const plan = this.plan()
    const invalid = plan.some((item) => item.op === undefined)
    return {
      available: snapshot.status === 'ready',
      writable: snapshot.writable,
      dirty: plan.length > 0,
      invalid,
      saving: this.saving,
      failed: this.failed,
      defer: this.fieldState('defer'),
      noDefer: this.fieldState('noDefer'),
      autoTune: this.booleanState('autoTune'),
      autoTuneWindowDays: this.fieldState('autoTuneWindowDays'),
      autoTuneTopN: this.fieldState('autoTuneTopN'),
      autoTuneMinSamples: this.fieldState('autoTuneMinSamples'),
    }
  }

  /** One text field's staged state. */
  private fieldState(field: FieldName): SettingsFieldState {
    const staged = this.staged.get(field)
    const spec = this.spec(field)
    if (staged === undefined) {
      return { text: spec.format(this.value(field)), overridden: this.stored(field), invalid: false }
    }
    const write = staged.clear ? { kind: 'clear' as const } : spec.parse(staged.text)
    return { text: staged.text, overridden: write?.kind === 'set', invalid: write === undefined }
  }

  /** One boolean field's staged state, shown as a checked switch. */
  private booleanState(field: FieldName): SettingsFieldState {
    const staged = this.staged.get(field)
    if (staged === undefined) {
      return { text: this.spec(field).format(this.value(field)), overridden: this.stored(field), invalid: false }
    }
    return { text: staged.text, overridden: !staged.clear, invalid: false }
  }

  /** The field's effective value showable by the form.
   *
   * The Host projects only fields whose value is defined, and this plugin
   * deliberately leaves `defer` / `noDefer` undefined when they are
   * unconfigured — a schema default cannot express "the preset, but only while
   * nothing is configured", because the Loader injects a schema default into
   * *every* resolved configuration. Writing one there would make
   * `defer: ['glob']` silently also inherit the preset's `noDefer` core, which
   * protects `glob` instead of deferring it (#186).
   *
   * So the preset is resolved here, at the display layer, where it can only
   * influence what the box shows and never what the Host enforces. The
   * displayed value and the enforced value stay equal because both are the same
   * pure function of the same configuration.
   * @param field - field name inside the namespace section.
   * @returns the value to render, with the shipped preset substituted when the
   *   pattern pair is entirely unconfigured.
   */
  private value(field: string): unknown {
    const section = this.form.getSnapshot().value
    const resolved = resolveDeferPatterns({
      defer: section?.defer as string[] | undefined,
      noDefer: section?.noDefer as string[] | undefined,
    })
    if (field === 'defer') return resolved.defer
    if (field === 'noDefer') return resolved.noDefer
    return this.rawValue(field)
  }

  /** The field's value exactly as the settings document holds it, with no preset substituted. */
  private rawValue(field: string): unknown {
    return this.form.getSnapshot().value?.[field]
  }

  /** Whether the user layer carries this field, which is what marks it overridden. */
  private stored(field: string): boolean {
    const snapshot: ConfigFormSnapshot = this.form.getSnapshot()
    const user = (snapshot as { user?: Record<string, unknown> }).user
    return user !== undefined && Object.hasOwn(user, field)
  }

  /** Read one field's spec, failing loudly on a typo rather than rendering blank. */
  private spec(field: string): FieldSpec {
    const spec = this.specs.get(field)
    if (spec === undefined) throw new Error(`lazy-tools: no field spec for "${field}"`)
    return spec
  }

  /** Stage a draft edit. */
  private stage(field: string, draft: Staged): void {
    this.staged.set(field, draft)
    this.publish()
  }

  /** Stage a reset back to the inherited value. */
  private resetField(field: string): void {
    this.stage(field, { text: this.spec(field).format(this.baseValue(field)), clear: true })
  }

  /** The value the composition layer supplies, which a reset restores. */
  private baseValue(field: string): unknown {
    const base = (this.form.getSnapshot() as { base?: Record<string, unknown> }).base
    return base?.[field]
  }

  /** Drop every draft. */
  private discard(): void {
    if (this.staged.size === 0 && !this.failed) return
    this.staged.clear()
    this.baseline = undefined
    this.failed = false
    this.publish()
  }

  /**
   * Every staged edit a save would write.
   *
   * A draft that is not a value its field accepts contributes an entry with no
   * operation, which keeps the form dirty and makes the save refuse rather than
   * silently dropping the edit.
   */
  private plan(): { field: string; op?: { op: 'set' | 'unset'; path: string[]; value?: unknown } }[] {
    const plan: { field: string; op?: { op: 'set' | 'unset'; path: string[]; value?: unknown } }[] = []
    for (const [field, staged] of this.staged) {
      const spec = this.spec(field)
      if (staged.clear) {
        if (this.stored(field)) plan.push({ field, op: { op: 'unset', path: [field] } })
        continue
      }
      const write = spec.parse(staged.text)
      if (write === undefined) {
        plan.push({ field })
        continue
      }
      if (write.kind === 'clear') {
        if (this.stored(field)) plan.push({ field, op: { op: 'unset', path: [field] } })
        continue
      }
      // Boolean drafts always write: an unchecked switch is a choice, and only an
      // explicit reset restores inheritance. Text drafts that already match what
      // the *document* holds stage nothing, so re-saving an untouched field is a
      // no-op. The comparison is against the raw stored value rather than
      // {@link value}, which substitutes the shipped preset for an unconfigured
      // pair: an operator who explicitly types the preset's own text must still
      // get it persisted, or the box would show a value that a later change to
      // the composition layer could silently take away.
      if (!LIST_FIELDS.has(field as FieldName) && !NUMERIC_FIELDS.has(field as FieldName)) {
        plan.push({ field, op: { op: 'set', path: [field], value: write.value } })
        continue
      }
      if (staged.text === spec.format(this.rawValue(field))) continue
      plan.push({ field, op: { op: 'set', path: [field], value: write.value } })
    }
    return plan
  }

  /**
   * Write every staged edit, then re-seed from what the Host accepted.
   *
   * The Host is the only authority on whether a value was accepted — its
   * validators own constraints no schema can express — so the outcome is read
   * back from the namespace rather than predicted. A refused save keeps its
   * drafts so the user can correct them instead of retyping.
   */
  private async save(): Promise<void> {
    const plan = this.plan()
    if (plan.length === 0 || this.saving || this.disposed) return
    if (plan.some((item) => item.op === undefined)) return
    const snapshot = this.form.getSnapshot()
    if (!snapshot.writable) return
    this.saving = true
    this.failed = false
    this.publish()
    try {
      const landed = await this.form.mutate(
        plan.flatMap((item) => (item.op === undefined ? [] : [item.op])),
        this.baseline ?? snapshot.revision,
      )
      if (landed) {
        this.staged.clear()
        this.baseline = undefined
      }
      this.failed = !landed
    } catch {
      this.failed = true
    } finally {
      this.saving = false
      this.publish()
    }
  }
}

/** The projection the page renders. */
export interface LazyToolsProjection extends SettingsFormState {
  defer: SettingsFieldState
  noDefer: SettingsFieldState
  autoTune: SettingsFieldState
  autoTuneWindowDays: SettingsFieldState
  autoTuneTopN: SettingsFieldState
  autoTuneMinSamples: SettingsFieldState
}

/** Read-only store the slot's selector hook consumes. */
export interface LazyToolsStore {
  getSnapshot(): LazyToolsProjection
  subscribe(listener: () => void): () => void
}

/** The business props the page's slot entry injects. */
export interface LazyToolsPageFace {
  hooks: { lazyTools: LazyToolsStore }
  edit(field: string, text: string): void
  resetField(field: string): void
  save(): void
  discard(): void
}