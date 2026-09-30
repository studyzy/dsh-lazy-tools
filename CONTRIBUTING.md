# Contributing

Thanks for taking the time to improve `dsh-lazy-tools`. This is a small plugin,
so the process is short: keep the change focused, keep `pnpm check` green, and
update the docs when behaviour changes.

## Requirements

- Node.js `^22.19.0 || >=24.0.0` (see `engines` in `package.json`)
- pnpm 11.7.0 — the exact version is pinned by `packageManager`, so
  [Corepack](https://nodejs.org/api/corepack.html) (`corepack enable`) is the
  easiest way to get it
- DeepSeek Harness **0.2.0-rc.2** if you want to run the plugin for real; the
  `peerDependencies` in `package.json` pin the exact host packages it is built
  against

## Setup

```bash
pnpm install
pnpm check        # lint + both typechecks + tests + build
```

Individual scripts:

```bash
pnpm run lint             # oxlint
pnpm run typecheck        # tsc, src
pnpm run typecheck:tests  # tsc, src + tests
pnpm test                 # vitest, unit + integration
pnpm run build            # tsc + tsdown -> lib/
```

`lib/` is a build artifact and is gitignored; run `pnpm run build` before
testing the plugin inside a real harness.

## Trying a change inside DeepSeek Harness

Link the checkout into a DSH profile and restart the app (a profile's plugin
list and config are read at boot):

```bash
dsh plugin --profile <profile> add link:$PWD
```

Plugin configuration goes in that profile's `cordis.patch.yml`, as an
id-targeted override of the `lazy-tools` row:

```yaml
- id: lazy-tools
  name: '@deepseek-ai/dsh-lazy-tools'
  config:
    defer: ['Defer(*)']
    noDefer: ['bash']
```

A zero-config install already behaves usefully, so you only need this to
exercise a non-default configuration.

## Project layout

| Path | What lives there |
| --- | --- |
| `src/config.ts` | `Defer(...)` / `NoDefer(...)` parsing, pattern compilation, the shipped default preset |
| `src/index.ts` | The plugin: per-agent state, the `system-prompt/assemble` filter, the call guard |
| `src/tools.ts` | The `tool_search` and `defer_execute_tool` definitions |
| `src/search.ts` | Keyword ranking for `tool_search` |
| `tests/*.spec.ts` | Vitest, using `@deepseek-ai/dsh-agent-loop-testkit` to mount a real loop |

Two things are worth knowing before changing `src/index.ts`:

1. **Hiding happens on the model-facing assembly, not in the registry.** The
   plugin filters the `system-prompt/assemble` waterfall value for the calling
   scope. That keeps it agnostic about where a tool comes from — the host
   composition, a per-session agent preset (where Web/Desktop mount every
   model-facing tool), an MCP server, or a late registration. Do not reintroduce
   registry-side filtering: the global layer is empty on those surfaces.
2. **Listeners fail open.** `system-prompt/assemble` sits on the request path and
   `tools/change` inside registry mutations, so anything added there must catch
   its own errors, log a warning, and leave the caller working. A throw would
   fail a model request or break a tool registration.

`tests/lazy-tools.spec.ts` shows how to mount a stand-in for the preset plane
(tools registered in a scope *above* the agent, with an empty global registry);
extend that when you touch scope handling.

## Commit messages

The history follows [Conventional Commits](https://www.conventionalcommits.org/):
`feat:`, `fix:`, `docs:`, `test:`, `chore:`, `ci:`. Write the subject in the
imperative mood and explain the *why* in the body when it is not obvious.

## Pull requests

- Keep CI green (`pnpm check` locally is the same set of steps).
- Add or update tests for behaviour changes; a bug fix should fail before it
  passes.
- Update `README.md`, `README.en.md` and `CHANGELOG.md` when user-visible
  behaviour, configuration, or compatibility changes.
- Keep both READMEs in sync — they are translations of each other.

## Aligning with a new DeepSeek Harness release

`peerDependencies`, `devDependencies` and the `pnpm-workspace.yaml` release-age
excludes are pinned per DSH release. When DSH moves:

1. Bump every `@deepseek-ai/*` entry to the new version (and `@deepseek-ai/cordis`
   / `@deepseek-ai/schemastery` if they moved).
2. Update the version line in `README.md` / `README.en.md` and `pnpm-workspace.yaml`.
3. `pnpm install && pnpm check`, then note the change in `CHANGELOG.md`.
