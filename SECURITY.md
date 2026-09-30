# Security Policy

## Supported versions

The plugin is consumed straight from git (a DSH profile links this repository)
and tracks DeepSeek Harness releases. Only the current `master` is supported.

| Version | Supported |
| --- | --- |
| latest `master` | ✅ |
| any older commit | ❌ |

## Reporting a vulnerability

Please **do not open a public issue** for a security problem.

Report it privately to **studyzy@gmail.com** with:

- what the problem is and how it can be triggered,
- the affected commit (or version) and your DeepSeek Harness version,
- a minimal reproduction, if you have one.

You can expect an acknowledgement within a few days. Once a fix is ready it
lands on `master` and is credited in [CHANGELOG.md](CHANGELOG.md), unless you ask
to stay anonymous.

## Scope notes

`dsh-lazy-tools` is a **pure exposure-control layer**. It is worth knowing what
that means when judging a report:

- It never executes, proxies, or rewrites a tool call. It only removes deferred
  tools from the per-scope tool list the model is offered, and lets the model
  put them back with `tool_search` / `defer_execute_tool`.
- It never touches the filesystem, the network, credentials, or the session log;
  the only state it keeps is an in-memory catalog and activation set per agent.
- A tool that the host denies (approval policy, sandbox, another `restrict()`)
  stays denied: this plugin only subtracts from the model-facing list and never
  widens another policy.
- Hiding a tool is **not** a security boundary. A tool the model cannot see is
  still registered and still executes if it is somehow called; the host's own
  policy remains the enforcement point.

Reports that boil down to "the model could not see a tool" or "the model
activated a tool it was allowed to activate" are therefore expected behaviour,
not vulnerabilities.
