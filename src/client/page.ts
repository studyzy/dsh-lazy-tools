/**
 * The lazy-tools configuration, rendered as this plugin's page on the Plugins page.
 *
 * The page is a thin view over {@link LazyToolsController}: it draws the plugin's
 * six fields and hands every interaction back as an action. It renders the
 * shared `SettingsForm` frame so it matches the other settings pages — one save
 * control, staged edits, the read-only and unavailable notices — rather than
 * inventing its own chrome.
 *
 * Both `SettingsForm` and the field controls come from the shared primitives
 * package, imported as a bundle external. That is deliberate: reusing them is
 * what keeps this page's save semantics, conflict handling, and reset behavior
 * identical to the pages the installation already ships.
 * @module @studyzy/dsh-lazy-tools/client/page
 */

import { SettingsForm, SettingsValueField } from '@deepseek-ai/dsh-client-ui-primitives'

import type { LazyToolsPageFace, LazyToolsProjection } from './controller.ts'

/**
 * The primitives the page renders with.
 *
 * This is a module-level seam so the page can be exercised without a browser:
 * the tests swap in recorders and assert which controls the page draws, what
 * text each one shows, and which are marked overridden. That is the part of the
 * page most likely to drift — a field silently dropped from the form would
 * otherwise only be noticed by eye in the running UI.
 *
 * It is a plain object rather than a function parameter because the component is
 * called by the slot renderer, which supplies business props only; threading a
 * renderer dependency through the slot declaration would leak test concerns into
 * the production registration.
 */
export const primitives = { SettingsForm, SettingsValueField }

/**
 * The plugin's configuration entry, as the Plugins page renders it.
 *
 * The `plugins.item` slot calls its entry twice: once with `view: 'summary'`
 * for the one-liner under the card's title, and once with `view: 'page'` for
 * the body of the plugin's own page. Both must be handled, and the summary
 * branch must come first — rendering the form into the card would put the whole
 * configuration in the list, and returning the subtitle from the page branch
 * would leave the detail page with a stray sentence instead of a form.
 * @param props - the page's copy, its snapshot, and its actions.
 * @returns the card's one-liner, or the settings form.
 */
export function LazyToolsCard(props: LazyToolsCardProps): unknown {
  const { t } = props
  // The summary view draws one line of copy and no controls, so it must not
  // subscribe to the form: the card is rendered once per visit to the list, and
  // a store subscription there would be created and dropped for a string.
  if (props.view === 'summary') return t('description')
  const state = props.useLazyTools((snapshot) => snapshot)
  const disabled = !state.writable
  const labels = {
    unavailable: t('unavailable'),
    readOnly: t('readOnly'),
    saveFailed: t('saveFailed'),
    save: t('save'),
    saving: t('saving'),
  }
  /** Shared props every text field needs. */
  const fieldProps = {
    overriddenLabel: t('overridden'),
    resetLabel: t('reset'),
    invalidLabel: t('invalidNumber'),
    disabled,
  }
  const { SettingsForm, SettingsValueField } = primitives
  return SettingsForm({
    labels,
    state,
    onSave: props.save,
    onDiscard: props.discard,
    children: [
      SettingsValueField({
        id: 'plugin-config-lazy-tools-defer',
        label: t('defer'),
        hint: t('deferHint'),
        ...fieldProps,
        ...state.defer,
        onEdit: (text: string) => { props.edit('defer', text) },
        onReset: () => { props.resetField('defer') },
      }),
      SettingsValueField({
        id: 'plugin-config-lazy-tools-no-defer',
        label: t('noDefer'),
        hint: t('noDeferHint'),
        ...fieldProps,
        ...state.noDefer,
        onEdit: (text: string) => { props.edit('noDefer', text) },
        onReset: () => { props.resetField('noDefer') },
      }),
      SettingsValueField({
        id: 'plugin-config-lazy-tools-autoTune',
        label: t('autoTune'),
        hint: t('autoTuneHint'),
        ...fieldProps,
        ...state.autoTune,
        // Switches are staged through the same text channel as every other
        // field: the shared form model has one edit action, and the controller's
        // boolean spec is what gives 'true'/'false' their meaning here.
        onEdit: () => { props.edit('autoTune', state.autoTune.text === 'true' ? 'false' : 'true') },
        onReset: () => { props.resetField('autoTune') },
      }),
      SettingsValueField({
        id: 'plugin-config-lazy-tools-window-days',
        label: t('windowDays'),
        hint: t('windowDaysHint'),
        numeric: true,
        ...fieldProps,
        ...state.autoTuneWindowDays,
        onEdit: (text: string) => { props.edit('autoTuneWindowDays', text) },
        onReset: () => { props.resetField('autoTuneWindowDays') },
      }),
      SettingsValueField({
        id: 'plugin-config-lazy-tools-top-n',
        label: t('topN'),
        hint: t('topNHint'),
        numeric: true,
        ...fieldProps,
        ...state.autoTuneTopN,
        onEdit: (text: string) => { props.edit('autoTuneTopN', text) },
        onReset: () => { props.resetField('autoTuneTopN') },
      }),
      SettingsValueField({
        id: 'plugin-config-lazy-tools-min-samples',
        label: t('minSamples'),
        hint: t('minSamplesHint'),
        numeric: true,
        ...fieldProps,
        ...state.autoTuneMinSamples,
        onEdit: (text: string) => { props.edit('autoTuneMinSamples', text) },
        onReset: () => { props.resetField('autoTuneMinSamples') },
      }),
    ],
  })
}

/** Props the slot renderer supplies to {@link LazyToolsCard}. */
export interface LazyToolsCardProps {
  /**
   * Which half of the page is being drawn.
   *
   * `summary` asks for the card's one-liner alone; `page` asks for the form
   * that is the body of the plugin's own page.
   */
  view: 'summary' | 'page'
  /** This page's bound locale reader. */
  t(key: string): string
  /** The store hook the slot's business share provides. */
  useLazyTools<T>(selector: (snapshot: LazyToolsProjection) => T): T
  /** Stage one field edit. */
  edit(field: string, text: string): void
  /** Stage a reset of one field back to its inherited value. */
  resetField(field: string): void
  /** Write every staged edit. */
  save(): void
  /** Drop every staged edit. */
  discard(): void
}

/** Re-exported so the entry module can register this component without a cycle. */
export type { LazyToolsPageFace }