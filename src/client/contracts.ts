/**
 * Typed surface of the browser kernel this plugin's client half talks to.
 *
 * The client bundle resolves these as *externals* against the module table the
 * shell seeds, so they are real runtime imports. What they are not is a build
 * dependency: this package ships a Host-facing plugin, and making it depend on
 * five `@deepseek-ai/dsh-client-*` packages would force every headless consumer
 * to install the entire browser stack for a page it will never render.
 *
 * So the handful of members this page uses are declared here, deliberately
 * narrow: under-declaring is what keeps the page coupled to the *contract* it
 * relies on rather than to a released version of it. Anything not declared here
 * is a signal that the page is reaching for behavior no other settings page
 * uses.
 * @module @deepseek-ai/dsh-lazy-tools/client/contracts
 */

/** A component the slot renderer can mount. */
export type SlotComponent<P> = (props: P) => unknown

/**
 * The view the Plugins page asks a `plugins.item` entry for.
 *
 * The page renders the entry twice: `summary` is the card's one-liner in the
 * list, `page` is the body of the plugin's own page once the card is opened.
 * The `form` prop is supplied on the page render only, and carries the
 * Host-owned values and write action for the entry — the same namespace this
 * page reads through `configForms`, handed over by the page owner instead.
 */
export interface PluginConfigViewProps {
  /** `summary` renders the one-liner alone; `page` renders the configuration form. */
  readonly view: 'summary' | 'page'
  /** Host-owned configuration values and write actions; page view only. */
  readonly form?: ConfigPageForm | undefined
}

/**
 * Reactive values and commands the Plugins page supplies to a configuration
 * entry's page view.
 *
 * This plugin does not use it: {@link ConfigForm} from `configForms.get` is the
 * same namespace form and is what keeps the staged-edit model testable without
 * a renderer. Declared because the page hands it to every entry and a component
 * that ignores a prop should still say so in its contract.
 */
export interface ConfigPageForm {
  /** Accepted Host values. */
  readonly state: ConfigFormSnapshot
  /** Submit all field edits together with the revision the editor read. */
  readonly mutate: ConfigForm['mutate']
}

/**
 * One entry's staged-form state, as the shared `SettingsForm` renders it.
 *
 * `available` is false while the Host serves no such namespace — the form then
 * replaces its controls with the `unavailable` line instead of showing fields
 * nothing would accept.
 */
export interface SettingsFormState {
  /** Whether the Host currently serves this namespace. */
  available: boolean
  /** Whether the active profile accepts writes. */
  writable: boolean
  /** Whether a save would write anything. */
  dirty: boolean
  /** Whether some draft is not a value its field accepts. */
  invalid: boolean
  /** Whether a write is in flight. */
  saving: boolean
  /** Whether the last save was refused. */
  failed: boolean
}

/** One field's staged text and override state. */
export interface SettingsFieldState {
  /** What the control shows. */
  text: string
  /** Whether the user layer carries this field, regardless of the value. */
  overridden: boolean
  /** Whether the draft is not a value the field accepts. */
  invalid: boolean
}

/**
 * Convert a draft to a staged write, or reject it.
 *
 * Returning `{ kind: 'clear' }` stages a reset back to the inherited value;
 * returning `undefined` marks the draft invalid and blocks the save.
 */
export type FieldConversion =
  | { kind: 'set'; value: unknown }
  | { kind: 'clear' }
  | undefined

/** How one field turns stored values into text and back. */
export interface FieldSpec {
  /** Field name inside the namespace section. */
  field: string
  /** Render a stored value as the control's text. */
  format(value: unknown): string
  /** Convert a draft back to a write, or reject it. */
  parse(text: string): FieldConversion
}

/** One namespace's shared configuration form. */
export interface ConfigForm {
  /** Current snapshot, stable until the next change. */
  getSnapshot(): ConfigFormSnapshot
  /** Observe snapshot replacements. */
  subscribe(listener: () => void): () => void
  /**
   * Queue one atomic namespace mutation.
   * @param ops - ordered field operations.
   * @param expectedRevision - revision read before editing, for conflict detection.
   * @returns whether the Host accepted the mutation.
   */
  mutate(ops: readonly ConfigOp[], expectedRevision?: number): Promise<boolean>
}

/** One field operation on a settings namespace. */
export interface ConfigOp {
  op: 'set' | 'unset'
  path: readonly string[]
  value?: unknown
}

/** A namespace's resolved values and revision. */
export interface ConfigFormSnapshot {
  /** `loading` until the first describe settles; `unavailable` when unserved. */
  status: 'idle' | 'loading' | 'ready' | 'unavailable'
  /** Effective value: user layer over composition layer over schema default. */
  value?: Record<string, unknown>
  /** Whether the active profile accepts writes. */
  writable: boolean
  /** Revision a write must be fenced against. */
  revision?: number
}

/** The settings domain's form provider. */
export interface ConfigFormsService {
  /** Get the shared form for one Host plugin entry. */
  get(entryId: string): ConfigForm
  /**
   * Keep a registration alive while the Host serves any of some namespaces.
   * @param namespaces - namespaces to follow.
   * @param register - registers the contribution; returns its disposer.
   * @returns the disposer ending the watch and any live registration.
   */
  whileServed(namespaces: readonly string[], register: (served: ReadonlySet<string>) => () => void): () => void
}

/** The locale domain: per-namespace dictionaries with a bound reader. */
export interface LocaleService {
  /** Publish one namespace's dictionaries. */
  register(namespace: string, dictionaries: Record<string, Record<string, string>>): () => void
  /** Bind a reader to one namespace. */
  bind(namespace: string): (key: string) => string
}

/** The slots service, narrowed to the register/inject pair this page uses. */
export interface SlotsService {
  /**
   * Register a contribution, optionally deferred until its parent slot exists.
   * @param name - the slot to register into.
   * @param register - performs the registration once the slot is available.
   * @returns the disposer removing the contribution.
   */
  inject(name: string, register: () => () => void): () => void
  /**
   * Register one component into a slot.
   * @param options - the entry's identity, copy, and injected business props.
   * @param component - the component to mount.
   * @returns the disposer removing the entry.
   */
  register(options: SlotRegistrationOptions, component: SlotComponent<never>): () => void
}

/** One slot entry's declaration. */
export interface SlotRegistrationOptions {
  /** Slot name. */
  name: string
  /** Stable entry id inside that slot; a list slot elects one entry per id. */
  id?: string
  /**
   * Cell key inside a keyed slot, which is how `plugins.bundle.config` is
   * addressed: the owner renders the entry whose key matches the page it is
   * drawing. A list slot takes `id` instead.
   */
  key?: string
  /** Sort position among the slot's entries. */
  order?: number
  /** Localized label, used for list slots. */
  label?: () => string
  /** Dictionary namespace this entry's copy comes from. */
  locale?: string
  /** Build the business props the component receives. */
  inject?: () => object
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Slot registry for browser UI contributions. */
    slots: SlotsService
    /** Locale registry and bound readers. */
    locale: LocaleService
    /** Shared configuration forms over the Host settings document. */
    configForms: ConfigFormsService
  }
}