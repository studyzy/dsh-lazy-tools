# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

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

### Changed

- The plugin's listeners fail open: a defect there logs a warning and offers
  every tool, rather than failing a model request or a registry mutation.

## [0.0.1] - 2026-08-14

### Added

- CodeBuddy-style deferred tool loading for DeepSeek Harness: `tool_search`,
  `defer_execute_tool`, the `tools/pre-execute` guard, and the
  `Defer(...)` / `NoDefer(...)` / `deferToolLoading` configuration surface.

[Unreleased]: https://github.com/studyzy/dsh-lazy-tools/compare/master...HEAD
[0.0.1]: https://github.com/studyzy/dsh-lazy-tools/releases/tag/v0.0.1
