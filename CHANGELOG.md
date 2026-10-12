# Changelog

## [0.1.0] - 2026-10-12

### Added

- Spawn gate on the main session's `task` calls, before omp's "Allow tool: task" prompt: a named owner (`--subagent-owner` or `owner`), permitted agents only, no eval-defined `tools`, the agent's definition resolved by omp's own discovery to its pinned file with a narrow tool list and no spawns, no isolated spawn while a guard file is git-ignored inside the project, and a per-run spawn cap. Reasons never say how to switch a rule off.
- `before_subagent_spawn` handler for omp 18.2.11 and later: refuses spawns not made through the `task` tool, agents that are not permitted, spawns past the cap, nested spawns, and its own failures.
- Subagent recognition through `ctx.agent` (omp 18.3.2 and later) or omp's `session_init` entry (18.2.8), with state shared through `globalThis`, because an isolated subagent imports a fresh copy of the guard.
- Per-call checks in every subagent: a tool list; `hub` for messaging and inspection only, because its `start` op launches any program and omp adds `hub` to subagents; protected paths (`.env`, `.env.*`, `.envrc`, `.git/`, `.omp/`, `~/.omp/` outside the subagent's own isolation copy, the guard's own files, and `protect` globs); a per-agent `writeScope`, with other writes sent to the owner on the main session's screen and refused on Deny, after `askTimeoutMs`, with no screen, or on an error.
- Subagents whose agent is not permitted, or that start past the cap, have every call refused; a subagent with no main session behind it too.
- Protected-path check on the main session's writes.
- JSONL audit log per run that links each spawn to its subagent, the subagent's decisions, and its patch path; a warning when a task result names a subagent that never reported to the guard; reservation release when the owner denies a task at omp's prompt.
- `/subagents` command, and the `omp-subagent-guard` CLI with `preflight` (configuration, owner, agent pinning, overlay rules, guard reachability for isolated copies, with `--isolation` building a real copy) and `report`.
- The `scoped-worker` agent definition and an overlay with `prompt` rules for `bash`, `eval`, and `hub`, `task.maxRecursionDepth: 1`, `task.maxRuntimeMs`, and `task.isolation.apply: false`.
- Tests through omp's own extension loader and runner, run with a temporary HOME by `bun run test`; opt-in live tests on real omp 18.2.8 with a scripted test model.

### Not yet done

- Threat model (STRIDE, OWASP LLM Top 10, OWASP Agentic): not run.
- Independent security audit: not run.
- Tests on omp 18.2.11 and later; the interactive TUI; background (async) subagents.
- More than one real-model run.
- First run of the GitHub Actions workflow.
