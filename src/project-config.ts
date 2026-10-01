/**
 * Per-project defer overrides, stored outside the profile configuration.
 *
 * The profile's `cordis.patch.yml` holds the operator's **global** defer
 * configuration — hand-written, one row, shared by every project. Auto-tuning
 * must not rewrite it: a machine working across many repositories would have
 * each project's scan clobber the previous one.
 *
 * So auto-tuning writes here instead, into one file per harness home:
 *
 * ```json
 * {
 *   "version": 1,
 *   "projects": {
 *     "/Users/me/Code/api": { "defer": ["Defer(*)"], "noDefer": ["bash", "edit"], "tunedAt": 1790000000000 }
 *   }
 * }
 * ```
 *
 * Resolution precedence is **project override > global config**. A project with
 * an entry uses it; every other project falls back to the global configuration
 * unchanged. Writes are atomic and read-modify-write, so two projects tuning
 * concurrently cannot lose each other's entries.
 * @module @deepseek-ai/dsh-lazy-tools/project-config
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import type { LazyToolsConfig } from './config.ts'
import { sessionsRoot } from './history.ts'

/**
 * In-process write chains, keyed by store path. A read-modify-write is not
 * atomic across concurrent callers, so each write for one store waits for the
 * previous one instead of racing it.
 */
const writes = new Map<string, Promise<void>>()

/** Schema version of the project store, for future migrations. */
export const PROJECT_STORE_VERSION = 1

/** Directory under the harness home holding this plugin's own state. */
export const STORE_DIR_NAME = 'lazy-tools'

/** Filename of the per-project override store. */
export const STORE_FILE_NAME = 'projects.json'

/** One project's tuned defer configuration. */
export interface ProjectOverride {
  /** Defer patterns this project uses. */
  readonly defer: readonly string[]
  /** Tools this project keeps directly callable. */
  readonly noDefer: readonly string[]
  /** Epoch milliseconds of the scan that produced this entry. */
  readonly tunedAt: number
  /** In-window tool calls the ranking was built from. */
  readonly sampleCalls?: number
  /** Sessions that contributed to the ranking. */
  readonly sessions?: number
}

/** The whole on-disk store. */
export interface ProjectStore {
  readonly version: number
  readonly projects: Record<string, ProjectOverride>
}

/** Absolute path of the project store for one harness home. */
export function storePath(home?: string): string {
  // `sessionsRoot` already resolves the harness home the same way DSH does.
  return join(dirname(sessionsRoot(home)), STORE_DIR_NAME, STORE_FILE_NAME)
}

/** Validate one parsed override, dropping anything malformed. */
function parseOverride(value: unknown): ProjectOverride | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const row = value as Record<string, unknown>
  const strings = (input: unknown): string[] | undefined => {
    if (!Array.isArray(input)) return undefined
    const list = input.filter((item): item is string => typeof item === 'string')
    return list.length === input.length ? list : undefined
  }
  const defer = strings(row['defer'])
  const noDefer = strings(row['noDefer'])
  if (defer === undefined || noDefer === undefined) return undefined
  const tunedAt = typeof row['tunedAt'] === 'number' ? row['tunedAt'] : 0
  const sampleCalls = typeof row['sampleCalls'] === 'number' ? row['sampleCalls'] : undefined
  const sessions = typeof row['sessions'] === 'number' ? row['sessions'] : undefined
  return {
    defer,
    noDefer,
    tunedAt,
    ...sampleCalls === undefined ? {} : { sampleCalls },
    ...sessions === undefined ? {} : { sessions },
  }
}

/**
 * Read the whole store synchronously.
 *
 * Plugin install runs before any session exists, so the store can be loaded
 * once up front and every request served from memory. A partial read on the
 * request path would make the very first request of a session ignore an
 * existing override, which is exactly the case this layering must handle.
 * @param home - harness home override.
 * @returns the parsed store, always with a `projects` object.
 */
export function readStoreSync(home?: string): ProjectStore {
  const empty: ProjectStore = { version: PROJECT_STORE_VERSION, projects: {} }
  let text: string
  try {
    text = readFileSync(storePath(home), 'utf8')
  } catch {
    return empty
  }
  return parseStore(text) ?? empty
}

/**
 * Read the whole store. A missing, unreadable, or corrupt file reads as empty:
 * a bad store must never prevent the plugin from loading, it only means every
 * project falls back to the global configuration.
 * @param home - harness home override.
 * @returns the parsed store, always with a `projects` object.
 */
export async function readStore(home?: string): Promise<ProjectStore> {
  try {
    return parseStore(await readFile(storePath(home), 'utf8'))
      ?? { version: PROJECT_STORE_VERSION, projects: {} }
  } catch {
    return { version: PROJECT_STORE_VERSION, projects: {} }
  }
}

/** Parse store text, returning undefined when it is not a usable store. */
function parseStore(text: string): ProjectStore | undefined {
  try {
    const parsed: unknown = JSON.parse(text)
    if (parsed === null || typeof parsed !== 'object') return undefined
    const raw = (parsed as { projects?: unknown }).projects
    if (raw === null || typeof raw !== 'object') return undefined
    const projects: Record<string, ProjectOverride> = {}
    for (const [cwd, value] of Object.entries(raw as Record<string, unknown>)) {
      const override = parseOverride(value)
      if (override !== undefined) projects[cwd] = override
    }
    const version = (parsed as { version?: unknown }).version
    return { version: typeof version === 'number' ? version : PROJECT_STORE_VERSION, projects }
  } catch {
    return undefined
  }
}

/**
 * Read one project's override, if it has one.
 * @param cwd - absolute project working directory.
 * @param home - harness home override.
 * @returns the override, or undefined when the project falls back to global.
 */
export async function readProjectOverride(cwd: string, home?: string): Promise<ProjectOverride | undefined> {
  return (await readStore(home)).projects[cwd]
}

/**
 * Upsert one project's override, preserving every other project's entry.
 *
 * Read-modify-write with an atomic rename: concurrent tuning of two different
 * projects cannot interleave into a lost update, and a crash mid-write leaves
 * the previous store intact.
 * @param cwd - absolute project working directory.
 * @param override - the configuration to record for it.
 * @param home - harness home override.
 */
export async function writeProjectOverride(
  cwd: string,
  override: ProjectOverride,
  home?: string,
): Promise<void> {
  const path = storePath(home)
  // Serialize within this process: the read-modify-write below is not atomic
  // across concurrent callers, and two projects tuning at once would otherwise
  // lose one entry. Each write chains onto the previous one for the same store.
  const previous = writes.get(path) ?? Promise.resolve()
  const run = previous.then(async (): Promise<void> => {
    const store = await readStore(home)
    const next: ProjectStore = {
      version: PROJECT_STORE_VERSION,
      projects: { ...store.projects, [cwd]: override },
    }
    await mkdir(dirname(path), { recursive: true })
    // A per-call unique suffix keeps two processes from sharing a temp name.
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
    await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
    await rename(temporary, path)
  })
  // The chain must survive a failed write, but the caller still sees the error.
  writes.set(path, run.catch(() => {}))
  await run
}

/**
 * Apply a project override on top of the global configuration.
 *
 * An override replaces the pattern pair wholesale rather than merging: a
 * project tuned to `Defer(*)` plus 14 active tools must not inherit the
 * global `defer` list, or tools would be deferred by both rules with no way to
 * re-enable them per project. Global knobs that are not part of the pattern set
 * (the auto-tune settings) are preserved.
 * @param global - the operator's global configuration.
 * @param override - the project's tuned configuration, if any.
 * @returns the configuration in force for that project.
 */
export function applyProjectOverride(
  global: LazyToolsConfig,
  override: ProjectOverride | undefined,
): LazyToolsConfig {
  if (override === undefined) return global
  return { ...global, defer: [...override.defer], noDefer: [...override.noDefer] }
}

/**
 * Whether a stored entry was already refreshed on the same local calendar day
 * as `now`.
 *
 * Auto-tuning refreshes a project at most once per day, and "a day" means a
 * local calendar day rather than a rolling 24 hours: the scan ranks a
 * day-granular window, so letting a project re-tune on every restart would
 * spend the work without changing the answer. A missing or non-positive stamp
 * is always stale, so a hand-written entry never blocks its first scan.
 *
 * Comparison is by local date components rather than by subtracting
 * timestamps, so it stays correct across DST transitions (where a local day is
 * 23 or 25 hours long).
 *
 * @param tunedAt - epoch milliseconds of the last refresh.
 * @param now - epoch milliseconds to compare against; defaults to now.
 * @returns true when the entry is still current for its local day.
 */
export function isFreshForToday(tunedAt: number | undefined, now: number = Date.now()): boolean {
  if (tunedAt === undefined || !Number.isFinite(tunedAt) || tunedAt <= 0) return false
  const previous = new Date(tunedAt)
  const current = new Date(now)
  return previous.getFullYear() === current.getFullYear()
    && previous.getMonth() === current.getMonth()
    && previous.getDate() === current.getDate()
}

/**
 * Whether a project's override may be refreshed at `now`.
 * @param existing - the project's current entry, if any.
 * @param now - epoch milliseconds to compare against.
 * @returns true when no refresh has happened yet on this local day.
 */
export function needsRefresh(existing: ProjectOverride | undefined, now: number = Date.now()): boolean {
  return !isFreshForToday(existing?.tunedAt, now)
}

/** Compare two string lists for order-sensitive equality. */
function sameList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

/**
 * Whether a stored override already matches what a fresh scan produced.
 * @param existing - the project's current entry, if any.
 * @param tuned - the freshly computed pattern pair.
 * @returns true when writing would be a no-op.
 */
export function isAlreadyTuned(
  existing: ProjectOverride | undefined,
  tuned: { readonly defer: readonly string[]; readonly noDefer: readonly string[] },
): boolean {
  if (existing === undefined) return false
  return sameList(existing.defer, tuned.defer) && sameList(existing.noDefer, tuned.noDefer)
}