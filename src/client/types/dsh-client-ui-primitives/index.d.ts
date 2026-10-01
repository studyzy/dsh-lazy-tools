/**
 * Ambient module declaration for the shared UI primitives bundle.
 *
 * The real package is a browser *external* resolved at load time from the
 * shell's frozen module table (see ../primitives.ts). It is declared here as a
 * standalone module rather than through `declare module` augmentation because
 * augmentation requires the target to resolve, and this package deliberately
 * does not depend on the browser UI stack.
 */
export interface SettingsValueFieldProps {
  id: string
  label: string
  hint?: string
  overriddenLabel: string
  resetLabel: string
  invalidLabel: string
  numeric?: boolean
  disabled?: boolean
  text: string
  overridden: boolean
  invalid: boolean
  onEdit(text: string): void
  onReset(): void
}

export interface SettingsFormProps {
  labels: {
    unavailable: string
    readOnly: string
    saveFailed: string
    save: string
    saving: string
  }
  state: {
    available: boolean
    writable: boolean
    dirty: boolean
    invalid: boolean
    saving: boolean
    failed: boolean
  }
  onSave(): void
  onDiscard(): void
  children: unknown
}

export function SettingsValueField(props: SettingsValueFieldProps): unknown
export function SettingsForm(props: SettingsFormProps): unknown
