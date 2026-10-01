import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import {
  DEFAULT_MIN_SAMPLES,
  DEFAULT_TOP_N,
  DEFAULT_WINDOW_DAYS,
  invokedTool,
  isTrustworthy,
  parseActivationTarget,
  projectKey,
  scanHistory,
  tuneConfig,
  type HistoryRanking,
} from '../src/history.ts'

const DAY = 24 * 60 * 60 * 1000
const NOW = Date.UTC(2026, 8, 30, 12, 0, 0)

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lazy-tools-home-'))
  tempDirs.push(dir)
  return dir
}

/** One `tool/call` event as the session log records it. */
function callEvent(name: string, time: number, args = '{}'): SessionEvent {
  return { type: 'tool/call', seq: 0, time, data: { turn: 1, step: 1, callId: 'c', name, arguments: args } } as SessionEvent
}

/** Write one persisted session as a multi-frame compressed JSONL artifact. */
function writeSession(home: string, cwd: string, id: string, events: SessionEvent[], frames = 3): void {
  const dir = join(home, 'sessions', projectKey(cwd), `session-${id}`)
  mkdirSync(dir, { recursive: true })
  const header = JSON.stringify({ type: 'session', version: 4, id, cwd })
  const lines = [header, ...events.map(event => JSON.stringify(event))]
  // Deliberately split across several frames: only a frame-aware decoder
  // recovers everything after the header frame.
  const perFrame = Math.ceil(lines.length / frames)
  const encoded: Buffer[] = []
  for (let i = 0; i < lines.length; i += perFrame) {
    encoded.push(zstdCompressSync(Buffer.from(`${lines.slice(i, i + perFrame).join('\n')}\n`)))
  }
  writeFileSync(join(dir, 'session.v4.jsonl.zstd'), Buffer.concat(encoded))
}

describe('projectKey', () => {
  it('matches the directory name the jsonl backend actually creates', () => {
    expect(projectKey('/Users/devinzeng/Code/dsh-lazy-tools'))
      .toBe('--Users-devinzeng-Code-dsh-lazy-tools--')
    expect(projectKey('/Users/devinzeng/Code/deepseek-harness'))
      .toBe('--Users-devinzeng-Code-deepseek-harness--')
  })

  it('escapes unsafe code units and collapses separator runs', () => {
    expect(projectKey('/a//b')).toBe('--a-b--')
    expect(projectKey('/a b')).toBe('--a~0020b--')
    expect(projectKey('C:\\Users\\x')).toBe('--C-Users-x--')
  })

  it('rejects an empty path', () => {
    expect(() => projectKey('')).toThrow(/empty/)
  })
})

describe('invokedTool', () => {
  it('counts a direct call as usage of the called tool', () => {
    expect(invokedTool(callEvent('bash', NOW), 0)).toBe('bash')
  })

  it('attributes a defer_execute_tool call to the tool it activates', () => {
    const event = callEvent('defer_execute_tool', NOW, '{"toolName":"glob"}')
    expect(invokedTool(event, 0)).toBe('glob')
  })

  it('ignores events outside the window and non-call events', () => {
    expect(invokedTool(callEvent('bash', NOW - 5 * DAY), NOW - DAY)).toBeUndefined()
    expect(invokedTool({ type: 'step/start', seq: 0, time: NOW, data: {} } as SessionEvent, 0)).toBeUndefined()
  })

  it('yields nothing for a malformed activation argument', () => {
    expect(invokedTool(callEvent('defer_execute_tool', NOW, 'not json'), 0)).toBeUndefined()
    expect(invokedTool(callEvent('defer_execute_tool', NOW, '{"toolName":7}'), 0)).toBeUndefined()
  })
})

describe('parseActivationTarget', () => {
  it('reads a well-formed toolName and rejects the rest', () => {
    expect(parseActivationTarget('{"toolName":"read"}')).toBe('read')
    expect(parseActivationTarget('{"toolName":""}')).toBeUndefined()
    expect(parseActivationTarget('{}')).toBeUndefined()
    expect(parseActivationTarget('null')).toBeUndefined()
    expect(parseActivationTarget('[1]')).toBeUndefined()
    expect(parseActivationTarget('')).toBeUndefined()
  })
})

describe('scanHistory', () => {
  it('ranks tools by use across the window, counting activations as use', async () => {
    const home = tempHome()
    const cwd = '/Users/dev/proj'
    writeSession(home, cwd, 'a', [
      callEvent('bash', NOW - 1 * DAY),
      callEvent('bash', NOW - 1 * DAY),
      callEvent('edit', NOW - 2 * DAY),
      // Activation of a deferred tool counts as usage of that tool.
      callEvent('defer_execute_tool', NOW - 2 * DAY, '{"toolName":"glob"}'),
      callEvent('tool_search', NOW - 2 * DAY),
    ])
    writeSession(home, cwd, 'b', [
      callEvent('bash', NOW - 3 * DAY),
      callEvent('edit', NOW - 3 * DAY),
      callEvent('glob', NOW - 3 * DAY),
    ])

    const ranking = await scanHistory({ cwd, home, now: NOW })
    expect(ranking).toBeDefined()
    expect(ranking?.ranked).toEqual([
      { name: 'bash', count: 3 },
      { name: 'edit', count: 2 },
      { name: 'glob', count: 2 },
      { name: 'tool_search', count: 1 },
    ])
    expect(ranking?.totalCalls).toBe(8)
    expect(ranking?.sessionsScanned).toBe(2)
  })

  it('excludes events older than the window', async () => {
    const home = tempHome()
    const cwd = '/Users/dev/proj'
    writeSession(home, cwd, 'a', [
      callEvent('bash', NOW - 1 * DAY),
      callEvent('ancient', NOW - (DEFAULT_WINDOW_DAYS + 1) * DAY),
    ])

    const ranking = await scanHistory({ cwd, home, now: NOW })
    expect(ranking?.ranked).toEqual([{ name: 'bash', count: 1 }])
    expect(ranking?.totalCalls).toBe(1)
  })

  it('honours a custom window', async () => {
    const home = tempHome()
    const cwd = '/Users/dev/proj'
    writeSession(home, cwd, 'a', [
      callEvent('recent', NOW - 1 * DAY),
      callEvent('older', NOW - 5 * DAY),
    ])

    const narrow = await scanHistory({ cwd, home, now: NOW, windowDays: 2 })
    expect(narrow?.ranked).toEqual([{ name: 'recent', count: 1 }])
  })

  it('skips a project whose sessions are all outside the window', async () => {
    const home = tempHome()
    const cwd = '/Users/dev/proj'
    writeSession(home, cwd, 'a', [callEvent('bash', NOW - 90 * DAY)])

    expect(await scanHistory({ cwd, home, now: NOW })).toBeUndefined()
  })

  it('returns undefined when the project has no session directory', async () => {
    const home = tempHome()
    expect(await scanHistory({ cwd: '/Users/dev/never-used', home, now: NOW })).toBeUndefined()
  })

  it('reads through an injected event source instead of the filesystem', async () => {
    const events = new Map<string, SessionEvent[]>([
      ['s1', [callEvent('read', NOW - DAY), callEvent('read', NOW - DAY)]],
      ['s2', [callEvent('write', NOW - DAY)]],
    ])
    const ranking = await scanHistory({
      cwd: '/Users/dev/proj',
      home: tempHome(),
      now: NOW,
      sessionIds: ['s1', 's2', 'missing'],
      readEvents: async (id) => {
        const found = events.get(id)
        if (found === undefined) throw new Error('no such session')
        return found
      },
    })
    expect(ranking?.ranked).toEqual([{ name: 'read', count: 2 }, { name: 'write', count: 1 }])
    expect(ranking?.sessionsScanned).toBe(2)
  })

  it('counts only sessions with in-window calls', async () => {
    const ranking = await scanHistory({
      cwd: '/Users/dev/proj',
      home: tempHome(),
      now: NOW,
      sessionIds: ['live', 'stale'],
      readEvents: async (id) => id === 'live' ? [callEvent('bash', NOW - DAY)] : [callEvent('bash', NOW - 90 * DAY)],
    })
    expect(ranking?.sessionsScanned).toBe(1)
  })

  it('survives a corrupt artifact and still reads its neighbours', async () => {
    const home = tempHome()
    const cwd = '/Users/dev/proj'
    const dir = join(home, 'sessions', projectKey(cwd), 'session-a')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'session.jsonl.zstd'), Buffer.from('not a zstd frame at all'))
    writeFileSync(
      join(dir, 'session.v4.jsonl.zstd'),
      zstdCompressSync(Buffer.from(`${JSON.stringify(callEvent('bash', NOW - DAY))}\n`)),
    )

    const ranking = await scanHistory({ cwd, home, now: NOW })
    expect(ranking?.ranked).toEqual([{ name: 'bash', count: 1 }])
  })

  it('skips unparsable lines such as a torn live tail', async () => {
    const home = tempHome()
    const cwd = '/Users/dev/proj'
    const dir = join(home, 'sessions', projectKey(cwd), 'session-a')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'session.v4.jsonl.zstd'), zstdCompressSync(Buffer.from(
      `${JSON.stringify(callEvent('bash', NOW - DAY))}\n{"type":"tool/call","seq":1,`,
    )))

    const ranking = await scanHistory({ cwd, home, now: NOW })
    expect(ranking?.ranked).toEqual([{ name: 'bash', count: 1 }])
  })

  it('reads an uncompressed generation', async () => {
    const home = tempHome()
    const cwd = '/Users/dev/proj'
    const dir = join(home, 'sessions', projectKey(cwd), 'session-a')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'session.v4.jsonl'), `${JSON.stringify(callEvent('plain', NOW - DAY))}\n`)

    const ranking = await scanHistory({ cwd, home, now: NOW })
    expect(ranking?.ranked).toEqual([{ name: 'plain', count: 1 }])
  })

  it('stops early when the signal is already aborted', async () => {
    const home = tempHome()
    const controller = new AbortController()
    controller.abort()
    const ranking = await scanHistory({
      cwd: '/Users/dev/proj',
      home,
      now: NOW,
      signal: controller.signal,
      sessionIds: ['a'],
      readEvents: async () => [callEvent('bash', NOW)],
    })
    expect(ranking).toBeUndefined()
  })
})

describe('tuneConfig', () => {
  const ranking: HistoryRanking = {
    ranked: Array.from({ length: 25 }, (_, index) => ({ name: `tool${String(index).padStart(2, '0')}`, count: 25 - index })),
    totalCalls: 325,
    sessionsScanned: 4,
    projectDir: '/tmp/x',
  }

  it('keeps the top N active and defers everything else', () => {
    const tuned = tuneConfig(ranking, 20)
    expect(tuned.defer).toEqual(['Defer(*)'])
    expect(tuned.noDefer).toHaveLength(20)
    expect(tuned.noDefer[0]).toBe('tool00')
    expect(tuned.noDefer).not.toContain('tool24')
  })

  it('defaults to twenty tools', () => {
    expect(tuneConfig(ranking).noDefer).toHaveLength(DEFAULT_TOP_N)
  })

  it('returns fewer entries when the history is small', () => {
    const small = tuneConfig({ ...ranking, ranked: ranking.ranked.slice(0, 3) }, 20)
    expect(small.noDefer).toEqual(['tool00', 'tool01', 'tool02'])
  })
})

describe('isTrustworthy', () => {
  const ranking = (totalCalls: number): HistoryRanking => ({
    ranked: [{ name: 'bash', count: totalCalls }], totalCalls, sessionsScanned: 1, projectDir: '/tmp/x',
  })

  it('requires the minimum sample and rejects an absent ranking', () => {
    expect(isTrustworthy(undefined)).toBe(false)
    expect(isTrustworthy(ranking(DEFAULT_MIN_SAMPLES - 1))).toBe(false)
    expect(isTrustworthy(ranking(DEFAULT_MIN_SAMPLES))).toBe(true)
    expect(isTrustworthy(ranking(0))).toBe(false)
  })

  it('accepts a custom threshold', () => {
    expect(isTrustworthy(ranking(5), 5)).toBe(true)
    expect(isTrustworthy(ranking(5), 6)).toBe(false)
  })
})