# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Settings page in the Web/Desktop UI.** The plugin now ships a browser half
  (`dsh.client` plus `lib/client.js`) that renders a **Lazy tools** tab under
  **Settings → Built-in plugins**, beside the feature-owned configuration tabs
  the installation already ships (the read-only inventory, the suggested-prompt
  route card). All six configuration fields
  are editable there — `defer` and `noDefer` as comma-separated boxes, the
  auto-tune switch, and the three auto-tune numbers — with staged edits, a
  per-field **Overridden** badge and **Reset to default**, and a single save. The
  `defer` / `noDefer` boxes show the shipped preset while the pattern pair is
  unconfigured, so the displayed value always matches what the plugin enforces. A
  save is
  written as a revision-fenced settings mutation against the plugin's own entry,
  so a concurrent change is reported rather than silently overwritten. The page
  registers through `configForms.whileServed` and exists only while the Host
  serves the `lazy-tools` namespace, so a deployment that never loaded the plugin
  shows no trace of it.
- **Live configuration updates.** Every `Config` field is now `.volatile()`, and
  the plugin reads its configuration through those references on each request
  instead of snapshotting them at install. A save on the settings page therefore
  takes effect on the next model request with no restart: the edit commits into
  the running references, the plugin re-ranks every live agent on
  `loader/volatile-update`, and per-project overrides still take precedence over
  the edited global layer.
- **Browser-verified rendering, and the two defects that fixed.** Driving the
  real client in headless Chromium surfaced two problems no Node-side test could
  see. First, the store's `getSnapshot` rebuilt its projection on every call, so
  React re-rendered forever and threw "Maximum update depth exceeded" (#185),
  rendering the page blank; the projection is now cached and invalidated only on
  change. Second, `defer`/`noDefer` were rendered one-entry-per-line, but the
  shared `SettingsValueField` is a single-line `<input>`, which strips newlines —
  `bash, read` displayed as `bashread` and was written back as a single tool name,
  corrupting the list. Both fields are now comma-separated (newlines still
  accepted), which round-trips intact. Each fix carries a regression test that was
  confirmed to fail against the old behavior.
- **`pnpm run verify:client`.** A check for the three rules the *browser kernel*
  enforces and the build does not — register a factory under the package name,
  require only shell-provided modules, and export the activatable face. It runs
  the real built bundle through a stand-in module loader, so a packaging mistake
  fails here instead of showing up as a blank page at runtime. Wired into
  `pnpm run check`.
- **Zero-config default preset.** A fresh install defers the long tail and keeps
  `read`, `write`, `edit`, `bash`, `glob`, `grep`, `web_search`, `web_fetch`,
  `ask_user_question` and `skill` directly callable, so the plugin is useful
  without writing any configuration. Naming `defer` or `noDefer` replaces the
  preset entirely, so `defer: []` still means "defer nothing".
- **Per-project auto-tuning.** The first session to report a working directory
  mines that project's last 30 days of persisted session history
  (`~/.dsh/sessions/<project>/`), ranks tools by `tool/call` frequency, and
  keeps the top `autoTuneTopN` (20 by default) active while deferring the rest.
  A `defer_execute_tool` call counts as usage of the tool it activates, so a
  tool the model keeps reaching for promotes itself out of the deferred set.
  Tuning is skipped entirely below `autoTuneMinSamples` (200) in-window calls,
  and a project is refreshed at most once per local calendar day.
- **Global + per-project configuration layers.** The `defer`/`noDefer` written
  in the profile is the global rule for every project; auto-tuning records its
  result in a separate per-project store (`~/.dsh/lazy-tools/projects.json`)
  keyed by absolute project path. Precedence is project override > global, and a
  project entry replaces the pattern pair rather than merging it, so a global
  `Defer(git_*)` cannot keep deferring a tool inside a tuned project. The global
  configuration is never rewritten by a scan.
- CI workflow (lint, both typechecks, tests and build on Node 22 and 24),
  Dependabot configuration, issue and pull-request templates, and the standard
  community files (`LICENSE`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`,
  `SECURITY.md`).

### Fixed

- Deferred loading now works on the Web/Desktop surfaces. Those surfaces mount
  every model-facing tool through a per-session agent preset, so the global tool
  layer the plugin used to read is empty there and nothing was ever deferred.
  Hiding now happens on the model-facing `system-prompt/assemble` list — which
  is plane-agnostic — and the registry is left untouched.
- `tool_search` reports `unavailable` for an exact name it cannot reach instead
  of silently returning an empty result.
- The reserved `run_code` transport is pinned as a guard, so `Defer(*)` cannot
  leave a PTC-mode agent with no tools at all.
- The `defer` and `noDefer` boxes no longer render empty on an unconfigured
  install (#186). The settings plane drops any field whose projected value is
  `undefined`, and this plugin deliberately left the pattern pair undefined while
  unconfigured, so both boxes displayed nothing while the Host was in fact
  deferring the long tail — the form claimed "defer nothing" about a deployment
  doing the opposite. The shipped preset is now resolved at the display layer, so
  the box shows the enforced value without altering it.

### Changed

- The plugin's listeners fail open: a defect there logs a warning and offers
  every tool, rather than failing a model request or a registry mutation.

### Removed

- **`deferToolLoading`.** It duplicated `defer: []`, which already meant "defer
  nothing", so the two could only disagree. Switching deferring off is now that
  empty list. A profile row still carrying the key keeps working: the schema no
  longer declares it, so Cordis ignores the unknown field, and an explicit
  `defer: []` is what actually expresses the intent. Deployments relying on
  `deferToolLoading: false` alone should write `defer: []` instead.

## [0.0.1] - 2026-08-14

### Added

- CodeBuddy-style deferred tool loading for DeepSeek Harness: `tool_search`,
  `defer_execute_tool`, the `tools/pre-execute` guard, and the
  `Defer(...)` / `NoDefer(...)` / `deferToolLoading` configuration surface.

[Unreleased]: https://github.com/studyzy/dsh-lazy-tools/compare/master...HEAD
[0.0.1]: https://github.com/studyzy/dsh-lazy-tools/releases/tag/v0.0.1
