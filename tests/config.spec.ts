import { describe, it, expect } from 'vitest'
import { RUN_CODE_NAME } from '@deepseek-ai/dsh-tools'
import {
  applyDefaultPreset,
  compilePattern,
  DEFAULT_ACTIVE_TOOLS,
  DEFER_ALL_ENTRY,
  parseEntry,
  resolveDeferConfig,
  type LazyToolsConfig,
} from '../src/config.ts'

const ALL_TOOLS = [
  'read',
  'bash',
  'edit',
  'write',
  'glob',
  'web_search',
  'tool_search',
  'defer_execute_tool',
  RUN_CODE_NAME,
]

/** Core tools plus a few long-tail ones, for the preset assertions. */
const PRESET_CATALOG = [
  'read',
  'write',
  'edit',
  'bash',
  'glob',
  'grep',
  'read_image',
  'todo_write',
  'subagent',
  'web_search',
  'tool_search',
  'defer_execute_tool',
  RUN_CODE_NAME,
]

function resolve(cfg: LazyToolsConfig): { defer: string[]; noDefer: string[]; enabled: boolean } {
  const r = resolveDeferConfig(ALL_TOOLS, cfg)
  return { defer: [...r.deferNames].sort(), noDefer: [...r.noDeferNames].sort(), enabled: r.enabled }
}

describe('parseEntry', () => {
  it('bare name defers in the defer list', () => {
    expect(parseEntry('bash', 'defer')).toEqual({ action: 'defer', pattern: 'bash' })
  })

  it('bare name nodefers in the noDefer list', () => {
    expect(parseEntry('bash', 'noDefer')).toEqual({ action: 'noDefer', pattern: 'bash' })
  })

  it('defaults bare names to defer', () => {
    expect(parseEntry('glob')).toEqual({ action: 'defer', pattern: 'glob' })
  })

  it('parses Defer(...) wrapped entry', () => {
    expect(parseEntry('Defer(fetch_*)', 'noDefer')).toEqual({ action: 'defer', pattern: 'fetch_*' })
  })

  it('parses NoDefer(...) wrapped entry', () => {
    expect(parseEntry('NoDefer(bash)', 'defer')).toEqual({ action: 'noDefer', pattern: 'bash' })
  })

  it('is case-insensitive for modifiers', () => {
    expect(parseEntry('defer(bash)')).toEqual({ action: 'defer', pattern: 'bash' })
    expect(parseEntry('NoDefer(bash)')).toEqual({ action: 'noDefer', pattern: 'bash' })
  })

  it('rejects nested modifiers', () => {
    expect(parseEntry('Defer(NoDefer(bash))')).toBeNull()
    expect(parseEntry('NoDefer(Defer(bash))')).toBeNull()
  })

  it('rejects empty modifiers', () => {
    expect(parseEntry('Defer()')).toBeNull()
    expect(parseEntry('NoDefer()')).toBeNull()
  })

  it('rejects blank input', () => {
    expect(parseEntry('   ')).toBeNull()
    expect(parseEntry('')).toBeNull()
  })
})

describe('compilePattern', () => {
  it('matches exact names without wildcards', () => {
    const m = compilePattern('bash')
    expect(m('bash')).toBe(true)
    expect(m('bashful')).toBe(false)
  })

  it('matches leading wildcards', () => {
    const m = compilePattern('fetch_*')
    expect(m('fetch_a')).toBe(true)
    expect(m('fetch_')).toBe(true)
    expect(m('fetch_util')).toBe(true)
    expect(m('other')).toBe(false)
  })

  it('matches trailing wildcards', () => {
    const m = compilePattern('*_search')
    expect(m('web_search')).toBe(true)
    expect(m('_search')).toBe(true)
    expect(m('search')).toBe(false)
  })

  it('Defer(*) matches everything', () => {
    const m = compilePattern('*')
    expect(m('anything')).toBe(true)
    expect(m('')).toBe(true)
  })

  it('escapes regex metacharacters in literal segments', () => {
    const m = compilePattern('mcp__github__*')
    expect(m('mcp__github__pr')).toBe(true)
    expect(m('mcp__x')).toBe(false)
  })
})

describe('resolveDeferConfig', () => {
  it('does not defer anything by default', () => {
    const r = resolve({})
    expect(r.defer).toEqual([])
    expect(r.enabled).toBe(true)
  })

  it('defers a bare tool name', () => {
    const r = resolve({ defer: ['glob'] })
    expect(r.defer).toEqual(['glob'])
  })

  it('noDefer bare name protects against Defer(*)', () => {
    const r = resolve({ defer: ['Defer(*)'], noDefer: ['bash'] })
    // bash must stay active; guards never deferred; everything else deferred.
    expect(r.defer).toEqual(['edit', 'glob', 'read', 'web_search', 'write'])
    expect(r.noDefer).toEqual(['bash'])
  })

  it('NoDefer(...) wrapped name wins over Defer(*)', () => {
    const r = resolve({ defer: ['Defer(*)'], noDefer: ['NoDefer(bash)'] })
    expect(r.defer).toEqual(['edit', 'glob', 'read', 'web_search', 'write'])
    expect(r.noDefer).toEqual(['bash'])
  })

  it('guard tools are never deferred', () => {
    const r = resolve({ defer: ['Defer(*)'] })
    expect(r.defer.includes('tool_search')).toBe(false)
    expect(r.defer.includes('defer_execute_tool')).toBe(false)
    // The reserved PTC transport is the only tool a ptc-mode agent sees, so it
    // must survive Defer(*) too.
    expect(r.defer.includes(RUN_CODE_NAME)).toBe(false)
    // Everything else, bash included, is deferred.
    expect(r.defer).toContain('bash')
  })

  it('deferToolLoading=false disables deferring', () => {
    const r = resolve({ defer: ['Defer(*)'], deferToolLoading: false })
    expect(r.defer).toEqual([])
    expect(r.enabled).toBe(false)
  })
})

describe('applyDefaultPreset', () => {
  it('ships a zero-config preset: defer everything, keep the coding core callable', () => {
    const patterns = applyDefaultPreset({})
    expect(patterns.defer).toEqual([DEFER_ALL_ENTRY])
    expect(patterns.noDefer).toEqual([...DEFAULT_ACTIVE_TOOLS])
    expect(patterns.deferToolLoading).toBe(true)

    // The compiled result must leave exactly the core callable and defer the
    // long tail.
    const compiled = resolveDeferConfig(PRESET_CATALOG, patterns)
    expect([...compiled.deferNames].sort()).toEqual(['read_image', 'subagent', 'todo_write'])
    expect(PRESET_CATALOG.filter((name) => !compiled.deferNames.has(name)).sort()).toEqual([
      'bash',
      'defer_execute_tool',
      'edit',
      'glob',
      'grep',
      'read',
      'run_code',
      'tool_search',
      'web_search',
      'write',
    ])
  })

  it('keeps deferToolLoading=false meaningful without other config', () => {
    const patterns = applyDefaultPreset({ deferToolLoading: false })
    expect(resolveDeferConfig(PRESET_CATALOG, patterns).deferNames.size).toBe(0)
  })

  it('lets an explicit config replace the preset entirely', () => {
    // Naming `defer` must not silently re-protect the name through the preset
    // core: `defer: ['glob']` defers glob even though glob ships in the core.
    const patterns = applyDefaultPreset({ defer: ['glob'] })
    expect(patterns.defer).toEqual(['glob'])
    expect(patterns.noDefer).toEqual([])
    expect([...resolveDeferConfig(PRESET_CATALOG, patterns).deferNames]).toEqual(['glob'])
  })

  it('keeps an explicit empty defer meaning "defer nothing"', () => {
    const patterns = applyDefaultPreset({ defer: [] })
    expect(patterns.defer).toEqual([])
    expect(patterns.noDefer).toEqual([])
    expect(resolveDeferConfig(PRESET_CATALOG, patterns).deferNames.size).toBe(0)
  })

  it('lets an explicit noDefer stand alone', () => {
    const patterns = applyDefaultPreset({ noDefer: ['bash'] })
    expect(patterns.defer).toEqual([])
    expect(patterns.noDefer).toEqual(['bash'])
  })
})
