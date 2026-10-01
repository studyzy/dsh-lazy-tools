<div align="center">

# dsh-lazy-tools

**CodeBuddy-style deferred tool loading for DeepSeek Harness.**

A `tool_search` + `defer_execute_tool` overlay that keeps tool schemas out of
the model's context until they are actually needed.

*Reduce token usage · shrink the context window · keep tooling discoverable*

[![CI](https://github.com/studyzy/dsh-lazy-tools/actions/workflows/ci.yml/badge.svg)](https://github.com/studyzy/dsh-lazy-tools/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%5E22.19.0%20%7C%7C%20%3E%3D24.0.0-brightgreen)](package.json)

[中文](README.md)

</div>

---

## What it does

Most coding agents put the JSON Schema of *every* available tool into the
prompt — even tools the model never ends up using. `dsh-lazy-tools` flips that
model around: tools are **deferred** by default and only enter the context
when the model asks for them.

**Works out of the box, zero configuration**: the long tail is deferred while a
coding core stays available (`read`, `write`, `edit`, `bash`, `glob`, `grep`,
`web_search`, `web_fetch`, `ask_user_question`, `skill` — see
[Defaults](#defaults)).

Deferred tools are removed from the **tool list the model sees**, so their
schemas (and names) never reach the model context. The model discovers them on
demand through `tool_search`, then calls them directly after activation.

Removal happens on the `system-prompt/assemble` waterfall — the per-scope tool
list the agent loop actually sends (it becomes the request header and the
provider's tool declarations). The plugin never mutates the tool registry, so it
does not care which plane a tool comes from.

This is a **pure exposure-control layer**:

- It does **not** own or implement any tools.
- Deferred tools are ordinary registry tools (host composition, agent preset,
  third-party/MCP tools); this plugin only observes their `name` /
  `description` / `parameters` in the model-facing list for discovery.
- It **cannot proxy execution** — `tool_search` / `defer_execute_tool` only
  *activate* a tool, after which the model calls that tool directly.

Because it is implemented purely at the agent layer, it works with **any model
and any provider** (DeepSeek, OpenAI, Anthropic, Gemini, …) and does not depend
on provider-native deferred-tool protocols such as Anthropic `tool_reference`
or OpenAI's deferred-tool input items.

## Features

- 🔍 **On-demand discovery** — `tool_search` looks tools up by exact name
  (`tool_names`) or by keyword (`queries`, Chinese and English), activating a
  match when found.
- ⚡ **Lazy activation** — matched tools are recorded in the agent's activation
  set and become directly callable from the next model request.
- ⚡ **Activate by name** — `defer_execute_tool` activates a known tool by its
  exact name.
- 🧭 **Non-intrusive** — the registry is never touched: the plugin only
  subtracts from the model-facing tool list on `system-prompt/assemble`, so it
  coexists with every other `restrict`, every tool source, and every plane, and
  never widens another policy.
- 🎛️ **Flexible configuration** — CodeBuddy-style `Defer(...)` / `NoDefer(...)`
  patterns with `*` wildcards and a global `deferToolLoading` switch.
- 🛡️ **Self-safe guards** — `tool_search` and `defer_execute_tool` are
  registered on the agent's own scope and never deferred, and the reserved
  `run_code` transport is pinned the same way, so `Defer(*)` cannot lock the
  system out.
- 📊 **Per-project auto-tuning** — the first session to report a working
  directory scans that project's last 30 days of session history and ranks tools
  by `tool/call` frequency, keeping the top 20 active and deferring the rest.
- 🗂️ **Global + per-project layers** — the global `defer`/`noDefer` you write
  applies to every project; auto-tuning records its result in a separate
  per-project store that overrides the global rules for that project only.
  Precedence is **project override > global**, and the global configuration is
  never rewritten by a scan.

## Installation

Install from the GitHub repository as an external bundle:

```bash
dsh plugin --profile <profile> add git:github.com/studyzy/dsh-lazy-tools
```

> You may also `git clone` it locally and install from the directory. The
> bundle injects a plugin named `lazy-tools` via `cordis.patch.yml`.

### Compatibility

This plugin targets **DeepSeek Harness 0.2.0-rc.2** (`@deepseek-ai/dsh-*`
0.2.0-rc.2, `@deepseek-ai/cordis` 4.0.4, `@deepseek-ai/schemastery` 3.18.4).
Those exact versions are declared in `peerDependencies`, so DSH's plugin
compatibility preflight accepts the bundle:

```bash
# local directory install (refresh the profile dependency tree after changing deps)
dsh plugin --profile <profile> add link:/path/to/dsh-lazy-tools
```

> If a DSH upgrade reports mismatched peers, align `peerDependencies` /
> `devDependencies` to the new `@deepseek-ai/dsh-*` versions, rerun
> `pnpm install && pnpm run check`, then repeat the `add` command above.

## Configuration

**No configuration is required**: with no `config` at all the plugin runs its
built-in preset, which is what you get right after installing it.

### Defaults

| | Contents |
|---|---|
| Deferred | `Defer(*)` — everything but the guards, discovered on demand via `tool_search` |
| Always available | `read`, `write`, `edit`, `bash`, `glob`, `grep`, `web_search`, `web_fetch`, `ask_user_question`, `skill` |
| Guards (never deferred) | `tool_search`, `defer_execute_tool`, `run_code` |

**Naming either `defer` or `noDefer` replaces the preset entirely**, so
everything follows what you wrote: `defer: []` still means "defer nothing", and
`defer: ['glob']` defers exactly `glob` — it is not re-protected just because
`glob` ships in the default core.

Configure only to change that default. Configuration lives in the plugin's
`config` field in the profile's `cordis.patch.yml` (the user patch layer), using
CodeBuddy-style syntax:

```yaml
- id: lazy-tools
  name: '@deepseek-ai/dsh-lazy-tools'
  config:
    defer: ['glob', 'web_search', 'Defer(fetch_*)']
    noDefer: ['bash']
    deferToolLoading: true
```

| Key | Type | Default | Description |
|---|---|---|---|
| `defer` | `string[]` | see Defaults | Tool names or `Defer(pattern)` entries to defer. Bare names are equivalent to `Defer(name)`. `*` is the only wildcard — `Defer(*)` defers everything except the guard tools. |
| `noDefer` | `string[]` | see Defaults | Tool names or `NoDefer(pattern)` entries that must stay directly callable. Bare names are equivalent to `NoDefer(name)`. **Always wins over `defer`.** |
| `deferToolLoading` | `boolean` | `true` | Global switch. When `false`, nothing is deferred. |
| `autoTune` | `boolean` | `true` | Whether to derive `defer`/`noDefer` from this project's session history; see Per-project auto-tuning. |
| `autoTuneWindowDays` | `number` | `30` | Length of the history window in days. |
| `autoTuneTopN` | `number` | `20` | How many of the most-used tools stay active. |
| `autoTuneMinSamples` | `number` | `200` | In-window calls required before the configuration may be rewritten. |

Modifiers are case-insensitive (`defer(bash)` ≡ `Defer(bash)`). Precedence
(highest first): `noDefer` > `defer` > `deferToolLoading`.

## Configuration layers: global + per-project

Configuration resolves in two layers, with **project override > global**:

| Layer | Stored in | Written by | Applies to |
|---|---|---|---|
| **Global** | `config.defer` / `config.noDefer` in the profile's `cordis.patch.yml` | you, by hand | every project |
| **Per-project** | `~/.dsh/lazy-tools/projects.json` | the history scan | that project only |

A generated entry also records `tunedAt` (its last refresh), `sampleCalls` (the
invocations the ranking was built from), and `sessions` (how many contributed),
so you can judge how fresh and how well-supported that configuration is.

Resolution: a project with an entry in the store uses it; every other project
falls back to the global configuration. **Auto-tuning writes only the
per-project store and never touches your global configuration**, so working
across many repositories cannot let one project's scan clobber the rules you
wrote by hand.

What `projects.json` looks like (keys are absolute project paths):

```json
{
  "version": 1,
  "projects": {
    "/Users/me/Code/api": {
      "defer": ["Defer(*)"],
      "noDefer": ["bash", "edit", "read"],
      "tunedAt": 1790000000000,
      "sampleCalls": 412,
      "sessions": 6
    }
  }
}
```

A project entry **replaces** the `defer`/`noDefer` pair rather than merging it:
otherwise a global `Defer(git_*)` would keep applying inside that project and a
tool would be deferred by both rules with no way to re-enable it per project.
Global knobs unrelated to the pattern pair (`deferToolLoading`, the `autoTune*`
settings) are still inherited.

> To clear one project's auto-tuning, delete its entry from `projects.json` (or
> the whole file). That project immediately falls back to the global config.

## Per-project auto-tuning

When enabled (the default), the plugin learns from real usage **per project**:
the first session to report a working directory triggers one scan of that
project's last 30 days of session history, producing that project's entry.

**What it counts**

- The data is DSH's own persisted session logs
  (`~/.dsh/sessions/<project-dir>/`). Every `tool/call` event records one
  invocation.
- **A `defer_execute_tool` call counts toward the tool it activates** — a model
  repeatedly reaching for a deferred tool is exactly the signal that it should
  not have been deferred, so that tool promotes itself to always-active.
- Tools are ranked by in-window call count (ties broken by name), the top
  `autoTuneTopN` become `noDefer`, and `defer: ['Defer(*)']` defers the rest.

**Three safety rails**

- **Refreshed at most once a day.** Each entry records `tunedAt`, the time of its
  last refresh. Starting again on the same **local calendar day** reuses the
  entry as-is and **skips the scan entirely** — no history read, no write. A
  refresh happens only after the local midnight passes, not after 24 hours
  elapse.
- **A small sample never rewrites anything.** Below `autoTuneMinSamples`
  (200 by default) in-window calls the plugin only logs its finding and leaves
  the project on the global configuration, so noise cannot overwrite your rules.
- **Only its own file is written** — `~/.dsh/lazy-tools/projects.json`, never the
  profile configuration.

The rule is a calendar day rather than a rolling 24 hours because the ranking
window itself is day-granular: refreshing at 23:00 yesterday and starting again
at 08:00 today is only nine hours, but the data window has already advanced by a
day, so re-scanning is meaningful. Comparison uses local date components rather
than a timestamp difference, so it stays correct on DST transition days (where a
local day is 23 or 25 hours long).

When a scan finds the ranking unchanged, only the `tunedAt` stamp is advanced
and `defer`/`noDefer` are left as they were — which also throttles the rest of
that day.

The store is read **synchronously** at plugin install, so a session's very first
request already honors an existing override. When a scan completes for a project
in this process, that project's agents are re-ranked immediately, with no
restart. Each project is tuned at most once per process (memoized, including
concurrent de-duplication); writes are atomic replacements and two projects
tuning at once cannot lose each other's entries. Any failure is contained in the
background task, so session startup is never affected.

```yaml
# Adjust the tuning parameters
config:
  autoTuneTopN: 12          # keep only the 12 most-used tools active
  autoTuneWindowDays: 60    # rank over 60 days of history
  autoTuneMinSamples: 50    # let small projects tune too
```

```yaml
# Turn auto-tuning off entirely and use only your global configuration
config:
  autoTune: false
```

```yaml
# Typical setup: one conservative global rule, refined per project by the scan
config:
  defer: ['Defer(*)']
  noDefer: ['bash', 'read', 'edit', 'write']
```

### Examples

```yaml
# Replace the default core with bash only (everything else stays deferred)
config:
  noDefer: ['bash']
```

```yaml
# Defer just these two and keep everything else visible
config:
  defer: ['glob', 'web_search']
```

```yaml
# Defer every fetch_* / web_* tool, keep bash always available
config:
  defer: ['Defer(fetch_*)', 'Defer(web_*)']
  noDefer: ['bash']
```

```yaml
# Defer everything except the guard pair (tool_search / defer_execute_tool)
config:
  defer: ['Defer(*)']
```

```yaml
# Defer everything but keep a small always-on core (noDefer wins over Defer(*))
config:
  defer: ['Defer(*)']
  noDefer: ['read', 'write', 'edit', 'bash']
```

```yaml
# Defer the MCP gateway tools by prefix
config:
  defer: ['mcp*']
```

## How it works

| Component | Role |
|---|---|
| `tool_search` | Searches tools that are not currently visible. `tool_names` does an exact lookup, `queries` does a keyword lookup (Chinese and English). Matches are activated and returned. |
| `defer_execute_tool` | Activates a deferred tool by exact name so the model can call it directly. Useful for activating a tool the model already knows about. |
| Hiding | On `system-prompt/assemble`, deferred tools are filtered out of that scope's model-facing tool list (the registry itself is untouched). |
| Interception | A `tools/pre-execute` listener returns `deny` when the model calls a not-yet-loaded deferred tool directly, pointing back to `tool_search` / `defer_execute_tool`. |
| Activation | Matched tools are recorded in the agent's activation set and appear in the tool list — directly callable — from the next model request. |

### Flow

```
Prompt: only the guards + always-on core schemas are visible (the zero-config default)
   │
   ▼
model: tool_search({ tool_names: ["todo_write"] })
   │  └─ returns the match status, records it in the agent's activation set
   ▼
next turn: model calls todo_write directly (full schema now in the tools list)
```

## Design constraints & known limitations

- **Activation applies from the next turn.** After `tool_search` activates a
  tool, the *current* model request's tool list is already fixed (schemas
  arrive through the next request header), so a direct call in the same turn is
  still intercepted by `tools/pre-execute`. Call it on the next turn after the
  result returns.
- **Deferred tools are invisible until searched.** The model does not see
  deferred tools' names; it relies on `tool_search`'s retrieval to discover
  them.
- **Restrictions compose for free.** The plugin only subtracts from the
  model-facing list and never widens other `restrict` calls (e.g. parent/child
  policy). A tool denied by another policy never reaches the model-facing list
  or the search catalog, so a lookup reports it `unavailable`.
- **Tool origin does not matter.** Host composition, agent presets (on the
  Web/Desktop surfaces every model-facing tool is mounted by a preset), MCP
  servers, and tools registered after the agent was created all go through the
  same deferral/search path.
- **PTC presentation degrades to a no-op.** An agent presented in `ptc` mode
  only sees the reserved `run_code` transport (pinned as a guard, never
  deferred) and reaches other capabilities through the generated SDK; deferral
  does not hide them there — it does not error, it simply has no effect.
- **State is not persisted across sessions.** The loaded-tool set lives only
  for the current process; a resumed/forked agent re-defers per configuration.
  This avoids writing custom session events that are not registered in
  `KNOWN_SESSION_EVENT_TYPES`.
- **Tools in the agent's own scope are never taken over.** Tools registered in
  that agent's own scope (`tool_search` / `defer_execute_tool` themselves) stay
  visible; `Defer(*)` does not apply to them.

## Development

```bash
pnpm install
pnpm run typecheck        # TypeScript type check (src)
pnpm run typecheck:tests  # TypeScript type check (tests)
pnpm test                 # vitest unit + integration tests
pnpm run lint             # oxlint
pnpm run build            # tsc + tsdown bundle into lib/
pnpm run check            # lint + both typechecks + tests + build
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the contribution flow, the source
layout, and how to try a change inside a real harness; [CHANGELOG.md](CHANGELOG.md)
for release history; and [SECURITY.md](SECURITY.md) to report a vulnerability
privately. CI runs lint, both typechecks, tests and the build on Node 22 and 24
(see [.github/workflows/ci.yml](.github/workflows/ci.yml)).

## License

This project is released under the MIT License — see [LICENSE](LICENSE).
