import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Fiber } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { CallId } from '@deepseek-ai/dsh-llm'
import { SessionId, type JsonValue } from '@deepseek-ai/dsh-session'
import { defineContentToolFixture, type ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import * as LazyTools from '../src/index.ts'
import { DEFER_EXECUTE_TOOL_NAME, TOOL_SEARCH_NAME, type Config } from '../src/index.ts'

const contexts: Context[] = []
const signal = new AbortController().signal
let callOrdinal = 0

afterEach(async () => {
  callOrdinal = 0
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

function fixture(name: string, description: string) {
  return defineContentToolFixture({
    name,
    description,
    parameters: {},
    async execute() { return [{ type: 'text', text: `ran:${name}` }] },
  })
}

async function harness(config: Config = {}): Promise<{ ctx: Context; plugin: Fiber }> {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  const plugin = await ctx.plugin(LazyTools, config)
  return { ctx, plugin }
}

function createAgent(ctx: Context, id: string): Agent {
  return ctx.agentLoop.create(SessionId(id), { provider: 'mock', model: 'mock' })
}

async function execute(
  ctx: Context,
  agent: Agent,
  name: string,
  args: JsonValue,
): Promise<ToolExecutionResult> {
  callOrdinal += 1
  return await ctx.tools.execute({
    callId: CallId(`lazy-tools-${callOrdinal}`),
    name,
    arguments: args,
    agent,
    signal,
  })
}

function schemaNames(ctx: Context, agent: Agent): string[] {
  return ctx.tools.schemas(agent).map(schema => schema.name).sort()
}

describe('deferred tool loading', () => {
  it('hides deferred globals and blocks a direct call with a hint', async () => {
    const { ctx } = await harness({ defer: ['glob'] })
    ctx.tools.register(fixture('read_file', 'Read a local file'))
    ctx.tools.register(fixture('glob', 'Find files by pattern'))
    const agent = createAgent(ctx, 'hidden')

    expect(schemaNames(ctx, agent)).toEqual(
      ['read_file', TOOL_SEARCH_NAME, DEFER_EXECUTE_TOOL_NAME].sort(),
    )
    const blocked = await execute(ctx, agent, 'glob', {})
    expect(blocked.isError).toBe(true)
    if (!blocked.isError) throw new Error('expected blocked direct call')
    expect(blocked.error.message).toMatch(/deferred and not yet loaded/)
  })

  it('loads a tool via tool_search and makes it callable on the next request', async () => {
    const { ctx } = await harness({ defer: ['glob'] })
    ctx.tools.register(fixture('read_file', 'Read a local file'))
    ctx.tools.register(fixture('glob', 'Find files by pattern'))
    const agent = createAgent(ctx, 'search')

    const found = await execute(ctx, agent, TOOL_SEARCH_NAME, { tool_names: ['glob'] })
    expect(found.isError ? undefined : found.value).toMatchObject({
      matches: [{ name: 'glob', status: 'loaded' }],
    })
    expect(schemaNames(ctx, agent)).toEqual(['glob', 'read_file', TOOL_SEARCH_NAME, DEFER_EXECUTE_TOOL_NAME].sort())
    const ran = await execute(ctx, agent, 'glob', {})
    expect(ran.isError).toBe(false)
  })

  it('activates a deferred tool by name via defer_execute_tool', async () => {
    const { ctx } = await harness({ defer: ['glob'] })
    ctx.tools.register(fixture('glob', 'Find files by pattern'))
    const agent = createAgent(ctx, 'activate')

    const activated = await execute(ctx, agent, DEFER_EXECUTE_TOOL_NAME, { toolName: 'glob' })
    expect(activated.isError ? undefined : activated.value).toMatchObject({
      toolName: 'glob',
      status: 'loaded',
    })
    expect(schemaNames(ctx, agent)).toContain('glob')
    const ran = await execute(ctx, agent, 'glob', {})
    expect(ran.isError).toBe(false)
  })

  it('marks a tool unavailable when an independent restriction denies it', async () => {
    const { ctx } = await harness({ defer: ['Defer(*)'] })
    ctx.tools.register(fixture('public_lookup', 'Find public records'))
    ctx.tools.register(fixture('secret_lookup', 'Find private secret records'))
    const handle = await ctx.agents.create({
      sessionId: SessionId('filtered'),
      agentOptions: { provider: 'mock', model: 'mock' },
      setup(agentCtx) { agentCtx.tools.restrict({ deny: ['secret_lookup'] }) },
    })

    const found = await execute(ctx, handle.agent, TOOL_SEARCH_NAME, { tool_names: ['secret_lookup'] })
    expect(found.isError ? undefined : found.value).toMatchObject({
      matches: [{ name: 'secret_lookup', status: 'unavailable' }],
    })
    expect(schemaNames(ctx, handle.agent)).not.toContain('secret_lookup')
    await handle.dispose()
  })

  it('admits late global tools through a tools/change re-rank', async () => {
    const { ctx } = await harness({ defer: ['mcp_*'] })
    ctx.tools.register(fixture('read_file', 'Read a local file'))
    const agent = createAgent(ctx, 'late')

    ctx.tools.register(fixture('mcp_late', 'Late MCP-style remote capability'))
    const found = await execute(ctx, agent, TOOL_SEARCH_NAME, { tool_names: ['mcp_late'] })
    expect(found.isError ? undefined : found.value).toMatchObject({
      matches: [{ name: 'mcp_late', status: 'loaded' }],
    })
    expect(schemaNames(ctx, agent)).toContain('mcp_late')
  })

  it('noDefer keeps a tool active under Defer(*)', async () => {
    const { ctx } = await harness({ defer: ['Defer(*)'], noDefer: ['bash'] })
    ctx.tools.register(fixture('bash', 'Run a shell command'))
    ctx.tools.register(fixture('glob', 'Find files by pattern'))
    const agent = createAgent(ctx, 'nodefer')

    expect(schemaNames(ctx, agent)).toContain('bash')
    expect(schemaNames(ctx, agent)).not.toContain('glob')
    const ran = await execute(ctx, agent, 'bash', {})
    expect(ran.isError).toBe(false)
  })

  it('deferToolLoading=false leaves every tool visible', async () => {
    const { ctx } = await harness({ defer: ['Defer(*)'], deferToolLoading: false })
    ctx.tools.register(fixture('glob', 'Find files by pattern'))
    const agent = createAgent(ctx, 'disabled')

    expect(schemaNames(ctx, agent)).toContain('glob')
    const ran = await execute(ctx, agent, 'glob', {})
    expect(ran.isError).toBe(false)
  })

  it('an empty defer config installs no allow-list, so late tools stay visible', async () => {
    // No `defer` entry: the plugin must not call `restrict({ allow: [] })`, which
    // would hide every tool — including tools registered after the agent.
    const { ctx } = await harness({ defer: [] })
    ctx.tools.register(fixture('read_file', 'Read a local file'))
    const agent = createAgent(ctx, 'no-defer')

    ctx.tools.register(fixture('mcp_late', 'Late-registered capability'))
    expect(schemaNames(ctx, agent)).toContain('read_file')
    expect(schemaNames(ctx, agent)).toContain('mcp_late')
  })

  it('guard tools are never deferred even under Defer(*)', async () => {
    const { ctx } = await harness({ defer: ['Defer(*)'] })
    const agent = createAgent(ctx, 'guards')

    expect(schemaNames(ctx, agent)).toContain(TOOL_SEARCH_NAME)
    expect(schemaNames(ctx, agent)).toContain(DEFER_EXECUTE_TOOL_NAME)
  })

  it('hot-loads existing agents and restores the original surface on plugin disposal', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    ctx.tools.register(fixture('read_file', 'Read a local file'))
    ctx.tools.register(fixture('glob', 'Find files by pattern'))
    const agent = createAgent(ctx, 'hot-load')
    expect(schemaNames(ctx, agent)).toEqual(['glob', 'read_file'])

    const plugin = await ctx.plugin(LazyTools, { defer: ['glob'] })
    expect(schemaNames(ctx, agent)).not.toContain('glob')
    await plugin.dispose()
    expect(schemaNames(ctx, agent)).toEqual(['glob', 'read_file'])
  })

  it('handles duplicate lifecycle notifications and an already-uninstalled agent', async () => {
    const { ctx } = await harness({ defer: ['glob'] })
    ctx.tools.register(fixture('glob', 'Find files by pattern'))
    const agent = createAgent(ctx, 'duplicate')
    expect(() => { ctx.emit('agent/created', { agent }) }).not.toThrow()
    ctx.emit('agent/disposed', { agent })
    expect(schemaNames(ctx, agent)).toContain('glob')
    expect(() => { ctx.emit('agent/disposed', { agent }) }).not.toThrow()
  })
})
