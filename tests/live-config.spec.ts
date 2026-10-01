/**
 * Tests that a configuration edit takes effect on a running plugin.
 *
 * This is the behavior the settings page depends on and the one that is easiest
 * to get wrong. Every field of this plugin's Config is `.volatile()`, which the
 * Loader applies by swapping values into the references `apply` already holds —
 * it does NOT remount the plugin. So a plugin that snapshots its config at
 * install keeps running the startup configuration forever, and a save on the
 * settings page silently does nothing until the next restart.
 *
 * These tests pin the other half of that contract: `apply` re-reads through the
 * volatile references, so a save re-ranks the live agents and the next request
 * sees the new patterns.
 *
 * The save is simulated the way the Loader performs it: re-resolve the schema,
 * write the new values into the references the running plugin already holds, and
 * emit `loader/volatile-update`. That is deliberately *not* `fiber.update()`,
 * which restarts the plugin — a restart would mask a plugin that snapshotted its
 * config, which is exactly the bug these cases exist to catch.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Fiber } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { ToolCallId, type JsonValue } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { defineContentToolFixture, type ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import * as LazyTools from '../src/index.ts'
import { type Config } from '../src/index.ts'

/** One monotonically increasing call id, as the other suites use. */
let callOrdinal = 0

/**
 * The write symbol a volatile reference exposes; `Symbol.for` reaches the same
 * entry `@deepseek-ai/cosmokit` uses, which this package does not depend on.
 */
const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write')

/** Contexts torn down after each case, so no listener leaks between tests. */
const contexts: Context[] = []
afterEach(async () => {
  callOrdinal = 0
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

/** Register a fixture tool with a trivial executor. */
function fixture(name: string, description: string) {
  return defineContentToolFixture({
    name,
    description,
    parameters: {},
    async execute() {
      return [{ type: 'text', text: `ran:${name}` }]
    },
  })
}

/**
 * Commit a configuration edit the way a settings-page save does.
 *
 * Mirrors `cordis-plugin-loader`'s volatile commit: validate the new config,
 * copy each changed field into the reference the running plugin holds (no
 * remount), then emit `loader/volatile-update` to the owning fiber.
 * @param ctx - the context whose plugin is being edited.
 * @param plugin - the plugin's fiber, whose live config holds the references.
 * @param next - the new raw configuration.
 */
function settingsSave(ctx: Context, plugin: Fiber, next: Config): void {
  const candidate = (LazyTools.Config as unknown as {
    '~standard': { validate(value: unknown): { value: LiveRefs } }
  })['~standard'].validate(next).value
  const refs = plugin.config as unknown as LiveRefs
  for (const [key, ref] of Object.entries(refs)) {
    const source = candidate[key as keyof LiveRefs]
    if (source === undefined) continue
    ;(ref as Record<symbol, (value: unknown) => void>)[VOLATILE_WRITE](source.get())
  }
  ctx.fiber.ctx.emit(ctx.fiber, 'loader/volatile-update', [])
}

/** The live config references, as the plugin's `apply` receives them. */
type LiveRefs = Record<string, { get(): unknown; [VOLATILE_WRITE](value: unknown): void }>

/**
 * Mount the plugin over a live agent loop.
 * @param config - the plugin's initial configuration.
 * @returns the context, the plugin's fiber, and a factory for live agents.
 */
async function harness(config: Config) {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  const plugin = await ctx.plugin(LazyTools, config)
  return {
    ctx,
    plugin,
    createAgent: () => ctx.agentLoop.create(SessionId('live'), { provider: 'mock', model: 'mock' }),
  }
}

/** Tool names the model would actually be offered on the next request. */
async function offered(ctx: Context, agent: Agent): Promise<string[]> {
  const assembly = await ctx.systemPrompt.assemble({ scope: agent })
  return assembly.tools.map((schema) => schema.name).sort()
}

/** Execute one tool call, for exercising the guard. */
async function execute(ctx: Context, agent: Agent, name: string): Promise<ToolExecutionResult> {
  return await ctx.tools.execute({
    callId: ToolCallId(`live-${(callOrdinal += 1)}-${name}`),
    name,
    arguments: {} as JsonValue,
    agent,
    signal: new AbortController().signal,
  })
}

describe('live configuration edits', () => {
  it('starts from the shipped preset: a coding core stays callable', async () => {
    const { ctx, createAgent } = await harness({})
    for (const name of ['read', 'write', 'bash', 'glob', 'mcp_probe']) ctx.tools.register(fixture(name, name))
    const agent = await createAgent()
    const names = await offered(ctx, agent)
    // The preset's callable core.
    for (const name of ['read', 'write', 'bash', 'glob']) expect(names).toContain(name)
    // The long tail — anything the preset does not name — is withheld until the
    // model asks for it with tool_search.
    expect(names).not.toContain('mcp_probe')
  })

  it('applies a defer edit made while the plugin is running', async () => {
    const { ctx, plugin, createAgent } = await harness({ defer: ['web_search'] })
    for (const name of ['web_search', 'glob']) ctx.tools.register(fixture(name, name))
    const agent = await createAgent()
    expect(await offered(ctx, agent)).not.toContain('web_search')

    settingsSave(ctx, plugin, { defer: ['glob'] })

    const names = await offered(ctx, agent)
    expect(names).not.toContain('glob')
    expect(names).toContain('web_search')
  })

  it('re-ranks live agents without waiting for a registry change', async () => {
    const { ctx, plugin, createAgent } = await harness({ defer: ['glob'] })
    ctx.tools.register(fixture('glob', 'Find files'))
    ctx.tools.register(fixture('read', 'Read a file'))
    const agent = await createAgent()
    // The guard consults the same catalog the assembly is filtered against, so
    // it proves the re-rank landed without assembling again.
    const blocked = await execute(ctx, agent, 'glob')
    expect(JSON.stringify(blocked)).toContain('deferred')

    settingsSave(ctx, plugin, { defer: ['read'] })

    const stillBlocked = await execute(ctx, agent, 'glob')
    expect(JSON.stringify(stillBlocked)).not.toContain('deferred')
    const nowBlocked = await execute(ctx, agent, 'read')
    expect(JSON.stringify(nowBlocked)).toContain('deferred')
  })

  it('turns deferring off entirely through a live edit', async () => {
    const { ctx, plugin, createAgent } = await harness({ defer: ['glob'] })
    ctx.tools.register(fixture('glob', 'Find files'))
    const agent = await createAgent()
    expect(await offered(ctx, agent)).not.toContain('glob')

    // "Off" is an empty list rather than a separate switch: it is exactly the
    // edit the "Deferred tools" box makes when the operator clears it.
    settingsSave(ctx, plugin, { defer: [] })
    expect(await offered(ctx, agent)).toContain('glob')
  })

  it('honors an explicit empty defer list over the shipped preset', async () => {
    const { ctx, createAgent } = await harness({ defer: [] })
    for (const name of ['glob', 'mcp_probe']) ctx.tools.register(fixture(name, name))
    const agent = await createAgent()
    const names = await offered(ctx, agent)
    // Naming `defer` replaces the preset, so `defer: []` means "defer nothing".
    expect(names).toContain('glob')
    expect(names).toContain('mcp_probe')
  })
it('round-trips a save through the settings plane into the model-facing list', async () => {
    const { ctx, plugin, createAgent } = await harness({ defer: ['Defer(*)'], noDefer: ['bash'] })
    for (const name of ['bash', 'glob', 'web_fetch', 'mcp_probe']) ctx.tools.register(fixture(name, name))
    const agent = await createAgent()

    const before = await offered(ctx, agent)
    expect(before).toContain('bash')
    expect(before).not.toContain('glob')

    // Operator edits the "Always-callable tools" box to add glob + web_fetch.
    settingsSave(ctx, plugin, { defer: ['Defer(*)'], noDefer: ['bash', 'glob', 'web_fetch'] })

    const after = await offered(ctx, agent)
    expect(after).toContain('glob')
    expect(after).toContain('web_fetch')
    expect(after).not.toContain('mcp_probe')
  })

  it('round-trips clearing the defer list through the settings plane', async () => {
    const { ctx, plugin, createAgent } = await harness({ defer: ['Defer(*)'] })
    for (const name of ['bash', 'mcp_probe']) ctx.tools.register(fixture(name, name))
    const agent = await createAgent()
    expect(await offered(ctx, agent)).not.toContain('mcp_probe')

    // Clearing the box stages a clear of the key, which re-inherits the shipped
    // preset; writing an explicit empty list is the other way to stop deferring.
    settingsSave(ctx, plugin, { defer: [] })
    expect(await offered(ctx, agent)).toContain('mcp_probe')
  })
})
