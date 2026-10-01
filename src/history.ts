/**
 * Session-history mining for automatic defer-config tuning.
 *
 * DSH persists every session as an append-only JSONL event log under
 * `dshHomePath('sessions')`, grouped into one human-readable project directory
 * per working directory (`--Users-me-Code-proj--`). Each `tool/call` event
 * records the invoked tool name, so the logs are a complete, ordered record of
 * which tools this project actually uses.
 *
 * This module turns that record into a frequency ranking over a bounded recent
 * window. It reads through `ctx.sessionQuery` when that service is mounted —
 * the supported live-preferred read path — and otherwise decodes the JSONL
 * logs directly, so auto-tuning still works in a composition without the query
 * backend.
 *
 * A `defer_execute_tool` call counts as usage of the tool it activates: the
 * model reaching for a deferred tool is exactly the signal that says "this one
 * should not have been deferred".
 * @module @deepseek-ai/dsh-lazy-tools/history
 */

import { readdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

/** DSH home directory name, mirroring `@deepseek-ai/dsh-home-paths`. */
const DSH_HOME_DIR_NAME = '.dsh'

/** Environment variable overriding the DSH home, mirroring the same package. */
const DSH_HOME_ENV = 'DSH_HOME'

/**
 * Name of the activation tool whose argument names the tool actually used.
 * Duplicated as a literal (not imported) to keep this module dependency-light;
 * {@link DEFAULT_ACTIVE_TOOLS} style single-source checks live in the tests.
 */
const DEFER_EXECUTE_TOOL = 'defer_execute_tool'

/** How many days of history the ranking window covers. */
export const DEFAULT_WINDOW_DAYS = 30

/** How many tools the tuned configuration keeps active. */
export const DEFAULT_TOP_N = 20

/**
 * Total invocations a project needs before its ranking is trusted enough to
 * overwrite an existing configuration. Below this the sample is too small to
 * separate a real habit from an artifact of one short session.
 */
export const DEFAULT_MIN_SAMPLES = 200

/** One tool's usage over the window. */
export interface ToolUsage {
  /** Tool name exactly as recorded in the log. */
  readonly name: string
  /** Number of invocations attributed to this tool. */
  readonly count: number
}

/** Result of mining one project's recent sessions. */
export interface HistoryRanking {
  /** Tools ordered by descending count, then ascending name. */
  readonly ranked: readonly ToolUsage[]
  /** Total invocations observed in the window, including below-cutoff tools. */
  readonly totalCalls: number
  /** Sessions that contributed at least one in-window event. */
  readonly sessionsScanned: number
  /** The project directory that was mined. */
  readonly projectDir: string
}

/** Options controlling one history scan. */
export interface ScanOptions {
  /** Project working directory whose sessions are mined. */
  readonly cwd: string
  /** Injected harness home; defaults to `$DSH_HOME` or `~/.dsh`. */
  readonly home?: string
  /** Window length in days. */
  readonly windowDays?: number
  /** Cutoff instant; defaults to now. Injected for deterministic tests. */
  readonly now?: number
  /** Optional cancellation. */
  readonly signal?: AbortSignal
  /**
   * Event source override. Defaults to the JSONL logs under the harness home;
   * a caller with `ctx.sessionQuery` supplies its own reader instead.
   */
  readonly readEvents?: (sessionId: string) => Promise<readonly SessionEvent[]>
  /** Session ids to read when {@link readEvents} is supplied. */
  readonly sessionIds?: readonly string[]
}

/**
 * Resolve the DSH home exactly as `@deepseek-ai/dsh-home-paths` does.
 * @param home - explicit override, else `$DSH_HOME`, else `~/.dsh`.
 * @returns the absolute harness home path.
 */
export function resolveHome(home?: string): string {
  if (home !== undefined && home.length > 0) return home
  const fromEnv = process.env[DSH_HOME_ENV]
  if (fromEnv !== undefined && fromEnv.trim().length > 0) return fromEnv
  return join(homedir(), DSH_HOME_DIR_NAME)
}

/**
 * The `sessions` root holding one directory per project.
 * @param home - harness home override.
 * @returns the absolute session root path.
 */
export function sessionsRoot(home?: string): string {
  return join(resolveHome(home), 'sessions')
}

/**
 * Encode a working directory into its session project-directory name.
 *
 * Mirrors `projectKey` in `@deepseek-ai/dsh-session-persistence-jsonl`
 * (separators collapse to `-`, other unsafe code units escape as `~XXXX`, the
 * slug is truncated to 251 characters) so the scan can address the directory
 * without importing that backend.
 * @param cwd - the project working directory.
 * @returns the single filesystem-safe project directory name.
 */
export function projectKey(cwd: string): string {
  if (cwd.length === 0) throw new Error('cannot encode an empty project path')
  let readable = ''
  let separatorRun = false
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += '~' + code.toString(16).toUpperCase().padStart(4, '0')
      separatorRun = false
    }
  }
  const slug = readable.replace(/^-+/, '') || 'root'
  return `--${slug.slice(0, 251)}--`
}

/**
 * Attribute one event to a tool name, if it records a tool invocation.
 * @param event - a session event.
 * @param windowStart - inclusive epoch-ms cutoff.
 * @returns the invoked tool name, or undefined when the event is out of scope.
 */
export function invokedTool(event: SessionEvent, windowStart: number): string | undefined {
  if (event.type !== 'tool/call') return undefined
  if (event.time < windowStart) return undefined
  const name = event.data.name
  // An activation call is evidence about the tool it names, not about itself.
  if (name === DEFER_EXECUTE_TOOL) return parseActivationTarget(event.data.arguments)
  return name
}

/**
 * Read the `toolName` argument of a `defer_execute_tool` call.
 * @param raw - the call's raw JSON argument string.
 * @returns the activated tool name, or undefined when absent or malformed.
 */
export function parseActivationTarget(raw: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object') return undefined
    const target = (parsed as { toolName?: unknown }).toolName
    return typeof target === 'string' && target.length > 0 ? target : undefined
  } catch {
    return undefined
  }
}

/** Fold a stream of events into a usage tally. */
function tally(
  events: Iterable<SessionEvent>,
  windowStart: number,
): { counts: Map<string, number>; total: number; used: boolean } {
  const counts = new Map<string, number>()
  let total = 0
  let used = false
  for (const event of events) {
    if (event.type === 'tool/call' && event.time >= windowStart) used = true
    const name = invokedTool(event, windowStart)
    if (name === undefined) continue
    counts.set(name, (counts.get(name) ?? 0) + 1)
    total += 1
  }
  return { counts, total, used }
}

/** Convert a tally into the public ranking shape. */
function toRanking(
  counts: Map<string, number>,
  total: number,
  projectDir: string,
  sessionsScanned: number,
): HistoryRanking {
  const ranked = [...counts.entries()]
    .map(([name, count]): ToolUsage => ({ name, count }))
    // Frequency first; name breaks ties so the result is deterministic.
    .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name))
  return { ranked, totalCalls: total, sessionsScanned, projectDir }
}

/** Zstandard frame magic, little-endian at the start of every frame. */
const ZSTD_MAGIC = 0xfd2fb528

/** One structurally complete frame's byte range within a session artifact. */
interface FrameRange {
  readonly start: number
  readonly end: number
}

/**
 * Locate the complete Zstandard frames in a concatenated session artifact.
 *
 * A session log is a sequence of independently decodable frames, so a
 * single-shot decompress would return only the header. Block headers are
 * walked structurally (no decompression) to find each frame boundary, and an
 * incomplete final frame — a live session mid-append — is reported so its
 * partial bytes are simply skipped.
 * @param buffer - the artifact bytes.
 * @returns complete frame ranges, ignoring a torn tail.
 */
function scanFrames(buffer: Buffer): FrameRange[] {
  const frames: FrameRange[] = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) break
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) break
    offset += 4
    if (offset === buffer.length) break
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 0x18) !== 0) break // reserved frame-header bit
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 0x20) !== 0
    const checksum = (descriptor & 0x04) !== 0
    const dictionaryFlag = descriptor & 0x03
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) break
    offset += remainingHeaderBytes
    let complete = false
    for (;;) {
      if (buffer.length - offset < 3) break
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 0x03
      const blockSize = blockHeader >>> 3
      if (blockType === 0x03) break // reserved block type: not a valid frame
      // A raw block carries its size in the header; RLE carries one byte.
      const payloadBytes = blockType === 0x01 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) break
      offset += payloadBytes
      if (lastBlock) { complete = true; break }
    }
    if (!complete) break
    if (checksum) {
      if (buffer.length - offset < 4) break
      offset += 4
    }
    frames.push({ start, end: offset })
  }
  return frames
}

/**
 * Decode one session artifact into JSONL text.
 *
 * Compressed generations are decoded frame by frame; an uncompressed
 * generation is read as-is. Support is best-effort and never throws: an
 * unreadable or corrupt artifact contributes nothing rather than failing the
 * whole scan.
 * @param path - absolute artifact path.
 * @returns decoded JSONL text, or an empty string when it cannot be read.
 */
async function decodeArtifact(path: string): Promise<string> {
  try {
    const buffer = await readFile(path)
    if (!path.endsWith('.zstd')) return buffer.toString('utf8')
    const { zstdDecompressSync } = await import('node:zlib')
    const chunks: Buffer[] = []
    for (const frame of scanFrames(buffer)) {
      try {
        chunks.push(zstdDecompressSync(buffer.subarray(frame.start, frame.end)))
      } catch {
        // One corrupt frame does not invalidate its neighbours.
      }
    }
    return Buffer.concat(chunks).toString('utf8')
  } catch {
    return ''
  }
}

/** Parse JSONL text into the events this module understands. */
function parseEvents(text: string): SessionEvent[] {
  const events: SessionEvent[] = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    try {
      const parsed: unknown = JSON.parse(trimmed)
      if (parsed !== null && typeof parsed === 'object' && 'type' in parsed) {
        events.push(parsed as SessionEvent)
      }
    } catch {
      // A torn tail is expected on a live log; skip the unusable line.
    }
  }
  return events
}

/**
 * Read every artifact of one persisted session directory.
 * @param dir - the session's directory.
 * @returns the union of its decoded events.
 */
async function readSessionDir(dir: string): Promise<SessionEvent[]> {
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return []
  }
  const logs = entries.filter((entry) => entry.endsWith('.jsonl') || entry.endsWith('.jsonl.zstd'))
  const events: SessionEvent[] = []
  for (const log of logs) events.push(...parseEvents(await decodeArtifact(join(dir, log))))
  return events
}

/**
 * Mine one project's recent tool usage.
 *
 * When {@link ScanOptions.readEvents} is supplied the caller owns event
 * acquisition (the `ctx.sessionQuery` path); otherwise the project's JSONL
 * session logs are decoded directly.
 * @param options - project, window, and event-source selection.
 * @returns the ranking, or undefined when the project has no session history.
 */
export async function scanHistory(options: ScanOptions): Promise<HistoryRanking | undefined> {
  const windowDays = options.windowDays ?? DEFAULT_WINDOW_DAYS
  const now = options.now ?? Date.now()
  const windowStart = now - windowDays * 24 * 60 * 60 * 1000
  const projectDir = join(sessionsRoot(options.home), projectKey(options.cwd))

  const counts = new Map<string, number>()
  let total = 0
  let sessionsScanned = 0

  if (options.readEvents !== undefined) {
    for (const id of options.sessionIds ?? []) {
      if (options.signal?.aborted === true) break
      let events: readonly SessionEvent[]
      try {
        events = await options.readEvents(id)
      } catch {
        continue
      }
      const result = tally(events, windowStart)
      if (!result.used) continue
      sessionsScanned += 1
      total += result.total
      for (const [name, count] of result.counts) counts.set(name, (counts.get(name) ?? 0) + count)
    }
    return sessionsScanned === 0 ? undefined : toRanking(counts, total, projectDir, sessionsScanned)
  }

  let sessionDirs: string[]
  try {
    sessionDirs = await readdir(projectDir)
  } catch {
    return undefined
  }
  for (const sessionDir of sessionDirs) {
    if (options.signal?.aborted === true) break
    const events = await readSessionDir(join(projectDir, sessionDir))
    const result = tally(events, windowStart)
    if (!result.used) continue
    sessionsScanned += 1
    total += result.total
    for (const [name, count] of result.counts) counts.set(name, (counts.get(name) ?? 0) + count)
  }
  return sessionsScanned === 0 ? undefined : toRanking(counts, total, projectDir, sessionsScanned)
}

/** The tuned configuration derived from one ranking. */
export interface TunedConfig {
  /** Tools kept directly callable: the top-N ranking plus the guards. */
  readonly noDefer: readonly string[]
  /** Everything else is matched by this single wildcard entry. */
  readonly defer: readonly string[]
  /** The ranked tools that made the cut, in rank order. */
  readonly top: readonly string[]
}

/**
 * Turn a ranking into the `noDefer`/`defer` pair for the plugin config.
 *
 * The result is a self-contained overlay: `defer: ['Defer(*)']` plus every
 * tool that should stay callable. The plugin's own guards (`tool_search`,
 * `defer_execute_tool`, the run-code transport) are protected by
 * `resolveDeferConfig` regardless, so they are not repeated here unless the
 * ranking genuinely used them.
 * @param ranking - the mined usage ranking.
 * @param topN - how many ranked tools to keep active.
 * @returns the tuned configuration.
 */
export function tuneConfig(ranking: HistoryRanking, topN: number = DEFAULT_TOP_N): TunedConfig {
  const top = ranking.ranked.slice(0, topN).map((usage) => usage.name)
  return { noDefer: top, defer: ['Defer(*)'], top }
}

/**
 * Whether a ranking is a trustworthy basis for rewriting configuration.
 * @param ranking - the mined ranking, if the project had any history.
 * @param minSamples - required total invocations.
 * @returns true when the sample is large enough to act on.
 */
export function isTrustworthy(
  ranking: HistoryRanking | undefined,
  minSamples: number = DEFAULT_MIN_SAMPLES,
): ranking is HistoryRanking {
  return ranking !== undefined && ranking.totalCalls >= minSamples
}