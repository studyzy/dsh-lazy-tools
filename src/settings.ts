/**
 * Optional Host-settings integration for dsh-lazy-tools.
 *
 * The plugin is fully functional without the settings plane — it is a config
 * consumer like any other cordis plugin, and on a headless composition there is
 * simply no page to edit it from. The settings service is therefore an optional
 * collaborator reached through `ctx.inject(['settings'], ...)`, not a hard
 * dependency, and this module carries the ambient declarations that make that
 * collaboration typed without adding `@deepseek-ai/dsh-settings` to the
 * manifest (which would force every consumer to install it).
 *
 * Two declarations are needed:
 *
 * 1. The `settings` service on {@link Context}, so `child.settings.configure`
 *    typechecks. Only the one member this plugin calls is declared: the real
 *    service is far larger, and under-declaring is what keeps this plugin from
 *    being coupled to a version of it.
 * 2. The `loader/volatile-update` event the Loader emits after committing a
 *    live config edit. The plugin uses it to re-rank live agents, since a
 *    volatile write updates the running config in place instead of remounting
 *    the plugin and re-running `apply`.
 * @module @studyzy/dsh-lazy-tools/settings
 */

import type { Fiber } from '@deepseek-ai/cordis'

/**
 * Automatic-page policy for one plugin instance, as the settings service
 * records it. `auto` defaults to true, which is why this plugin — one that
 * ships its own page — must state `false` explicitly.
 */
export interface SettingsPresentation {
  /** Whether the settings plane derives a form from this plugin's schema. */
  auto?: boolean
}

/**
 * The slice of the Host settings service this plugin uses.
 *
 * The plugin only ever opts out of the generated form; it never reads or writes
 * settings directly. Values reach it through its own volatile config instead,
 * which keeps the plugin's behavior identical on a composition that has no
 * settings service at all.
 */
export interface SettingsService {
  /**
   * Register the calling plugin instance's page policy.
   * @param presentation - automatic-page policy for this instance.
   * @param owner - plugin instance the policy belongs to.
   * @returns the disposer removing the policy.
   */
  configure(presentation: SettingsPresentation, owner?: Fiber): () => void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host settings service; absent on a composition that ships no settings plane. */
    settings: SettingsService
  }

  interface Events {
    /**
     * Volatile config values were committed into a running fiber without a
     * remount, dispatched to the owning fiber only.
     * @param paths - changed config paths as key arrays.
     */
    'loader/volatile-update'(paths: readonly (readonly string[])[]): void
  }
}