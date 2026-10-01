import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Fiber } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import * as LazyTools from '../src/index.ts'
import { projectKey } from '../src/history.ts'
import { autoTune } from '../src/autotune.ts'
import { readProjectOverride, readStore, storePath, writeProjectOverride } from '../src/project-config.ts'

const contexts: Context[] = []
const tempDirs: string[] = []
const DAY = 24 * 60 * 60 * 1000
const CWD = '/Users/dev/autotune-project'

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lazy-tools-int-'))
  tempDirs.push(dir)
  return dir
}

/**
 * Persist one session exactly as the jsonl backend would: a header line plus
 * `tool/call` events, written as a multi-frame compressed artifact.
 */
function seedSession(
  home: string,
  id: string,
  calls: ReadonlyArray<readonly [string, number]>,
  cwd: string = CWD,
): void {
  const dir = join(home, 'sessions', projectKey(cwd), `session-${id}`)
  mkdirSync(dir, { recursive: true })
  const lines = [JSON.stringify({ type: 'session', version: 4, id, cwd })]
  for (const [name, count] of calls) {
    for (let i = 0; i < count; i++) {
      lines.push(JSON.stringify({
        type: 'tool/call', seq: i, time: Date.now() - DAY,
        data: { turn: 1, step: 1, callId: `${name}-${i}`, name, arguments: '{}' },
      } satisfies SessionEvent))
    }
  }
  writeFileSync(join(dir, 'session.v4.jsonl.zstd'), zstdCompressSync(Buffer.from(`${lines.join('\n')}\n`)))
}

/**
 * Mount the plugin over a seeded project history, exposing the harness home.
 *
 * `seed` runs before the plugin installs, so anything it writes to the store —
 * project overrides included — is present when the plugin loads it, exactly as
 * after a DSH restart.
 */
async function harness(
  seed: (home: string) => void | Promise<void>,
  config: Record<string, unknown> = {},
): Promise<{ ctx: Context; plugin: Fiber; home: string }> {
  const home = tempHome()
  await seed(home)
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.provide('profileContext', { home })

  const plugin = await ctx.plugin(LazyTools, { ...config, autoTuneWindowDays: 30 })
  return { ctx, plugin, home }
}

/** Wait until `check` holds, e.g. an override has been persisted. */
async function settle(check: () => boolean | Promise<boolean>, ticks = 80): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    if (await check()) return
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

/** Create one agent in a project, as the Web/API path does. */
async function startSession(ctx: Context, id: string, cwd: string = CWD) {
  return await ctx.agentLoop.create(SessionId(id), { provider: 'mock', model: 'mock' }, { cwd })
}

describe('auto-tune integration', () => {
  it('records a per-project override when a session starts', async () => {
    const { ctx, home } = await harness(h => {
      seedSession(h, 'a', [['bash', 210], ['read', 30]])
    })

    await startSession(ctx, 'autotune-1')
    await settle(async () => (await readProjectOverride(CWD, home)) !== undefined)

    expect(await readProjectOverride(CWD, home))
      .toMatchObject({ defer: ['Defer(*)'], noDefer: ['bash', 'read'] })
  })

  it('never writes the global profile configuration', async () => {
    const { ctx, home } = await harness(h => {
      seedSession(h, 'a', [['bash', 210], ['read', 30]])
    })

    await startSession(ctx, 'no-profile-write')
    await settle(async () => (await readProjectOverride(CWD, home)) !== undefined)

    // The store is the only thing auto-tuning is allowed to touch.
    const store = await readStore(home)
    expect(Object.keys(store.projects)).toEqual([CWD])
  })

  it('tunes at most once per project across several sessions', async () => {
    const { ctx, home } = await harness(h => {
      seedSession(h, 'a', [['bash', 210]])
    })

    await startSession(ctx, 'autotune-a')
    await settle(async () => (await readProjectOverride(CWD, home)) !== undefined)
    const first = await readProjectOverride(CWD, home)

    await startSession(ctx, 'autotune-b')
    await new Promise(resolve => setTimeout(resolve, 250))
    // The single scan is not repeated, so the entry keeps its original stamp.
    expect(await readProjectOverride(CWD, home)).toEqual(first)
  })

  it('skips the scan entirely when the project was already refreshed today', async () => {
    const { ctx, home } = await harness(h => {
      seedSession(h, 'a', [['bash', 210], ['read', 30]])
    })

    await startSession(ctx, 'throttle-first')
    await settle(async () => (await readProjectOverride(CWD, home)) !== undefined)
    const stamped = await readProjectOverride(CWD, home)
    expect(stamped?.tunedAt).toBeGreaterThan(0)

    // A fresh process start on the same day finds the entry already current.
    const again = await autoTune(ctx, CWD, {
      enabled: true, windowDays: 30, topN: 20, minSamples: 200, home,
    })
    expect(again.kind).toBe('throttled')
    expect(await readProjectOverride(CWD, home)).toEqual(stamped)
  })

  it('records a last-updated stamp the store keeps across restarts', async () => {
    const { ctx, home } = await harness(h => {
      seedSession(h, 'a', [['bash', 210]])
    })

    await startSession(ctx, 'stamp-1')
    await settle(async () => (await readProjectOverride(CWD, home)) !== undefined)

    // Re-read from disk the way a new process would, not from live state.
    const persisted = await readStore(home)
    expect(persisted.projects[CWD]?.tunedAt).toBeGreaterThan(0)
    expect(persisted.projects[CWD]?.tunedAt).toBeLessThanOrEqual(Date.now())
  })

  it('leaves a project alone when its history is too small to trust', async () => {
    const { ctx, home } = await harness(h => {
      seedSession(h, 'a', [['bash', 5]])
    })

    await startSession(ctx, 'autotune-small')
    await new Promise(resolve => setTimeout(resolve, 300))

    expect(await readProjectOverride(CWD, home)).toBeUndefined()
  })

  it('does nothing when auto-tuning is disabled', async () => {
    const { ctx, home } = await harness(h => {
      seedSession(h, 'a', [['bash', 500]])
    }, { autoTune: false })

    await startSession(ctx, 'autotune-off')
    await new Promise(resolve => setTimeout(resolve, 300))

    expect(await readProjectOverride(CWD, home)).toBeUndefined()
  })

  it('re-scans on a later day and finds the stored override already correct', async () => {
    const { ctx, home } = await harness(h => {
      seedSession(h, 'a', [['bash', 210]])
    })
    await startSession(ctx, 'autotune-first')
    await settle(async () => (await readProjectOverride(CWD, home)) !== undefined)
    const first = await readProjectOverride(CWD, home)

    // Tomorrow's process re-scans, and the ranking has not moved.
    const tomorrow = (first?.tunedAt ?? Date.now()) + 24 * 60 * 60 * 1000
    const second = await autoTune(ctx, CWD, {
      enabled: true, windowDays: 30, topN: 20, minSamples: 200, home, now: tomorrow,
    })
    expect(second.kind).toBe('unchanged')
    // Only the day stamp advanced; the patterns are untouched.
    expect(await readProjectOverride(CWD, home)).toMatchObject({
      defer: first?.defer, noDefer: first?.noDefer, tunedAt: tomorrow,
    })
  })

  it('lets a project override hide a long-tail tool the global config would show', async () => {
    const { ctx, home } = await harness(h => {
      seedSession(h, 'a', [['bash', 210], ['read', 30]])
    })
    ctx.tools.register(defineContentToolFixture({
      name: 'office_docx',
      description: 'Create a Word document',
      parameters: {},
      async execute() { return [{ type: 'text', text: 'ran:office_docx' }] },
    }))

    const agent = await startSession(ctx, 'autotune-hide')
    await settle(async () => (await readProjectOverride(CWD, home)) !== undefined)

    // The override defers everything this project never used.
    const assembly = await ctx.systemPrompt.assemble({ scope: agent })
    const names = assembly.tools.map(schema => schema.name)
    expect(names).not.toContain('office_docx')
    expect(names).toContain('tool_search')
  })

  it('contains a failed store write instead of breaking session startup', async () => {
    const { ctx, home } = await harness(h => {
      seedSession(h, 'a', [['bash', 210]])
    })
    // Make the store path unwritable by occupying it with a directory.
    const path = storePath(home)
    mkdirSync(path, { recursive: true })

    const agent = await startSession(ctx, 'autotune-fail')
    await new Promise(resolve => setTimeout(resolve, 300))

    // The agent is live even though persisting the override failed.
    expect(ctx.agents.get(SessionId('autotune-fail'))).toBe(agent)
  })
})

describe('global and per-project layering', () => {
  it('uses the global configuration for a project with no override', async () => {
    const { ctx } = await harness(() => {}, { defer: ['glob'], noDefer: [] })
    ctx.tools.register(defineContentToolFixture({
      name: 'glob', description: 'Find files', parameters: {},
      async execute() { return [{ type: 'text', text: 'ok' }] },
    }))
    ctx.tools.register(defineContentToolFixture({
      name: 'read', description: 'Read a file', parameters: {},
      async execute() { return [{ type: 'text', text: 'ok' }] },
    }))

    const agent = await startSession(ctx, 'layer-global', '/Users/dev/untuned')
    const names = (await ctx.systemPrompt.assemble({ scope: agent })).tools.map(s => s.name)
    expect(names).not.toContain('glob')
    expect(names).toContain('read')
  })

  it('prefers a project override over the global configuration', async () => {
    const project = '/Users/dev/tuned'
    // Seed the override before install, as a previous run would have left it.
    const { ctx } = await harness(async (h) => {
      await writeProjectOverride(project, {
        defer: ['glob'], noDefer: ['read'], tunedAt: Date.now(),
      }, h)
    }, { defer: ['Defer(*)'], noDefer: ['bash'] })

    ctx.tools.register(defineContentToolFixture({
      name: 'glob', description: 'Find files', parameters: {},
      async execute() { return [{ type: 'text', text: 'ok' }] },
    }))
    ctx.tools.register(defineContentToolFixture({
      name: 'read', description: 'Read a file', parameters: {},
      async execute() { return [{ type: 'text', text: 'ok' }] },
    }))

    const agent = await startSession(ctx, 'layer-project', project)
    const names = (await ctx.systemPrompt.assemble({ scope: agent })).tools.map(s => s.name)
    // The override wins: glob hidden, read visible — the opposite of global.
    expect(names).not.toContain('glob')
    expect(names).toContain('read')
  })

  it('applies each project its own configuration within one process', async () => {
    const tuned = '/Users/dev/tuned'
    const untuned = '/Users/dev/untuned'
    const { ctx } = await harness(async (h) => {
      await writeProjectOverride(tuned, { defer: ['Defer(*)'], noDefer: ['read'], tunedAt: 1 }, h)
    }, { defer: [], noDefer: [] })

    for (const name of ['read', 'glob']) {
      ctx.tools.register(defineContentToolFixture({
        name, description: `${name} tool`, parameters: {},
        async execute() { return [{ type: 'text', text: 'ok' }] },
      }))
    }

    const a = await startSession(ctx, 'layer-a', tuned)
    const b = await startSession(ctx, 'layer-b', untuned)
    const namesA = (await ctx.systemPrompt.assemble({ scope: a })).tools.map(s => s.name)
    const namesB = (await ctx.systemPrompt.assemble({ scope: b })).tools.map(s => s.name)

    expect(namesA).toContain('read')
    expect(namesA).not.toContain('glob')
    // The untuned project defers nothing (explicit empty global config).
    expect(namesB).toContain('glob')
  })

  it('falls back to global when the store is unreadable', async () => {
    const project = '/Users/dev/broken-store'
    const { ctx } = await harness((h) => {
      mkdirSync(dirname(storePath(h)), { recursive: true })
      writeFileSync(storePath(h), 'not json at all')
    }, { defer: ['glob'], noDefer: [] })

    ctx.tools.register(defineContentToolFixture({
      name: 'glob', description: 'Find files', parameters: {},
      async execute() { return [{ type: 'text', text: 'ok' }] },
    }))

    const agent = await startSession(ctx, 'layer-broken', project)
    const names = (await ctx.systemPrompt.assemble({ scope: agent })).tools.map(s => s.name)
    expect(names).not.toContain('glob')
  })

  it('activates a project override without a restart once a scan writes it', async () => {
    // The project's own history says it uses `read` heavily and never `glob`.
    const { ctx, home } = await harness(h => {
      seedSession(h, 'a', [['read', 210]], CWD)
    }, { defer: [], noDefer: [] })

    for (const name of ['read', 'glob']) {
      ctx.tools.register(defineContentToolFixture({
        name, description: `${name} tool`, parameters: {},
        async execute() { return [{ type: 'text', text: 'ok' }] },
      }))
    }

    const agent = await startSession(ctx, 'layer-live', CWD)
    await settle(async () => (await readProjectOverride(CWD, home)) !== undefined)
    // Re-rank happens from the next request; assemble twice to observe it.
    await ctx.systemPrompt.assemble({ scope: agent })
    const names = (await ctx.systemPrompt.assemble({ scope: agent })).tools.map(s => s.name)

    expect(names).toContain('read')
    expect(names).not.toContain('glob')
  })
})

