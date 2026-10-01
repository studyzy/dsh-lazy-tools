import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  applyProjectOverride,
  isAlreadyTuned,
  isFreshForToday,
  needsRefresh,
  readProjectOverride,
  readStore,
  storePath,
  writeProjectOverride,
  STORE_FILE_NAME,
  STORE_DIR_NAME,
} from '../src/project-config.ts'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lazy-tools-store-'))
  tempDirs.push(dir)
  return dir
}

const PROJECT = '/Users/dev/api'
const OTHER = '/Users/dev/web'

describe('storePath', () => {
  it('lives under the harness home, beside the session store', () => {
    const home = '/tmp/harness-home'
    expect(storePath(home)).toBe(join(home, STORE_DIR_NAME, STORE_FILE_NAME))
    expect(storePath(home)).toContain('/sessions'.replace('/sessions', ''))
  })

  it('is not the sessions directory itself', () => {
    const home = tempHome()
    expect(storePath(home)).not.toBe(join(home, 'sessions'))
  })
})

describe('readStore', () => {
  it('reads as empty when nothing has been written yet', async () => {
    const home = tempHome()
    const store = await readStore(home)
    expect(store.projects).toEqual({})
    expect(store.version).toBeGreaterThan(0)
  })

  it('reads as empty rather than throwing on corrupt JSON', async () => {
    const home = tempHome()
    const path = storePath(home)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, '{ this is not json')
    expect((await readStore(home)).projects).toEqual({})
  })

  it('reads as empty when the top level is not an object', async () => {
    const home = tempHome()
    const path = storePath(home)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, '"a string"')
    expect((await readStore(home)).projects).toEqual({})
  })

  it('drops malformed project entries but keeps valid ones', async () => {
    const home = tempHome()
    const path = storePath(home)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify({
      version: 1,
      projects: {
        [PROJECT]: { defer: ['Defer(*)'], noDefer: ['bash'], tunedAt: 1 },
        '/bad/one': { defer: 'not-an-array', noDefer: [] },
        '/bad/two': null,
        '/bad/three': { defer: ['Defer(*)'], noDefer: ['bash', 7] },
      },
    }))

    const store = await readStore(home)
    expect(Object.keys(store.projects)).toEqual([PROJECT])
    expect(store.projects[PROJECT]?.noDefer).toEqual(['bash'])
  })

  it('tolerates a missing version field', async () => {
    const home = tempHome()
    const path = storePath(home)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify({ projects: { [PROJECT]: { defer: [], noDefer: ['bash'], tunedAt: 2 } } }))
    expect((await readStore(home)).projects[PROJECT]?.noDefer).toEqual(['bash'])
  })
})

describe('writeProjectOverride', () => {
  it('creates the directory and persists an entry', async () => {
    const home = tempHome()
    await writeProjectOverride(PROJECT, { defer: ['Defer(*)'], noDefer: ['bash'], tunedAt: 5 }, home)
    expect(await readProjectOverride(PROJECT, home))
      .toMatchObject({ defer: ['Defer(*)'], noDefer: ['bash'], tunedAt: 5 })
  })

  it('preserves other projects, so one scan cannot evict another', async () => {
    const home = tempHome()
    await writeProjectOverride(PROJECT, { defer: ['Defer(*)'], noDefer: ['bash'], tunedAt: 1 }, home)
    await writeProjectOverride(OTHER, { defer: [], noDefer: ['edit'], tunedAt: 2 }, home)

    const store = await readStore(home)
    expect(store.projects[PROJECT]?.noDefer).toEqual(['bash'])
    expect(store.projects[OTHER]?.noDefer).toEqual(['edit'])
  })

  it('replaces an existing entry for the same project', async () => {
    const home = tempHome()
    await writeProjectOverride(PROJECT, { defer: ['Defer(*)'], noDefer: ['bash'], tunedAt: 1 }, home)
    await writeProjectOverride(PROJECT, { defer: [], noDefer: ['read'], tunedAt: 2 }, home)

    const store = await readStore(home)
    expect(store.projects[PROJECT]).toMatchObject({ defer: [], noDefer: ['read'], tunedAt: 2 })
  })

  it('leaves no temporary file behind', async () => {
    const home = tempHome()
    await writeProjectOverride(PROJECT, { defer: [], noDefer: ['bash'], tunedAt: 1 }, home)
    const { readdirSync } = await import('node:fs')
    expect(readdirSync(dirname(storePath(home)))).toEqual([STORE_FILE_NAME])
  })

  it('writes readable JSON', async () => {
    const home = tempHome()
    await writeProjectOverride(PROJECT, { defer: ['Defer(*)'], noDefer: ['bash'], tunedAt: 9 }, home)
    const parsed: unknown = JSON.parse(readFileSync(storePath(home), 'utf8'))
    expect(parsed).toMatchObject({ projects: { [PROJECT]: { tunedAt: 9 } } })
  })

  it('serializes concurrent writes without losing either project', async () => {
    const home = tempHome()
    // Fired together: the read-modify-write must not interleave into a lost update.
    await Promise.all([
      writeProjectOverride(PROJECT, { defer: [], noDefer: ['bash'], tunedAt: 1 }, home),
      writeProjectOverride(OTHER, { defer: [], noDefer: ['edit'], tunedAt: 2 }, home),
    ])

    const store = await readStore(home)
    expect(Object.keys(store.projects).sort()).toEqual([PROJECT, OTHER].sort())
  })
})

describe('applyProjectOverride', () => {
  const global = {
    defer: ['Defer(git_*)'],
    noDefer: ['bash', 'read'],
    deferToolLoading: true,
  }

  it('returns the global configuration untouched when the project has no entry', () => {
    expect(applyProjectOverride(global, undefined)).toBe(global)
  })

  it('replaces the pattern pair for a project that has an entry', () => {
    const resolved = applyProjectOverride(global, {
      defer: ['Defer(*)'],
      noDefer: ['edit'],
      tunedAt: 1,
    })
    expect(resolved.defer).toEqual(['Defer(*)'])
    expect(resolved.noDefer).toEqual(['edit'])
  })

  it('replaces rather than merges, so tuned projects cannot inherit stale rules', () => {
    // If the global `Defer(git_*)` leaked in, a project that never uses git
    // tooling could not re-enable it — the tuned set must stand alone.
    const resolved = applyProjectOverride(global, { defer: ['Defer(*)'], noDefer: ['bash'], tunedAt: 1 })
    expect(resolved.defer).not.toContain('Defer(git_*)')
    expect(resolved.noDefer).not.toContain('read')
  })

  it('preserves global knobs outside the pattern pair', () => {
    const resolved = applyProjectOverride(global, { defer: [], noDefer: [], tunedAt: 1 })
    expect(resolved.deferToolLoading).toBe(true)
  })

  it('does not alias the stored arrays', () => {
    const override = { defer: ['Defer(*)'], noDefer: ['bash'], tunedAt: 1 }
    const resolved = applyProjectOverride(global, override)
    expect(resolved.defer).not.toBe(override.defer)
    expect(resolved.noDefer).not.toBe(override.noDefer)
  })

  it('lets an empty override mean "defer nothing" for that project', () => {
    const resolved = applyProjectOverride(global, { defer: [], noDefer: [], tunedAt: 1 })
    expect(resolved.defer).toEqual([])
    expect(resolved.noDefer).toEqual([])
  })
})

describe('isAlreadyTuned', () => {
  const tuned = { defer: ['Defer(*)'], noDefer: ['bash', 'read'] }

  it('is false when the project has no entry yet', () => {
    expect(isAlreadyTuned(undefined, tuned)).toBe(false)
  })

  it('is true for an exact match', () => {
    expect(isAlreadyTuned({ defer: ['Defer(*)'], noDefer: ['bash', 'read'], tunedAt: 1 }, tuned)).toBe(true)
  })

  it('is false for a differing or reordered list', () => {
    expect(isAlreadyTuned({ defer: [], noDefer: ['bash'], tunedAt: 1 }, tuned)).toBe(false)
    expect(isAlreadyTuned({ defer: ['Defer(*)'], noDefer: ['read', 'bash'], tunedAt: 1 }, tuned)).toBe(false)
  })
})

describe('isFreshForToday', () => {
  /** A local-time instant, so the assertions hold in any timezone. */
  const at = (y: number, m: number, d: number, h = 12, min = 0): number =>
    new Date(y, m - 1, d, h, min, 0, 0).getTime()

  it('is false without a stamp, so a first scan is never blocked', () => {
    expect(isFreshForToday(undefined, at(2026, 9, 30))).toBe(false)
    expect(isFreshForToday(0, at(2026, 9, 30))).toBe(false)
    expect(isFreshForToday(-1, at(2026, 9, 30))).toBe(false)
  })

  it('is true for two instants on the same local day', () => {
    expect(isFreshForToday(at(2026, 9, 30, 0, 1), at(2026, 9, 30, 23, 59))).toBe(true)
  })

  it('is false across a local midnight, even minutes apart', () => {
    expect(isFreshForToday(at(2026, 9, 30, 23, 59), at(2026, 10, 1, 0, 1))).toBe(false)
  })

  it('is true for two instants 23 hours apart on the same day', () => {
    expect(isFreshForToday(at(2026, 9, 30, 0, 30), at(2026, 9, 30, 23, 30))).toBe(true)
  })

  it('is false for the same clock time a week earlier', () => {
    expect(isFreshForToday(at(2026, 9, 23, 12), at(2026, 9, 30, 12))).toBe(false)
  })

  it('distinguishes the same day-of-month in different months', () => {
    expect(isFreshForToday(at(2026, 8, 30), at(2026, 9, 30))).toBe(false)
  })

  it('distinguishes the same date in different years', () => {
    expect(isFreshForToday(at(2025, 9, 30), at(2026, 9, 30))).toBe(false)
  })

  it('treats a non-finite stamp as stale rather than throwing', () => {
    expect(isFreshForToday(Number.NaN, at(2026, 9, 30))).toBe(false)
    expect(isFreshForToday(Number.POSITIVE_INFINITY, at(2026, 9, 30))).toBe(false)
  })

  it('is a calendar-day rule, not a rolling 24 hours', () => {
    // 23:00 yesterday to 01:00 today is only two hours, but the day has turned.
    expect(isFreshForToday(at(2026, 9, 29, 23), at(2026, 9, 30, 1))).toBe(false)
    // 00:30 to 23:30 today is 23 hours, but still the same day.
    expect(isFreshForToday(at(2026, 9, 30, 0, 30), at(2026, 9, 30, 23, 30))).toBe(true)
  })
})

describe('needsRefresh', () => {
  const at = (y: number, m: number, d: number): number => new Date(y, m - 1, d, 12).getTime()

  it('is true when the project has no entry', () => {
    expect(needsRefresh(undefined, at(2026, 9, 30))).toBe(true)
  })

  it('is false once refreshed on the same local day', () => {
    expect(needsRefresh({ defer: [], noDefer: [], tunedAt: at(2026, 9, 30) }, at(2026, 9, 30))).toBe(false)
  })

  it('is true again on the next local day', () => {
    expect(needsRefresh({ defer: [], noDefer: [], tunedAt: at(2026, 9, 30) }, at(2026, 10, 1))).toBe(true)
  })
})