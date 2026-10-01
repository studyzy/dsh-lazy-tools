/**
 * Browser half of the dsh-lazy-tools settings page.
 *
 * The page edits this plugin's defer configuration from the Web/Desktop UI.
 * It is the browser counterpart of `src/index.ts`: the Host half publishes its
 * Config through the settings plane (volatile fields, `data-lazy-tools`), and
 * this module renders the form and writes edits back.
 *
 * Composition follows the dsh client-plugin contract:
 *
 * - The package declares `dsh.client` in `package.json`, so `dsh-client-modules`
 *   serves `lib/client.js` to the browser and attaches it to the Loader row for
 *   the bare package name. Switching the row off removes the page with it.
 * - The page registers into `settings.plugins.tab`, the tab list inside the
 *   Settings section's "Built-in plugins" page, so it sits beside the other
 *   feature-owned configuration tabs (the read-only inventory, and plugins such
 *   as the suggested-prompt route card) rather than on the Plugins page, which
 *   is for installing and enabling packages rather than configuring them.
 * - It registers through `configForms.whileServed`, so the page exists only while
 *   the Host actually serves the `lazy-tools` namespace. A deployment that never
 *   mounted the plugin shows no trace of the page.
 *
 * All wiring goes through cordis services (`slots`, `locale`, `configForms`) and
 * the shared primitives package; no cross-plugin value imports are used, which is
 * what the client bundle purity gate requires.
 * @module @deepseek-ai/dsh-lazy-tools/client
 */

import type { Context } from '@deepseek-ai/cordis'

import { LazyToolsController } from './controller.ts'
import { LazyToolsCard } from './page.ts'
// Ambient declarations for the browser services this page uses.
import './contracts.ts'

/**
 * Namespace this page edits: the id of the plugin's own Loader row. Spelled as a
 * literal rather than derived, because the entry id is profile composition, not
 * a value this package can import.
 */
export const LAZY_TOOLS_NS = 'lazy-tools'

/** Dictionary namespace owned by this plugin. */
const NS = 'settings.lazyTools'

/** Services this browser plugin requires. */
export const inject = ['slots', 'locale', 'configForms'] as const

/** Locale copy, keyed by language. */
const en = {
  title: 'Lazy tools',
  description: 'Keep tool schemas out of the context until the model loads them on demand.',
  defer: 'Deferred tools',
  deferHint: 'Comma-separated. A bare name defers that tool; `*` matches any characters, so `Defer(*)` defers everything except the guards. Leave blank to defer nothing.',
  noDefer: 'Always-callable tools',
  noDeferHint: 'Comma-separated. These stay in the model’s tool list even when a `defer` pattern matches them, because `noDefer` wins over `defer`.',
  autoTune: 'Tune from session history',
  autoTuneHint: 'Rank this project’s most-used tools from its own recent sessions and keep those callable, deferring the rest.',
  windowDays: 'History window (days)',
  windowDaysHint: 'How far back the usage ranking looks.',
  topN: 'Tools kept callable',
  topNHint: 'How many of the top-ranked tools auto-tuning keeps directly callable.',
  minSamples: 'Minimum calls before tuning',
  minSamplesHint: 'A project with fewer calls in the window is left on the global configuration rather than tuned on noise.',
  preset: 'This deployment uses the shipped preset.',
  overridden: 'Overridden',
  reset: 'Reset to default',
  readOnly: 'This deployment stores settings read-only.',
  unavailable: 'This plugin is not loaded, so it cannot be configured right now.',
  save: 'Save',
  saving: 'Saving…',
  saveFailed: 'The deployment did not accept these values; they were left for you to correct.',
  invalidNumber: 'Enter a whole number, or leave blank to use the default.',
  invalidEntry: 'Enter tool names or patterns separated by commas.',
}

/** Simplified Chinese copy. */
const zh = {
  title: '懒加载工具',
  description: '在模型按需加载之前，不把工具的定义放进上下文。',
  defer: '延迟加载的工具',
  deferHint: '以逗号分隔。只写名称表示延迟该工具；`*` 匹配任意字符，因此 `Defer(*)` 表示除守卫工具外全部延迟。留空表示不延迟任何工具。',
  noDefer: '始终可调用的工具',
  noDeferHint: '以逗号分隔。即使某条 `defer` 规则命中，这些工具仍保留在模型的工具列表中，因为 `noDefer` 的优先级高于 `defer`。',
  autoTune: '根据会话历史自动调整',
  autoTuneHint: '统计本项目近期会话中最常用的工具，保持其可直接调用，其余延迟加载。',
  windowDays: '历史窗口（天）',
  windowDaysHint: '使用统计向前回溯的天数。',
  topN: '保留可调用的数量',
  topNHint: '自动调整时保留排名前多少位的工具可直接调用。',
  minSamples: '触发调整的最少调用数',
  minSamplesHint: '窗口内调用数不足的项目将沿用全局配置，避免基于噪声调整。',
  preset: '当前使用内置预设。',
  overridden: '已覆盖',
  reset: '恢复默认',
  readOnly: '本部署的设置为只读。',
  unavailable: '该插件当前未加载，暂时无法配置。',
  save: '保存',
  saving: '保存中…',
  saveFailed: '本部署没有接受这些值，已保留供你修改。',
  invalidNumber: '请填整数；留空表示使用默认值。',
  invalidEntry: '请用逗号分隔工具名称或匹配模式。',
}

/** The page's dictionary, as `ctx.locale.register` expects it. */
export const locales = { en, zh }

/**
 * Mount the lazy-tools settings page.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, locales), 'lazy-tools: dictionaries')
  // The page renders whatever React bindings the client exposes; the form model
  // and field specs below are plain classes, so they carry no JSX themselves and
  // can be exercised without a DOM.
  ctx.effect(() => ctx.configForms.whileServed([LAZY_TOOLS_NS], () => registerPage(ctx)), 'lazy-tools: page')
}

/**
 * Build the page's controller and register it into the Plugins list.
 *
 * Kept separate from {@link apply} so the disposer `whileServed` returns is
 * exactly what unregisters the page when the Host stops serving the namespace.
 * @param ctx - the browser plugin context.
 * @returns the disposer removing the page.
 */
function registerPage(ctx: Context): () => void {
  const controller = new LazyToolsController(ctx.configForms.get(LAZY_TOOLS_NS))
  const off = ctx.slots.inject('settings.plugins.tab', () =>
    ctx.slots.register(
      {
        name: 'settings.plugins.tab',
        id: 'lazy-tools',
        order: 40,
        label: () => ctx.locale.bind(NS)('title'),
        locale: NS,
        inject: () => controller.inject(),
      },
      LazyToolsCard as never,
    ),
  )
  return () => {
    off()
    controller.dispose()
  }
}