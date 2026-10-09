/**
 * Automatic defer-configuration tuning from this project's session history.
 *
 * Once per project, the first session that reports a working directory is used
 * to mine that project's recent `tool/call` history, rank the tools by use,
 * and rewrite this plugin's own profile configuration so the top
 * {@link DEFAULT_TOP_N} tools stay directly callable while the rest are
 * deferred.
 *
 * Two rules keep the behavior safe rather than surprising:
 *
 * - **A small sample never rewrites anything.** A project needs
 *   {@link DEFAULT_MIN_SAMPLES} invocations in the window before its ranking is
 *   trusted; below that the existing configuration is left alone and the
 *   decision is logged.
 * - **An unchanged result is not rewritten.** The tuned config is compared
 *   against the effective one, so a steady-state project writes at most once
 *   and the loader's hot reload is never triggered for nothing.
 *
 * Writing goes through `ctx.configEditor` — the supported profile-edit path
 * that validates, writes atomically, and reconciles the loader. A composition
 * without that editor logs its recommendation and changes nothing.
 * @module @studyzy/dsh-lazy-tools/autotune
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import {
  DEFAULT_MIN_SAMPLES,
  DEFAULT_TOP_N,
  DEFAULT_WINDOW_DAYS,
  isTrustworthy,
  scanHistory,
  tuneConfig,
  type HistoryRanking,
} from './history.ts'
import {
  isAlreadyTuned,
  needsRefresh,
  readProjectOverride,
  writeProjectOverride,
} from './project-config.ts'

/** Auto-tuning knobs, already resolved from plugin config. */
export interface AutoTuneOptions {
  /** Whether auto-tuning runs at all. */
  readonly enabled: boolean
  /** Size of the mining window in days. */
  readonly windowDays: number
  /** How many ranked tools stay active. */
  readonly topN: number
  /** Minimum in-window invocations required before a rewrite. */
  readonly minSamples: number
  /** Harness home override, threaded through to the history scan. */
  readonly home?: string
  /** Clock override, so the once-a-day rule is testable. */
  readonly now?: number
}

/** Resolve auto-tune options from the raw plugin config. */
export function resolveAutoTuneOptions(config: {
  autoTune?: boolean
  autoTuneWindowDays?: number
  autoTuneTopN?: number
  autoTuneMinSamples?: number
}, home?: string): AutoTuneOptions {
  return {
    enabled: config.autoTune ?? true,
    windowDays: config.autoTuneWindowDays ?? DEFAULT_WINDOW_DAYS,
    topN: config.autoTuneTopN ?? DEFAULT_TOP_N,
    minSamples: config.autoTuneMinSamples ?? DEFAULT_MIN_SAMPLES,
    ...home === undefined ? {} : { home },
  }
}

/** Outcome of one auto-tune attempt, for logging and tests. */
export type AutoTuneOutcome =
  | { readonly kind: 'skipped'; readonly reason: string }
  | { readonly kind: 'throttled'; readonly tunedAt: number }
  | { readonly kind: 'no-history' }
  | { readonly kind: 'insufficient-sample'; readonly ranking: HistoryRanking }
  | { readonly kind: 'unchanged'; readonly ranking: HistoryRanking }
  | { readonly kind: 'applied'; readonly ranking: HistoryRanking; readonly top: readonly string[] }

/** Render one outcome as a single log line. */
export function describeOutcome(outcome: AutoTuneOutcome, topN: number): string {
  switch (outcome.kind) {
    case 'skipped':
      return `lazy-tools: auto-tune skipped (${outcome.reason})`
    case 'throttled':
      return `lazy-tools: auto-tune already refreshed this project on ${new Date(outcome.tunedAt).toDateString()};`
        + ' keeping its override and skipping the scan'
    case 'no-history':
      return 'lazy-tools: auto-tune found no session history for this project; the global configuration applies'
    case 'insufficient-sample':
      return `lazy-tools: auto-tune saw only ${outcome.ranking.totalCalls} tool calls in `
        + `${outcome.ranking.sessionsScanned} session(s); below the minimum sample, the global configuration applies`
    case 'unchanged':
      return `lazy-tools: auto-tune reviewed ${outcome.ranking.totalCalls} tool calls; `
        + `this project's override already matches the top ${topN}`
    case 'applied':
      return `lazy-tools: auto-tune activated the top ${outcome.top.length} tools for this project from `
        + `${outcome.ranking.totalCalls} calls in ${outcome.ranking.sessionsScanned} session(s): ${outcome.top.join(', ')}`
  }
}

/** A `sessionQuery`-shaped reader: list the corpus, then read one raw log. */
interface QueryLike {
  listSessions(signal?: AbortSignal): Promise<Array<{ header: { id: string; cwd?: string } }>>
  readSession(id: string): Promise<{ events: readonly SessionEvent[] }>
}

/**
 * Mine one project's history through `ctx.sessionQuery` when available.
 *
 * The query service is the supported live-preferred read path, so it is
 * preferred over decoding files directly. Any failure in that path degrades to
 * the direct JSONL reader rather than losing the feature.
 * @param ctx - plugin context, consulted for the optional service.
 * @param cwd - project working directory to mine.
 * @param options - resolved auto-tune knobs.
 * @returns the ranking, or undefined when the project has no usable history.
 */
export async function mine(
  ctx: Context,
  cwd: string,
  options: AutoTuneOptions,
): Promise<HistoryRanking | undefined> {
  const query = ctx.get('sessionQuery') as unknown as QueryLike | undefined
  if (query !== undefined) {
    try {
      const records = await query.listSessions()
      const sessionIds = records
        .filter((record) => record.header.cwd === cwd)
        .map((record) => record.header.id)
      if (sessionIds.length > 0) {
        return await scanHistory({
          cwd,
          windowDays: options.windowDays,
          ...options.home === undefined ? {} : { home: options.home },
          sessionIds,
          readEvents: async (id) => (await query.readSession(id)).events,
        })
      }
    } catch {
      // Fall through to the direct reader.
    }
  }
  return await scanHistory({
    cwd,
    windowDays: options.windowDays,
    ...options.home === undefined ? {} : { home: options.home },
  })
}

/**
 * Mine this project's recent history and, when it is trustworthy, record a
 * per-project override keeping the most-used tools active.
 *
 * The override is written to this plugin's own project store, never to the
 * profile configuration: the profile holds the operator's global defer rules,
 * which stay in force for every project without an override of its own.
 *
 * A project is refreshed at most once per local calendar day. The check runs
 * before mining, so a restart on the same day costs no scan at all — the
 * existing entry simply stays in force.
 *
 * @param ctx - plugin context, consulted for the optional `sessionQuery` service.
 * @param cwd - the project working directory to tune for.
 * @param options - resolved auto-tune knobs.
 * @returns the outcome, for logging and tests.
 */
export async function autoTune(ctx: Context, cwd: string, options: AutoTuneOptions): Promise<AutoTuneOutcome> {
  if (!options.enabled) return { kind: 'skipped', reason: 'disabled by configuration' }
  if (cwd.length === 0) return { kind: 'skipped', reason: 'the session has no working directory' }

  const now = options.now ?? Date.now()
  const existing = await readProjectOverride(cwd, options.home)
  if (!needsRefresh(existing, now)) {
    return { kind: 'throttled', tunedAt: existing?.tunedAt ?? now }
  }

  const ranking = await mine(ctx, cwd, options)
  if (ranking === undefined || ranking.ranked.length === 0) return { kind: 'no-history' }
  if (!isTrustworthy(ranking, options.minSamples)) return { kind: 'insufficient-sample', ranking }

  const tuned = tuneConfig(ranking, options.topN)
  if (isAlreadyTuned(existing, tuned)) {
    // The ranking is unchanged, but the day has turned: stamp the entry so the
    // next same-day start skips its scan too.
    await writeProjectOverride(cwd, {
      defer: [...tuned.defer],
      noDefer: [...tuned.noDefer],
      tunedAt: now,
      sampleCalls: ranking.totalCalls,
      sessions: ranking.sessionsScanned,
    }, options.home)
    return { kind: 'unchanged', ranking }
  }

  await writeProjectOverride(cwd, {
    defer: [...tuned.defer],
    noDefer: [...tuned.noDefer],
    tunedAt: now,
    sampleCalls: ranking.totalCalls,
    sessions: ranking.sessionsScanned,
  }, options.home)
  return { kind: 'applied', ranking, top: tuned.top }
}