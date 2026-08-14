<div align="center">

# dsh-lazy-tools

**CodeBuddy-style deferred tool loading for DeepSeek Harness.**

A `tool_search` + `defer_execute_tool` overlay that keeps tool schemas out of
the model's context until they are actually needed.

*Reduce token usage · shrink the context window · keep tooling discoverable*

[中文](README.md)

</div>

---

## What it does

Most coding agents put the JSON Schema of *every* available tool into the
prompt — even tools the model never ends up using. `dsh-lazy-tools` flips that
model around: tools are **deferred** by default and only enter the context
when the model asks for them.

Deferred tools are removed from the agent's visible tool set, so their schemas
(and names) never reach the model context. The model discovers them on demand
through `tool_search`, then calls them directly after activation.

This is a **pure exposure-control layer**:

- It does **not** own or implement any tools.
- Deferred tools are global-registry tools (including third-party/MCP tools);
  this plugin only holds their `name` / `description` / `parameters` for
  discovery.
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
- ⚡ **Lazy activation** — matched tools are added to the agent's visible set
  and become directly callable from the next model request.
- ⚡ **Activate by name** — `defer_execute_tool` activates a known tool by its
  exact name.
- 🧭 **Non-intrusive** — visibility is filtered via `ctx.tools.restrict()` on
  `agent.ctx`, intersecting with existing parent/child restrictions and never
  widening any other policy.
- 🎛️ **Flexible configuration** — CodeBuddy-style `Defer(...)` / `NoDefer(...)`
  patterns with `*` wildcards and a global `deferToolLoading` switch.
- 🛡️ **Self-safe guards** — `tool_search` and `defer_execute_tool` are
  registered on the agent's own scope and never deferred, so `Defer(*)` cannot
  lock the system out.

## Installation

Install from the GitHub repository as an external bundle:

```bash
dsh plugin --profile <profile> add git:github.com/studyzy/dsh-lazy-tools
```

> You may also `git clone` it locally and install from the directory. The
> bundle injects a plugin named `lazy-tools` via `cordis.patch.yml`.

## Configuration

Configuration lives in the plugin's `config` field in the profile's
`cordis.yml`, using CodeBuddy-style syntax:

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
| `defer` | `string[]` | `[]` | Tool names or `Defer(pattern)` entries to defer. Bare names are equivalent to `Defer(name)`. `*` is the only wildcard — `Defer(*)` defers everything except the guard tools. |
| `noDefer` | `string[]` | `[]` | Tool names or `NoDefer(pattern)` entries that must stay directly callable. Bare names are equivalent to `NoDefer(name)`. **Always wins over `defer`.** |
| `deferToolLoading` | `boolean` | `true` | Global switch. When `false`, nothing is deferred. |

Modifiers are case-insensitive (`defer(bash)` ≡ `Defer(bash)`). Precedence
(highest first): `noDefer` > `defer` > `deferToolLoading`.

### Examples

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
# Defer the MCP gateway tools by prefix
config:
  defer: ['mcp*']
```

## How it works

| Component | Role |
|---|---|
| `tool_search` | Searches tools that are not currently visible. `tool_names` does an exact lookup, `queries` does a keyword lookup (Chinese and English). Matches are added to the agent's visible set and returned. |
| `defer_execute_tool` | Activates a deferred tool by exact name so the model can call it directly. Useful for activating a tool the model already knows about. |
| Interception | A `tools/pre-execute` listener returns `deny` when the model calls a not-yet-loaded deferred tool directly, pointing back to `tool_search` / `defer_execute_tool`. |
| Activation | Matched tools are written into the agent's `restrict({ allow })` set and become model-visible and directly callable from the next model request. |

### Flow

```
Prompt: only tool_search + defer_execute_tool schemas are visible
   │
   ▼
model: tool_search({ tool_names: ["glob"] })
   │  └─ returns glob's match status, adds it to the agent's visible set
   ▼
next turn: model calls glob directly (full schema now in the tools list)
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
- **Restrictions intersect.** The plugin only installs its own `allow` subset
  and never widens other `restrict` calls (e.g. parent/child policy). A tool
  denied by another policy is reported `unavailable` even when a search matches
  it.
- **State is not persisted across sessions.** The loaded-tool set lives only
  for the current process; a resumed/forked agent re-defers per configuration.
  This avoids writing custom session events that are not registered in
  `KNOWN_SESSION_EVENT_TYPES`.
- **Global tools only.** Tools already registered on the agent's own scope stay
  visible and never enter the deferred catalog.

## Development

```bash
pnpm install
pnpm run typecheck   # TypeScript type check
pnpm test            # vitest unit + integration tests
pnpm run lint        # oxlint
pnpm run build       # tsc + tsdown bundle into lib/
```

## License

This project is released under the MIT License.
