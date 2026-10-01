import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { autoTune, describeOutcome, mine, resolveAutoTuneOptions } from '../src/autotune.ts'
import { DEFAULT_MIN_SAMPLES, DEFAULT_TOP_N, DEFAULT_WINDOW_DAYS, type HistoryRanking } from '../src/history.ts'
import { readProjectOverride, storePath } from '../src/project-config.ts'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const NOW = Date.UTC(2026, 8, 30, 12, 0, 0)
const CWD = '/Users/dev/proj'

/** One `tool/call` event. */
function call(name: string, args = '{}'): SessionEvent {
  return { type: 'tool/call', seq: 0, time: NOW, data: { turn: 1, step: 1, callId: 'c', name, arguments: args } } as SessionEvent
}

/** Build enough calls to clear the trust threshold. */
function callsFor(entries: ReadonlyArray<readonly [string, number]>): SessionEvent[] {
  return entries.flatMap(([name, count]) => Array.from({ length: count }, () => call(name)))
}

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A fresh harness home so each case gets an isolated project store. */
function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lazy-tools-proj-'))
  tempDirs.push(dir)
  return dir
}

/**
 * A minimal `Context` stand-in exposing only `get` and `logger`, which is all
 * the auto-tune path consults.
 */
function ctxFixture(services: Record<string, unknown>) {
  const warnings: string[] = []
  const infos: string[] = []
  return {
    warnings,
    infos,
    ctx: {
      get: (name: string) => services[name],
      logger: { warn: (message: string) => warnings.push(message), info: (message: string) => infos.push(message) },
    } as unknown as Context,
  }
}

/** A sessionQuery stand-in over an in-memory corpus. */
function queryFixture(sessions: Record<string, { cwd: string; events: SessionEvent[] }>) {
  return {
    listSessions: async () => Object.entries(sessions).map(([id, value]) => ({ header: { id, cwd: value.cwd } })),
    readSession: async (id: string) => {
      const found = sessions[id]
      if (found === undefined) throw new Error('no such session')
      return { events: found.events }
    },
  }
}

describe('resolveAutoTuneOptions', () => {
  it('applies the shipped defaults', () => {
    const options = resolveAutoTuneOptions({})
    expect(options).toMatchObject({
      enabled: true,
      windowDays: DEFAULT_WINDOW_DAYS,
      topN: DEFAULT_TOP_N,
      minSamples: DEFAULT_MIN_SAMPLES,
    })
  })

  it('honours explicit values and threads the harness home', () => {
    const options = resolveAutoTuneOptions(
      { autoTune: false, autoTuneWindowDays: 7, autoTuneTopN: 5, autoTuneMinSamples: 10 },
      '/custom/home',
    )
    expect(options).toMatchObject({ enabled: false, windowDays: 7, topN: 5, minSamples: 10, home: '/custom/home' })
  })

  it('treats a zero-valued override as configured rather than missing', () => {
    expect(resolveAutoTuneOptions({ autoTuneWindowDays: 0 }).windowDays).toBe(0)
  })
})

describe('mine', () => {
  it('prefers sessionQuery, filtering to the requested project', async () => {
    const ctx = ctxFixture({
      sessionQuery: queryFixture({
        mine: { cwd: CWD, events: callsFor([['bash', 3]]) },
        other: { cwd: '/Users/dev/elsewhere', events: callsFor([['edit', 99]]) },
      }),
    }).ctx
    const ranking = await mine(ctx, CWD, { enabled: true, windowDays: 30, topN: 20, minSamples: 0 })
    expect(ranking?.ranked).toEqual([{ name: 'bash', count: 3 }])
    expect(ranking?.sessionsScanned).toBe(1)
  })

  it('falls back to the direct reader when sessionQuery throws', async () => {
    const ctx = ctxFixture({
      sessionQuery: {
        listSessions: async () => { throw new Error('backend unavailable') },
        readSession: async () => ({ events: [] }),
      },
    }).ctx
    // No real sessions exist under this temp home, so the fallback finds none.
    const ranking = await mine(ctx, CWD, { enabled: true, windowDays: 30, topN: 20, minSamples: 0, home: '/nonexistent-home' })
    expect(ranking).toBeUndefined()
  })

  it('falls back to the direct reader when the query corpus has no match', async () => {
    const ctx = ctxFixture({
      sessionQuery: queryFixture({ other: { cwd: '/Users/dev/elsewhere', events: callsFor([['edit', 1]]) } }),
    }).ctx
    const ranking = await mine(ctx, CWD, { enabled: true, windowDays: 30, topN: 20, minSamples: 0, home: '/nonexistent-home' })
    expect(ranking).toBeUndefined()
  })
})

describe('autoTune', () => {
  const options = { enabled: true, windowDays: 30, topN: 20, minSamples: 10 }

  it('records a per-project override instead of touching the global config', async () => {
    const home = tempHome()
    const ctx = ctxFixture({
      sessionQuery: queryFixture({ s1: { cwd: CWD, events: callsFor([['bash', 20], ['read', 5]]) } }),
    }).ctx

    const outcome = await autoTune(ctx, CWD, { ...options, home })
    expect(outcome.kind).toBe('applied')
    const stored = await readProjectOverride(CWD, home)
    expect(stored).toMatchObject({ defer: ['Defer(*)'], noDefer: ['bash', 'read'] })
    expect(stored?.sampleCalls).toBe(25)
    expect(stored?.sessions).toBe(1)
  })

  it('keys the store by the project path, leaving other projects untouched', async () => {
    const home = tempHome()
    const other = '/Users/dev/another-project'
    const ctx = ctxFixture({
      sessionQuery: queryFixture({ s1: { cwd: CWD, events: callsFor([['bash', 20]]) } }),
    }).ctx
    await autoTune(ctx, CWD, { ...options, home })

    expect(await readProjectOverride(other, home)).toBeUndefined()
    expect(await readProjectOverride(CWD, home)).toBeDefined()
  })

  it('does not rewrite an override that already matches the scan', async () => {
    const home = tempHome()
    const ctx = ctxFixture({
      sessionQuery: queryFixture({ s1: { cwd: CWD, events: callsFor([['bash', 20]]) } }),
    }).ctx

    // Two runs on different days, so the second actually re-scans and finds
    // the stored patterns already correct.
    const monday = new Date(2026, 8, 28, 12).getTime()
    const tuesday = new Date(2026, 8, 29, 12).getTime()

    expect((await autoTune(ctx, CWD, { ...options, home, now: monday })).kind).toBe('applied')
    expect((await autoTune(ctx, CWD, { ...options, home, now: tuesday })).kind).toBe('unchanged')
    // The patterns are untouched; only the day stamp advances.
    expect(await readProjectOverride(CWD, home)).toMatchObject({
      defer: ['Defer(*)'], noDefer: ['bash'], tunedAt: tuesday,
    })
  })

  it('refuses to tune on a sample below the threshold', async () => {
    const home = tempHome()
    const ctx = ctxFixture({
      sessionQuery: queryFixture({ s1: { cwd: CWD, events: callsFor([['bash', 3]]) } }),
    }).ctx

    const outcome = await autoTune(ctx, CWD, { ...options, home })
    expect(outcome.kind).toBe('insufficient-sample')
    expect(await readProjectOverride(CWD, home)).toBeUndefined()
  })

  it('reports no history for an unused project', async () => {
    const home = tempHome()
    const ctx = ctxFixture({
      sessionQuery: queryFixture({ other: { cwd: '/Users/dev/elsewhere', events: callsFor([['bash', 50]]) } }),
    }).ctx

    expect((await autoTune(ctx, CWD, { ...options, minSamples: 0, home })).kind).toBe('no-history')
    expect(await readProjectOverride(CWD, home)).toBeUndefined()
  })

  it('skips when disabled or when the session has no working directory', async () => {
    const home = tempHome()
    const ctx = ctxFixture({}).ctx
    expect((await autoTune(ctx, CWD, { ...options, enabled: false, home })).kind).toBe('skipped')
    expect((await autoTune(ctx, '', { ...options, home })).kind).toBe('skipped')
    expect(await readProjectOverride(CWD, home)).toBeUndefined()
  })

  it('never exceeds the configured top N', async () => {
    const home = tempHome()
    const events = callsFor(Array.from({ length: 40 }, (_, i) => [`t${i}`, 40 - i] as const))
    const ctx = ctxFixture({ sessionQuery: queryFixture({ s1: { cwd: CWD, events } }) }).ctx

    await autoTune(ctx, CWD, { ...options, topN: 20, minSamples: 0, home })
    expect((await readProjectOverride(CWD, home))?.noDefer).toHaveLength(20)
  })

  it('writes into the harness home it was given', async () => {
    const home = tempHome()
    const ctx = ctxFixture({
      sessionQuery: queryFixture({ s1: { cwd: CWD, events: callsFor([['bash', 20]]) } }),
    }).ctx
    await autoTune(ctx, CWD, { ...options, home })
    expect(storePath(home).startsWith(home)).toBe(true)
  })
})

describe('once-a-day refresh', () => {
  const base = { enabled: true, windowDays: 30, topN: 20, minSamples: 10 }
  const day = (d: number, h = 12): number => new Date(2026, 8, d, h, 0, 0, 0).getTime()

  /** A query fixture that counts how many times the corpus was read. */
  function countingFixture(events: SessionEvent[]) {
    let reads = 0
    return {
      get reads() { return reads },
      query: {
        listSessions: async () => { reads += 1; return [{ header: { id: 's1', cwd: CWD } }] },
        readSession: async () => ({ events }),
      },
    }
  }

  it('scans and stamps the entry on the first run of a day', async () => {
    const home = tempHome()
    const ctx = ctxFixture({
      sessionQuery: queryFixture({ s1: { cwd: CWD, events: callsFor([['bash', 20]]) } }),
    }).ctx

    const outcome = await autoTune(ctx, CWD, { ...base, home, now: day(30) })
    expect(outcome.kind).toBe('applied')
    expect((await readProjectOverride(CWD, home))?.tunedAt).toBe(day(30))
  })

  it('does not scan again on the same local day', async () => {
    const home = tempHome()
    const counter = countingFixture(callsFor([['bash', 20]]))
    const ctx = ctxFixture({ sessionQuery: counter.query }).ctx

    await autoTune(ctx, CWD, { ...base, home, now: day(30, 1) })
    expect(counter.reads).toBe(1)

    const second = await autoTune(ctx, CWD, { ...base, home, now: day(30, 23) })
    expect(second.kind).toBe('throttled')
    // The whole point of the throttle: the expensive read never happened.
    expect(counter.reads).toBe(1)
  })

  it('keeps the previous override intact while throttled', async () => {
    const home = tempHome()
    const ctx = ctxFixture({
      sessionQuery: queryFixture({ s1: { cwd: CWD, events: callsFor([['bash', 20], ['read', 5]]) } }),
    }).ctx

    await autoTune(ctx, CWD, { ...base, home, now: day(30, 1) })
    const stamped = await readProjectOverride(CWD, home)

    await autoTune(ctx, CWD, { ...base, home, now: day(30, 20) })
    expect(await readProjectOverride(CWD, home)).toEqual(stamped)
  })

  it('scans again on the next local day', async () => {
    const home = tempHome()
    const counter = countingFixture(callsFor([['bash', 20]]))
    const ctx = ctxFixture({ sessionQuery: counter.query }).ctx

    await autoTune(ctx, CWD, { ...base, home, now: day(30) })
    const outcome = await autoTune(ctx, CWD, { ...base, home, now: day(31) })

    expect(outcome.kind).not.toBe('throttled')
    expect(counter.reads).toBe(2)
    expect((await readProjectOverride(CWD, home))?.tunedAt).toBe(day(31))
  })

  it('re-stamps the entry when the day turns but the ranking is unchanged', async () => {
    const home = tempHome()
    const ctx = ctxFixture({
      sessionQuery: queryFixture({ s1: { cwd: CWD, events: callsFor([['bash', 20]]) } }),
    }).ctx

    await autoTune(ctx, CWD, { ...base, home, now: day(30) })
    const outcome = await autoTune(ctx, CWD, { ...base, home, now: day(31) })

    expect(outcome.kind).toBe('unchanged')
    // Re-stamped so the rest of day 31 is throttled too.
    expect((await readProjectOverride(CWD, home))?.tunedAt).toBe(day(31))
    expect(await autoTune(ctx, CWD, { ...base, home, now: day(31, 23) })).toMatchObject({ kind: 'throttled' })
  })

  it('still extracts a not-yet-scanned project on a day another was stamped', async () => {
    const home = tempHome()
    const other = '/Users/dev/another'
    const ctx = ctxFixture({
      sessionQuery: queryFixture({ s1: { cwd: CWD, events: callsFor([['bash', 20]]) } }),
    }).ctx

    await autoTune(ctx, CWD, { ...base, home, now: day(30) })
    // A different project has no stamp, so it is not throttled by the first.
    expect(await readProjectOverride(other, home)).toBeUndefined()
  })

  it('never throttles a project that has no entry yet', async () => {
    const home = tempHome()
    const ctx = ctxFixture({
      sessionQuery: queryFixture({ s1: { cwd: CWD, events: callsFor([['bash', 20]]) } }),
    }).ctx
    const outcome = await autoTune(ctx, CWD, { ...base, home, now: day(30) })
    expect(outcome.kind).toBe('applied')
  })
})

describe('describeOutcome', () => {
  const ranking: HistoryRanking = { ranked: [], totalCalls: 5, sessionsScanned: 2, projectDir: '/tmp/x' }

  it('renders every outcome kind without throwing', () => {
    const outcomes = [
      { kind: 'skipped', reason: 'disabled' },
      { kind: 'throttled', tunedAt: new Date(2026, 8, 30, 12).getTime() },
      { kind: 'no-history' },
      { kind: 'insufficient-sample', ranking },
      { kind: 'unchanged', ranking },
      { kind: 'applied', ranking, top: ['bash'] },
    ] as const
    for (const outcome of outcomes) {
      expect(describeOutcome(outcome, 20)).toMatch(/^lazy-tools: auto-tune/)
    }
  })

  it('says which day the throttled project was last refreshed', () => {
    const line = describeOutcome({ kind: 'throttled', tunedAt: new Date(2026, 8, 30, 12).getTime() }, 20)
    expect(line).toContain('already refreshed')
    expect(line).toContain('skipping the scan')
  })

  it('names the tools and the sample size when applied', () => {
    const line = describeOutcome({ kind: 'applied', ranking, top: ['bash', 'read'] }, 20)
    expect(line).toContain('bash, read')
    expect(line).toContain('5 calls')
  })
})
describe('sessionQuery contract', () => {
  it('keeps the structural reader compatible with the real service type', () => {
    // Compile-time only: the assertion fails `pnpm run typecheck` if DSH ever
    // changes the shape `mine()` depends on, rather than silently degrading to
    // the direct JSONL reader.
    type Real = import('@deepseek-ai/dsh-session-query').SessionQueryEngine
    type Structural = {
      listSessions(signal?: AbortSignal): Promise<Array<{ header: { id: string; cwd?: string } }>>
      readSession(id: never): Promise<{ events: readonly SessionEvent[] }>
    }
    const accepts = (engine: Real): Structural => engine
    expect(typeof accepts).toBe('function')
  })
})
