import { describe, expect, it } from 'vitest'
import { SessionQueryEngine } from '@deepseek-ai/dsh-session-query'
import { mine } from '../src/autotune.ts'
import type { Context } from '@deepseek-ai/cordis'

/**
 * `mine()` reads `ctx.sessionQuery` structurally. Nothing else would catch the
 * service drifting from the shape it depends on: the scan would silently fall
 * back to decoding JSONL files and still appear to work.
 *
 * The assertions below run against the real service class at runtime, because
 * the published `.d.ts` chain does not survive type resolution from a test
 * tsconfig (its relative `./cursor.ts` imports resolve to `any` there). A
 * runtime check cannot be fooled that way.
 */
describe('sessionQuery structural contract', () => {
  const proto = SessionQueryEngine.prototype as unknown as Record<string, unknown>

  it('declares the methods mine() calls, on the prototype', () => {
    expect(typeof proto['listSessions']).toBe('function')
    expect(typeof proto['readSession']).toBe('function')
  })

  it('takes at most one abort signal, so mine() can call it bare', () => {
    // `mine()` calls `query.listSessions()` with no arguments at all.
    expect(proto['listSessions']).toHaveLength(1)
    expect(String(proto['listSessions'])).toMatch(/listSessions\(\s*signal\b/)
  })

  it('readSession requires exactly the session id', () => {
    expect(proto['readSession']).toHaveLength(1)
  })

  it('takes the session id as readSession\'s only required input', () => {
    // `mine()` passes a bare id string, so the first parameter must not need a
    // wrapper object.
    const source = String(proto['readSession'])
    expect(source).toMatch(/readSession\s*\(\s*sessionId/)
  })

  it('keeps mine() tolerant of a service missing listSessions', async () => {
    // A structural read must degrade, not throw, when the service is absent or
    // shaped differently.
    const ctx = { get: () => undefined, logger: { warn: () => {}, info: () => {} } } as unknown as Context
    await expect(mine(ctx, '/nonexistent-project', {
      enabled: true, windowDays: 30, topN: 20, minSamples: 0, home: '/nonexistent-home',
    })).resolves.toBeUndefined()
  })
})
