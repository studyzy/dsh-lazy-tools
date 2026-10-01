/**
 * Suite-wide guard: never let a test touch the developer's real harness home.
 *
 * The plugin resolves its state and session directories through `$DSH_HOME`,
 * falling back to `~/.dsh`. A test that forgets to inject an explicit `home`
 * would therefore read and write the real `~/.dsh`, which is exactly how a
 * stray `/Users/dev/proj` entry once appeared in a live project store.
 *
 * Pinning `$DSH_HOME` to a throwaway directory turns any such omission into a
 * harmless write under the OS temp directory. Tests that assert on a specific
 * store still pass their own home explicitly and are unaffected.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll } from 'vitest'

// Resolve before reassigning, so cleanup removes the directory we created.
const sandboxHome = mkdtempSync(join(tmpdir(), 'lazy-tools-dsh-home-'))
process.env['DSH_HOME'] = sandboxHome

afterAll(() => {
  rmSync(sandboxHome, { recursive: true, force: true })
})