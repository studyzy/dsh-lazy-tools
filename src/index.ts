/**
 * dsh-lazy-tools: CodeBuddy-style deferred tool loading for DeepSeek Harness.
 *
 * A pure exposure-control plugin: it decides which global tools are deferred
 * (kept out of the model's visible schema set via a per-agent `restrict()`),
 * and lets the model re-discover them on demand via `tool_search` (keyword or
 * exact-name lookup) or activate one by name via `defer_execute_tool`. A
 * `tools/pre-execute` listener blocks direct calls to not-yet-loaded deferred
 * tools with a pointer back to the search tools.
 *
 * This plugin does NOT own or implement any deferred tool. Deferred tools are
 * global-registry tools; the plugin only holds their schemas for discovery.
 * Works with any model/provider — it is purely agent-layer.
 *
 * Configuration (CodeBuddy semantics, precedence noDefer > defer >
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
 * @module @deepseek-ai/dsh-lazy-tools
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolSchema } from '@deepseek-ai/dsh-llm'
import z from '@deepseek-ai/schemastery'
import { resolveDeferConfig, type LazyToolsConfig } from './config.ts'
import { buildTools, type LoadStatus, type ToolsAccess } from './tools.ts'

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
}

/** Schemastery validation and defaults for {@link Config}. */
export const Config: z<Config> = z.object({
  defer: z.array(z.string()).default([]),
  noDefer: z.array(z.string()).default([]),
  deferToolLoading: z.boolean().default(true),
})

/** One agent's owned restriction, tools, and search catalog. */
interface AgentState {
  readonly agent: Agent
  catalog: ToolSchema[]
  deferredNames: Set<string>
  activeNames: Set<string>
  liftRestriction: (() => void) | undefined
  removePreExecute: (() => void) | undefined
  removeTools: (() => void)[]
}

/**
 * Install per-agent lazy tool loading for every current and future agent.
 * @param ctx - plugin context carrying agent and tool registries.
 * @param config - deferred-tool visibility patterns.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved: LazyToolsConfig = {
    defer: config.defer ?? [],
    noDefer: config.noDefer ?? [],
    deferToolLoading: config.deferToolLoading ?? true,
  }
  const states = new Map<Agent, AgentState>()
  // Distinguish plugin-initiated registry mutations from external ones so
  // `tools/change` re-ranks only on genuine external changes.
  let registryMutationDepth = 0

  /** Run a registry mutation without treating its own `tools/change` as external. */
  function mutateRegistry<T>(operation: () => T): T {
    registryMutationDepth += 1
    try {
      return operation()
    } finally {
      registryMutationDepth -= 1
    }
  }

  /** Current global schemas keyed by callable name. */
  function globalSchemas(): ToolSchema[] {
    return ctx.tools.schemas()
  }

  /** Global tool names visible to this agent after all independent restrictions. */
  function visibleNames(agent: Agent): Set<string> {
    return new Set(ctx.tools.schemas(agent).map((schema) => schema.name))
  }

  /** Recompute the search catalog and deferred/active name sets for one agent. */
  function refreshCatalog(state: AgentState): void {
    const globals = globalSchemas()
    state.catalog = globals
    const names = globals.map((schema) => schema.name)
    const resolvedSet = resolveDeferConfig(names, resolved)
    state.deferredNames = new Set(resolvedSet.deferNames)
    state.activeNames = new Set(
      names.filter((name) => !(resolvedSet.deferNames as Set<string>).has(name)),
    )
  }

  /**
   * Replace only this plugin's restriction, installing before lifting to avoid
   * an open interval. When nothing is deferred there is no allow-list to
   * install: an empty `defer` config must leave every tool visible, and a
   * stale restriction from a previous catalog generation is lifted. This also
   * covers surfaces where the global registry is empty at assembly time (the
   * Web preset plane registers model-facing tools in ancestor scopes, so
   * `ctx.tools.schemas()` reads zero) — without it, an empty `activeNames`
   * would install `restrict({ allow: [] })` and hide every tool.
   */
  function refreshRestriction(state: AgentState): void {
    const liftPrevious = state.liftRestriction
    state.liftRestriction = undefined
    if (liftPrevious !== undefined) mutateRegistry(liftPrevious)
    if (state.deferredNames.size === 0) return
    const allow = [...state.activeNames].sort()
    const liftNext = mutateRegistry(() => state.agent.ctx.tools.restrict({ allow }))
    state.liftRestriction = liftNext
  }

  /** Build the per-agent {@link ToolsAccess} the two tools consume. */
  function buildAccess(state: AgentState): ToolsAccess {
    return {
      get catalog() { return state.catalog },
      get deferredNames() { return state.deferredNames },
      activate(names) {
        const statuses = new Map<string, LoadStatus>()
        const before = state.activeNames
        const toActivate = names.filter((name) => before.has(name) === false)
        if (toActivate.length > 0) {
          const next = new Set(before)
          for (const name of toActivate) next.add(name)
          state.activeNames = next
          refreshRestriction(state)
        }
        const after = visibleNames(state.agent)
        for (const name of names) {
          if (!after.has(name)) statuses.set(name, 'unavailable')
          else statuses.set(name, before.has(name) ? 'already_loaded' : 'loaded')
        }
        return statuses
      },
    }
  }

  /** Attach search/execute tools, restriction, and call guard to one live agent. */
  function install(agent: Agent): void {
    if (states.has(agent)) return
    const state: AgentState = {
      agent,
      catalog: [],
      deferredNames: new Set(),
      activeNames: new Set(),
      liftRestriction: undefined,
      removePreExecute: undefined,
      removeTools: [],
    }
    states.set(agent, state)
    try {
      refreshCatalog(state)
      const access = buildAccess(state)
      const tools = buildTools(access)
      state.removeTools = [
        mutateRegistry(() => agent.ctx.tools.register(tools.toolSearch)),
        mutateRegistry(() => agent.ctx.tools.register(tools.deferExecuteTool)),
      ]
      refreshRestriction(state)
      // Block direct calls to not-yet-loaded deferred tools with a hint.
      state.removePreExecute = agent.ctx.on('tools/pre-execute', (exec, next) => {
        const toolName = exec.name
        if (toolName === TOOL_SEARCH_NAME || toolName === DEFER_EXECUTE_TOOL_NAME) return next()
        if (state.activeNames.has(toolName)) return next()
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
      mutateRegistry(() => {
        for (const remove of state.removeTools) remove()
        state.liftRestriction?.()
      })
      throw error
    }
  }

  /** Lift every registration owned for one exact agent. */
  function uninstall(agent: Agent): void {
    const state = states.get(agent)
    if (state === undefined) return
    states.delete(agent)
    mutateRegistry(() => {
      for (const remove of state.removeTools) remove()
      state.liftRestriction?.()
      state.removePreExecute?.()
    })
  }

  ctx.on('agent/created', ({ agent }) => { install(agent) })
  ctx.on('agent/disposed', ({ agent }) => { uninstall(agent) })
  ctx.on('tools/change', () => {
    if (registryMutationDepth > 0) return
    for (const state of states.values()) {
      refreshCatalog(state)
      refreshRestriction(state)
    }
  })
  for (const agent of ctx.agents.list()) install(agent)
  ctx.effect(() => () => {
    for (const agent of states.keys()) uninstall(agent)
  }, 'lazy-tools: per-agent registrations')
}
