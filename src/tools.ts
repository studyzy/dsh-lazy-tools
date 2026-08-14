/**
 * Model-facing tool definitions for `tool_search` and `defer_execute_tool`.
 *
 * Both tools are registered per-agent on the agent's own scope, so they stay
 * visible regardless of any `restrict()` filtering (which only affects the
 * inherited layer). They operate on the per-agent state through an injected
 * accessor to keep this module free of agent-lifecycle plumbing.
 * @module @deepseek-ai/dsh-lazy-tools/tools
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolSchema } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { searchSchemas } from './search.ts'

/** Loading outcome for one tool named in a search result. */
export type LoadStatus = 'loaded' | 'already_loaded' | 'unavailable'

/** One ranked match returned by `tool_search`. */
export interface ToolMatch {
  readonly name: string
  readonly description: string
  readonly status: LoadStatus
}

/** State operations `tool_search` / `defer_execute_tool` need from the plugin. */
export interface ToolsAccess {
  /** The full global search catalog (deferred + active schemas). */
  readonly catalog: readonly ToolSchema[]
  /** Tools currently deferred for the calling agent (not yet visible). */
  readonly deferredNames: ReadonlySet<string>
  /** Activate tools for the calling agent; returns the resulting status per name. */
  activate(names: readonly string[]): Map<string, LoadStatus>
}

const RESULT_STATUSES = ['loaded', 'already_loaded', 'unavailable'] as const

/** Render a compact model-facing result; full schemas ride the next request. */
function renderSearch(value: { matches: readonly ToolMatch[]; remainingDeferred: number }): string {
  if (value.matches.length === 0) return 'No matching tools found.'
  const lines = value.matches.map((match) => `- ${match.name}: ${match.status}`)
  return `Tool search results:\n${lines.join('\n')}\nRemaining deferred tools: ${value.remainingDeferred}.`
}

const TEXT = (text: string): ContentBlock => ({ type: 'text', text })

/** Resolve one `ToolSchema` to a renderable match. */
function toMatch(schema: ToolSchema, status: LoadStatus): ToolMatch {
  return { name: schema.name, description: schema.description, status }
}

/** Resolve requested tool names against the catalog, activating each match. */
function activateNames(access: ToolsAccess, names: readonly string[]): Map<string, LoadStatus> {
  const byName = new Map(access.catalog.map((schema) => [schema.name, schema]))
  const valid = names.filter((name) => byName.has(name))
  return access.activate(valid)
}

/**
 * Define the `tool_search` and `defer_execute_tool` tools.
 * @param access - per-agent state operations bound by the plugin.
 * @returns both tool definitions.
 */
export function buildTools(access: ToolsAccess): {
  readonly toolSearch: ReturnType<typeof defineTool>
  readonly deferExecuteTool: ReturnType<typeof defineTool>
} {
  const toolSearch = defineTool({
    name: 'tool_search',
    description:
      'Search tools that are not currently visible. Describe the capability you need (Chinese or English) '
      + 'or name a tool exactly. Matching tools are loaded for the next model request; call them only after '
      + 'this result returns.',
    parameters: {
      queries: {
        type: 'array',
        items: { type: 'string' },
        description: 'Keyword search terms; include both Chinese and English when possible, e.g. ["文件搜索", "file search"].',
      },
      tool_names: {
        type: 'array',
        items: { type: 'string' },
        description: 'Exact tool name(s) to look up. Do NOT use partial names.',
      },
      top_k: {
        type: 'integer',
        description: 'Maximum matches for a keyword query (default 5).',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          matches: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string', required: true },
                description: { type: 'string', required: true },
                status: { type: 'string', required: true, enum: [...RESULT_STATUSES] },
              },
            },
          },
          remainingDeferred: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [TEXT(renderSearch(value))],
    },
    presentCall: (args) => ({
      card: 'generic',
      title: 'Search tools',
      kind: 'search',
      rawInput: args.tool_names?.join(', ') ?? args.queries?.join(', ') ?? '',
    }),
    presentResult: (_args, result) => ({
      card: 'generic',
      title: result.isError ? 'Tool search failed' : 'Tool search results',
      content: result.content,
    }),
    execute: (args) => {
      const tool_names = args.tool_names ?? []
      const queries = args.queries ?? []
      const top_k = args.top_k ?? 5

      const results = new Map<string, LoadStatus>()
      for (const name of tool_names) {
        for (const [activatedName, status] of activateNames(access, [name])) {
          results.set(activatedName, status)
        }
      }
      for (const query of queries) {
        const found = searchSchemas(query, access.catalog, top_k)
        for (const [activatedName, status] of activateNames(access, found)) {
          if (!results.has(activatedName)) results.set(activatedName, status)
        }
      }

      const matches = [...results.entries()]
        .map(([name, status]) => {
          const schema = access.catalog.find((candidate) => candidate.name === name)
          return schema === undefined ? null : toMatch(schema, status)
        })
        .filter((match): match is ToolMatch => match !== null)
      return Promise.resolve({ matches, remainingDeferred: access.deferredNames.size })
    },
  })

  const deferExecuteTool = defineTool({
    name: 'defer_execute_tool',
    description:
      'Activate a deferred tool by exact name so the model can call it directly in the next turn. '
      + 'Use after tool_search, or when you already know the tool name.',
    parameters: {
      toolName: {
        type: 'string',
        required: true,
        description: 'The exact name of the deferred tool to activate, as returned by tool_search.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          toolName: { type: 'string', required: true },
          status: { type: 'string', required: true, enum: [...RESULT_STATUSES] },
        },
      },
      render: (_args, value) => [TEXT(`Tool "${value.toolName}": ${value.status}.`)],
    },
    presentCall: (args) => ({
      card: 'generic',
      title: 'Activate tool',
      kind: 'execute',
      rawInput: args.toolName,
    }),
    presentResult: (_args, result) => ({
      card: 'generic',
      title: result.isError ? 'Tool activation failed' : 'Tool activated',
      content: result.content,
    }),
    execute: (args) => {
      const name = args.toolName
      if (!access.catalog.some((schema) => schema.name === name)) {
        return Promise.resolve({ toolName: name, status: 'unavailable' as const })
      }
      const status = access.activate([name]).get(name) ?? 'unavailable'
      return Promise.resolve({ toolName: name, status })
    },
  })

  return { toolSearch, deferExecuteTool }
}
