/**
 * dsh-lazy-tools: CodeBuddy-style deferred tool loading for DeepSeek Harness.
 *
 * A pure exposure-control plugin: it keeps deferred tools out of the tool list
 * the MODEL sees, and lets the model re-discover them on demand via
 * `tool_search` (keyword or exact-name lookup) or activate one by name via
 * `defer_execute_tool`. A `tools/pre-execute` listener blocks direct calls to
 * not-yet-loaded deferred tools with a pointer back to the search tools.
 *
 * Hiding happens on the one list that actually reaches the model: the
 * per-scope value of the `system-prompt/assemble` waterfall, which the agent
 * loop turns into the request header and the provider's tool declarations.
 * The plugin therefore never mutates the tool registry, and it does not care
 * WHERE a tool comes from — the host composition, a per-session agent preset,
 * an MCP server, or a plugin registering late. That distinction is the whole
 * point on the Web/Desktop surfaces, where every model-facing tool is mounted
 * by an agent preset into the session's scope rather than into the global
 * layer: a global-registry view reads zero model-facing tools there, so
 * registry-side filtering would silently defer nothing.
 *
 * This plugin does NOT own or implement any deferred tool. Deferred tools are
 * ordinary registry tools; the plugin only observes their schemas in the
 * assembly for discovery. Works with any model/provider — it is purely
 * agent-layer.
 *
 * A **zero-config install is useful out of the box**: the shipped preset defers
 * the long tail and keeps a coding core callable — `read`, `write`, `edit`,
 * `bash`, `glob`, `grep`, `web_search`, `web_fetch`, `ask_user_question`,
 * `skill`, plus the search/execute guards. Configuration is only needed to
 * change that default (CodeBuddy semantics, precedence noDefer > defer >
 * deferToolLoading):
 *
 * ```yaml
 * - id: lazy-tools
 *   name: '@deepseek-ai/dsh-lazy-tools'
 *   config:
 *     defer: ['Defer(fetch_*)', 'web_search']
 *     noDefer: ['bash']
 *     deferToolLoading: true
 * ```
 *
 * Naming either `defer` or `noDefer` replaces the preset entirely, so
 * `defer: []` keeps its meaning of "defer nothing".
 *
 * **Auto-tuning** (on by default) additionally derives a **per-project**
 * configuration from that project's own session history: the first session that
 * reports a working directory triggers one scan of the last 30 days of that
 * project's `tool/call` events, and the top 20 tools by use become the active
 * set while everything else is deferred. `defer_execute_tool` arguments count as
 * usage of the tool they activate, so a repeatedly-activated tool promotes
 * itself out of the deferred set. A project with fewer than 200 in-window calls
 * is left untouched rather than tuned on noise, and a ranking that already
 * matches the stored override is not rewritten. Set `autoTune: false` to opt
 * out.
 *
 * Configuration resolves in two layers: **project override > global config**.
 * The `defer`/`noDefer` you write here is the global rule, honored by every
 * project; a project that auto-tuning has measured gets its own override in
 * `~/.dsh/lazy-tools/projects.json`, which replaces the pattern pair for that
 * project only. Hand-written global rules are therefore never clobbered by a
 * scan of some other repository.
 * @module @deepseek-ai/dsh-lazy-tools
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolSchema } from '@deepseek-ai/dsh-llm'
import type { AssembleContext, PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import z from '@deepseek-ai/schemastery'
import { applyDefaultPreset, resolveDeferConfig, type LazyToolsConfig } from './config.ts'
import { buildTools, type LoadStatus, type ToolsAccess } from './tools.ts'
import { autoTune, describeOutcome, resolveAutoTuneOptions, type AutoTuneOptions } from './autotune.ts'
import { applyProjectOverride, readProjectOverride, readStoreSync } from './project-config.ts'
import { DEFAULT_MIN_SAMPLES, DEFAULT_TOP_N, DEFAULT_WINDOW_DAYS } from './history.ts'

/** Cordis plugin name. */
export const name = 'lazy-tools'
/** Services required to install a lazy surface on every live agent. */
export const inject = ['agents', 'tools']

/** Model-facing discovery and activation tool names. */
export const TOOL_SEARCH_NAME = 'tool_search'
export const DEFER_EXECUTE_TOOL_NAME = 'defer_execute_tool'

/** Plugin config surface (validated by schemastery). */
export interface Config {
  /** Tool names / `Defer(pattern)` entries to defer. Bare names = `Defer(name)`. */
  defer?: string[]
  /** Tool names / `NoDefer(pattern)` entries that must stay active. */
  noDefer?: string[]
  /** Global switch; false disables all deferring. Default true. */
  deferToolLoading?: boolean
  /** Tune `defer`/`noDefer` from this project's session history. Default true. */
  autoTune?: boolean
  /** Days of history the auto-tune ranking covers. Default 30. */
  autoTuneWindowDays?: number
  /** How many top-ranked tools auto-tune keeps active. Default 20. */
  autoTuneTopN?: number
  /** In-window calls a project needs before auto-tune rewrites anything. Default 200. */
  autoTuneMinSamples?: number
}

/** Schemastery validation and defaults for {@link Config}. */
export const Config: z<Config> = z.object({
  // `default(undefined)` keeps an absent key absent instead of materializing it
  // as `[]`, which is what lets apply() tell "unconfigured" from an explicit
  // `defer: []` ("defer nothing"). The cast covers a default the typings do not
  // model; the key is simply absent at runtime.
  defer: z.array(z.string()).default(undefined as unknown as string[]),
  noDefer: z.array(z.string()).default(undefined as unknown as string[]),
  deferToolLoading: z.boolean().default(true),
  autoTune: z.boolean().default(true),
  autoTuneWindowDays: z.number().default(DEFAULT_WINDOW_DAYS),
  autoTuneTopN: z.number().default(DEFAULT_TOP_N),
  autoTuneMinSamples: z.number().default(DEFAULT_MIN_SAMPLES),
})

/** Render one thrown value for a log line. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** One agent's owned tools, catalog, and search state. */
interface AgentState {
  readonly agent: Agent
  /** Schemas the last assembly offered this scope — deferred ones included. */
  catalog: ToolSchema[]
  /** Catalog names still withheld from the model (patterns minus activations). */
  deferredNames: Set<string>
  /** Names this agent activated; they stay offered across assemblies. */
  readonly activated: Set<string>
  removePreExecute: (() => void) | undefined
  removeTools: (() => void)[]
}

/**
 * Install per-agent lazy tool loading for every current and future agent.
 * @param ctx - plugin context carrying the agent and tool registries.
 * @param config - deferred-tool visibility patterns.
 */
export function apply(ctx: Context, config: Config): void {
  /** The operator's global configuration; the base for every project. */
  const globalConfig: LazyToolsConfig = applyDefaultPreset(config)
  const states = new Map<Agent, AgentState>()
  const home = ctx.get('profileContext')?.home
  const autoTuneOptions: AutoTuneOptions = resolveAutoTuneOptions(config, home)

  /**
   * Per-project configuration in force for this process, keyed by the session's
   * absolute working directory. An entry is present only for a project that has
   * an override on disk; every other project resolves to the global config.
   *
   * The store is read once at install so the first request of a session already
   * honors an existing override. A project tuned later in this same process is
   * refreshed after its write lands, so the new patterns take effect from the
   * next request rather than needing a restart.
   */
  const projectConfigs = new Map<string, LazyToolsConfig>()

  /** Resolve the configuration that applies to one agent's project. */
  function configFor(agent: Agent): LazyToolsConfig {
    const cwd = agent.session?.header.cwd
    if (cwd === undefined) return globalConfig
    return projectConfigs.get(cwd) ?? globalConfig
  }

  /**
   * Load every project override before the first session can be created. This
   * runs synchronously at install so an existing override is already in force
   * for a session's very first request — a partial read on the request path
   * would silently fall back to the global configuration instead.
   *
   * A missing or unreadable store is not an error: it just means every project
   * uses the global configuration.
   */
  try {
    const store = readStoreSync(home)
    for (const [cwd, override] of Object.entries(store.projects)) {
      projectConfigs.set(cwd, applyProjectOverride(globalConfig, override))
    }
  } catch (error: unknown) {
    ctx.logger.warn(`lazy-tools: could not read project overrides (${errorMessage(error)}); using the global configuration`)
  }

  /**
   * Projects already tuned by this process. Auto-tuning runs at most once per
   * project: the first session that reports a working directory supplies the
   * project, and later sessions — including a `cwd` change — are not re-mined.
   * The promise is memoized before it settles so concurrent first sessions
   * cannot both start a scan.
   */
  const tunedProjects = new Map<string, Promise<void>>()

  /**
   * Mine one project's history and persist the resulting per-project override.
   *
   * Auto-tuning is a background optimization on the startup path, so every
   * failure is contained: it is logged and the project keeps using the global
   * configuration.
   * @param cwd - the project working directory reported by a session.
   */
  function tuneProject(cwd: string): void {
    const existing = tunedProjects.get(cwd)
    if (existing !== undefined) return
    const run = (async (): Promise<void> => {
      try {
        const outcome = await autoTune(ctx, cwd, autoTuneOptions)
        ctx.logger.info(describeOutcome(outcome, autoTuneOptions.topN))
        if (outcome.kind !== 'applied') return
        // Re-read so the override this scan just wrote takes effect without a
        // restart, and re-rank every agent already sitting in this project.
        const override = await readProjectOverride(cwd, home)
        if (override === undefined) return
        projectConfigs.set(cwd, applyProjectOverride(globalConfig, override))
        for (const state of states.values()) {
          if (state.agent.session?.header.cwd !== cwd) continue
          try {
            rankFromRegistry(state)
          } catch (error: unknown) {
            ctx.logger.warn(`lazy-tools: re-rank after auto-tune failed (${errorMessage(error)}); keeping the previous catalog`)
          }
        }
      } catch (error: unknown) {
        ctx.logger.warn(`lazy-tools: auto-tune failed (${errorMessage(error)}); keeping the current configuration`)
      }
    })()
    tunedProjects.set(cwd, run)
  }

  /** Start auto-tuning for one agent's project, once per project. */
  function tuneForAgent(agent: Agent): void {
    if (!autoTuneOptions.enabled) return
    const cwd = agent.session?.header.cwd
    if (cwd !== undefined) tuneProject(cwd)
  }

  /**
   * Re-rank one agent against a freshly assembled tool list. The catalog
   * becomes exactly what the registry offers this scope — whatever plane
   * registered it — and the defer patterns in force for THIS agent's project
   * are re-applied over its names with the guards and this agent's prior
   * activations excluded.
   */
  function rank(state: AgentState, schemas: readonly ToolSchema[]): void {
    state.catalog = [...schemas]
    const { deferNames } = resolveDeferConfig(
      state.catalog.map((schema) => schema.name),
      configFor(state.agent),
    )
    state.deferredNames = new Set([...deferNames].filter((name) => !state.activated.has(name)))
  }

  /** Re-rank one agent from its live registry view — host plane and ancestor planes. */
  function rankFromRegistry(state: AgentState): void {
    rank(state, ctx.tools.schemas(state.agent))
  }

  /** Build the per-agent {@link ToolsAccess} the two tools consume. */
  function buildAccess(state: AgentState): ToolsAccess {
    return {
      get catalog() { return state.catalog },
      get deferredNames() { return state.deferredNames },
      activate(names) {
        const statuses = new Map<string, LoadStatus>()
        const known = new Set(state.catalog.map((schema) => schema.name))
        for (const name of names) {
          if (!known.has(name)) {
            statuses.set(name, 'unavailable')
            continue
          }
          if (state.deferredNames.has(name)) {
            state.activated.add(name)
            state.deferredNames.delete(name)
            statuses.set(name, 'loaded')
            continue
          }
          statuses.set(name, 'already_loaded')
        }
        return statuses
      },
    }
  }

  /** Attach search/execute tools and the call guard to one live agent. */
  function install(agent: Agent): void {
    if (states.has(agent)) return
    const state: AgentState = {
      agent,
      catalog: [],
      deferredNames: new Set(),
      activated: new Set(),
      removePreExecute: undefined,
      removeTools: [],
    }
    states.set(agent, state)
    try {
      const access = buildAccess(state)
      const tools = buildTools(access)
      state.removeTools = [
        agent.ctx.tools.register(tools.toolSearch),
        agent.ctx.tools.register(tools.deferExecuteTool),
      ]
      rankFromRegistry(state)
      // Block direct calls to not-yet-loaded deferred tools with a hint.
      state.removePreExecute = agent.ctx.on('tools/pre-execute', (exec, next) => {
        const toolName = exec.name
        if (toolName === TOOL_SEARCH_NAME || toolName === DEFER_EXECUTE_TOOL_NAME) return next()
        if (state.deferredNames.has(toolName)) {
          return Promise.resolve({
            kind: 'deny',
            reason: `Tool "${toolName}" is deferred and not yet loaded. Call tool_search with tool_names: ["${toolName}"] first, or use defer_execute_tool to activate it.`,
          })
        }
        return next()
      })
    } catch (error: unknown) {
      states.delete(agent)
      for (const remove of state.removeTools) remove()
      state.removePreExecute?.()
      throw error
    }
  }

  /** Lift every registration owned for one exact agent. */
  function uninstall(agent: Agent): void {
    const state = states.get(agent)
    if (state === undefined) return
    states.delete(agent)
    for (const remove of state.removeTools) remove()
    state.removePreExecute?.()
  }

  /**
   * Withhold this scope's deferred tools from the model. The waterfall value is
   * authoritative for the request, so filtering here is the whole hiding
   * mechanism — and because the assembly is rebuilt per step, this same hook is
   * what re-ranks the catalog when the registry changes.
   *
   * Fail-open by design: this listener sits on the request path, so a defect in
   * it must degrade to "every tool offered", never to a failed model request.
   */
  ctx.on('system-prompt/assemble', async (assembly: PromptAssembly, context: AssembleContext) => {
    try {
      const scope = context.scope
      const state = scope === undefined ? undefined : states.get(scope as Agent)
      if (state === undefined) return assembly
      rank(state, assembly.tools)
      const offered = assembly.tools.filter((schema) => !state.deferredNames.has(schema.name))
      return offered.length === assembly.tools.length ? assembly : { ...assembly, tools: offered }
    } catch (error: unknown) {
      ctx.logger.warn(`lazy-tools: assembly filtering failed (${errorMessage(error)}); offering every tool for this request`)
      return assembly
    }
  })
  ctx.on('agent/created', ({ agent }) => {
    install(agent)
    tuneForAgent(agent)
  })
  ctx.on('agent/disposed', ({ agent }) => { uninstall(agent) })
  // Keep the guard and the search catalog current between assemblies — a tool
  // mounted by a preset or an MCP server does not wait for the next request.
  // A failure here must not break the registry mutation that notified us.
  ctx.on('tools/change', () => {
    for (const state of states.values()) {
      try {
        rankFromRegistry(state)
      } catch (error: unknown) {
        ctx.logger.warn(`lazy-tools: re-rank failed (${errorMessage(error)}); keeping the previous catalog`)
      }
    }
  })
  for (const agent of ctx.agents.list()) {
    install(agent)
    tuneForAgent(agent)
  }
  ctx.effect(() => () => {
    for (const agent of states.keys()) uninstall(agent)
  }, 'lazy-tools: per-agent registrations')
}
