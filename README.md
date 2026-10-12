# omp-subagent-guard

An [oh-my-pi](https://github.com/can1357/oh-my-pi) (omp) extension that keeps your limits on the work an agent delegates. It gates every `task` spawn (a named owner, permitted and pinned agent definitions, a spawn cap, a guard that follows isolated subagents), re-checks every tool call a subagent makes (a tool list, protected paths, a per-agent write scope, with writes outside it sent to the owner's screen), and writes an audit log that links each spawn to what its subagent did and where its patch is.

[中文說明](README.zh-TW.md)

> **Tested on omp 18.2.8 only.** The live tests run real omp end to end with a scripted test model, plus one run with a real model (Claude Opus 5.5 through the cursor-sdk extension). The parts for omp 18.2.11 and 18.3.2 are tested with synthetic events only.

## Why

In omp, a subagent is a new session in the same process, and three things about it are by design:

- **Its tools come from its agent definition, not from the main agent.** A main agent started with `--tools read,task` can spawn the bundled `task` agent, which has no tool list and gets the default 13 tools, `write`, `edit`, `bash`, and `eval` among them.
- **It never asks you.** A subagent has no UI, so omp runs it in `yolo` mode. omp's documentation says: "The parent `task` approval is the authorization boundary." Pressing Allow at "Allow tool: task" signs for everything the subagent does next.
- **omp adds `hub` to every subagent whose definition lists tools, unless all of them are read-only.** `hub` with `op: "start"` launches any program with any arguments. In a live run without this guard, a subagent whose definition lists only `read`, `grep`, `glob`, `find`, `write`, and `edit` started `bash -c "echo probe > canary.txt"` through `hub`, and the canary appeared.

What does follow a subagent is an extension: omp binds every loaded extension to every subagent session, and its `tool_call` handler runs before omp's approval gate. So the only limit that holds for a subagent is one that blocks directly. This package is that limit.

## What it does

| When | Where | What the guard does |
|---|---|---|
| The run starts | main session, `session_start` | Reads the configuration, names the run's owner, opens the audit log, and resolves every permitted agent with omp's own discovery. Tells you when an agent is overridden or too broad, or when there is no owner. |
| The main agent calls `task` | main session, `tool_call` | Refuses the spawn, before omp asks "Allow tool: task", when: the run has no named owner; an item names no agent, or one that is not permitted; an item hands the subagent eval-defined `tools`; the agent's definition in use is not the pinned file (for example a project `.omp/agents/` file of the same name), has no tool list, lists a tool outside the subagent tool list, or may spawn; the spawn is isolated and a guard file sits in a git-ignored part of the project; the run's spawn cap would be passed. The reasons say what was refused, never how to switch a rule off. |
| omp spawns (18.2.11 and later) | main session, `before_subagent_spawn` | Refuses spawns that did not come from the `task` tool (eval `agent()`, workpools), agents that are not permitted, spawns past the cap, and any spawn from inside a subagent. A failure inside the handler refuses too. |
| A subagent starts | subagent, `session_start` | Recognises the session as a subagent (`ctx.agent` from omp 18.3.2; omp's `session_init` entry on 18.2.8), records its id, agent, parent session, working directory kind, and tools. Refuses every call of a subagent whose agent is not permitted (for example one started by eval `agent()` on 18.2.8) or that starts after the cap was reached. |
| Every subagent tool call | subagent, `tool_call` | Refuses tools outside the subagent tool list; `hub` only for messaging and inspection (`list`, `inbox`, `wait`, `jobs`, `ps`, `logs`, `describe`, and `send` to an agent), never to start or drive a process. Refuses `write`, `edit`, and `ast_edit` on protected paths. Lets writes inside the agent's `writeScope` through. Sends any other write to the owner on the main session's screen: Allow writes it; Deny, no answer within `askTimeoutMs`, no screen, or an error refuses it. |
| A `task` call returns | main session, `tool_result` | Records each subagent's result id, exit code, and patch path, and links it to the subagent that reported. A subagent that never reported ran without the guard: you are told, with its patch path. |
| The owner presses Deny at "Allow tool: task" | main session, `tool_approval_resolved` | Releases the spawns the call had reserved. |

If the guard itself fails while checking a call, the call is refused. omp also refuses a tool call whose `tool_call` handler throws or takes more than 30 seconds.

### Protected paths

Nobody in the run, main session or subagent, may write:

- `.env`, `.env.*`, `.envrc`, `.git/`, and `.omp/` at any depth of the session's working directory, and any file named `.env`, `.env.*`, or `.envrc` elsewhere;
- `~/.omp/`, except the isolation copy an isolated subagent works in (`~/.omp/wt/…`);
- this package, its configuration folder, its audit folder, and the file that loads it;
- the globs in `protect`, relative to the working directory.

Paths are followed through `~`, `$HOME`, `..`, and symlinks. A refused write gets `Path "<path>" is protected`.

### Writes outside the scope

A write to a file outside the agent's `writeScope` asks the owner on the main session's screen, with the owner, the agent and its id, the tool, and the path. omp lets a `tool_call` handler run for 30 seconds, and a dialog borrowed from the main session does not pause a subagent's budget, so `askTimeoutMs` must be at most 25 seconds (default 20). In the live test, a write nobody answered was refused after 20.0 seconds.

## Requirements

- omp 18.2.8 (tested). It loads on newer versions and uses `before_subagent_spawn` and `ctx.agent` when they exist; that is not tested.
- [Bun](https://bun.sh) 1.3.14 or newer (tested with 1.4.2).

## Install and start

1. Clone it **outside** every project the agent works on, so the agent cannot change the guard:

   ```bash
   git clone <this repository> ~/omp-subagent-guard
   cd ~/omp-subagent-guard && bun install
   ```

   The extension needs no dependencies at run time; `bun install` is for the tests and the CLI.

2. Write `~/.config/omp-subagent-guard/config.json` (see [`examples/config.example.json`](examples/config.example.json)). The one setting you need is each agent's `writeScope`.

3. Check the setup from the project you will work in:

   ```bash
   bun ~/omp-subagent-guard/bin/omp-subagent-guard.ts preflight --overlay ~/omp-subagent-guard/examples/overlay.yml --isolation
   ```

4. Start omp with the guard, the overlay, a named owner, and a main agent that can only read and delegate:

   ```bash
   omp -e ~/omp-subagent-guard --config ~/omp-subagent-guard/examples/overlay.yml \
     --subagent-owner alice --tools read,task --approval-mode always-ask
   ```

   Loading the package with `-e` also makes omp find its `agents/scoped-worker.md`.

5. Have the main agent delegate to `scoped-worker`. Treat "Allow tool: task" as a high-privilege approval: it signs for the subagent's work. When it is done, run `/subagents` (shown to you only, never sent to the model) and review each patch before you merge it.

## Configuration

`~/.config/omp-subagent-guard/config.json`, or the file named by `--subagent-guard-config`. Nothing is read from the project or from environment variables. A missing file means the defaults; an invalid one is reported at session start, and every spawn is refused until it is fixed.

| Setting | Default | Meaning |
|---|---|---|
| `owner` | none | The run's named owner. `--subagent-owner <name>` wins. Without an owner every spawn is refused. |
| `maxSpawns` | `3` | Subagents one run may start. A spawn is counted when a `task` call asks for it and when the subagent starts. |
| `agents` | `{ "scoped-worker": {} }` | The agents the main agent may spawn. Each has `definition`, the file the agent must resolve to (default: this package's `agents/<name>.md`), and `writeScope`, globs relative to the subagent's working directory that it may write without asking (default: none, so every write asks). |
| `subagentTools` | `read`, `grep`, `glob`, `find`, `write`, `edit`, `yield`, `hub` | The tools a subagent may call. A permitted agent's definition may list only these. |
| `protect` | `[]` | More protected globs, relative to the working directory. |
| `askOutsideScope` | `true` | `false` refuses writes outside the scope without asking. |
| `askTimeoutMs` | `20000` | How long the owner has to answer, from 100 to 25000. |
| `auditDir` | `~/.local/state/omp-subagent-guard/audit` | One JSONL file per run, named after the main session id. |

## The scoped-worker agent

[`agents/scoped-worker.md`](agents/scoped-worker.md) lists `read`, `grep`, `glob`, `find`, `write`, and `edit`, and no `spawns`; omp only offers `find` when `find.enabled` is on. omp adds `yield` and `hub` when it spawns it. Pin your own agent by adding it to `agents` with its `definition`; the guard refuses it if omp resolves the name to any other file, which is how a project's `.omp/agents/` file of the same name would take over (project definitions come before user ones).

## The overlay

[`examples/overlay.yml`](examples/overlay.yml), loaded with `--config`, carries the rules that follow every subagent even when the guard is not loaded: `bash`, `eval`, and `hub` set to `prompt` (a subagent's prompt is refused at once, with "requires approval but no interactive UI available"), `task.maxRecursionDepth: 1`, a `task.maxRuntimeMs` limit, and `task.isolation.apply: false` so an isolated subagent's patch is kept for review instead of applied. omp applies `--config` over global and project settings.

## Audit log and review

Every record carries the run (the main session id), the session, and for subagents their id and agent. The events are `run_start`, `spawn_request`, `spawn_event`, `spawn_denied_by_owner`, `subagent_start`, `tool_call` (tool, paths, decision, reason), `tool_result`, `task_result` (result ids, exit codes, patch paths), and `unguarded_subagent`. File contents and task assignments are not recorded.

- `/subagents` in omp shows this run: each spawn, the subagents it started, what was refused, and where the patches are.
- `bun bin/omp-subagent-guard.ts report <audit.jsonl>` prints the same report for any log; `--json` for a machine-readable one.

A subagent's result id equals its session file name, so linking spawns to subagents needs saved sessions; with `--no-session` the links and the "ran without the guard" warning are not available.

## preflight

```bash
bun bin/omp-subagent-guard.ts preflight [--cwd DIR] [--config FILE] [--overlay FILE] [--guard FILE]... [--isolation] [--json]
```

It checks that the configuration is valid and names an owner; that every permitted agent resolves, from `--cwd`, to its pinned file with a narrow tool list; that the overlay sets the rules above; and that no guard file (this package, plus any `--guard` file that loads it) is in a git-ignored part of the project. `--isolation` builds one isolation copy the way omp does and checks the guard files inside the project are in it. Exit code 0 when nothing failed, 1 when a check failed, 2 on a usage error.

## Tests

```bash
bun run test
```

`bun run test` starts Bun with a temporary `HOME` and `TMPDIR`; plain `bun test` refuses to run, because the suite writes agent definitions, isolation copies, and audit logs under the home directory, and Bun fixes the home directory when it starts. The suite loads the guard through omp's own extension loader and runner and needs no network.

The live tests run real omp with a scripted test-only model provider (`test/scripted-provider.ts`); the harness plays the owner:

```bash
SUBAGENT_GUARD_LIVE=1 OMP_CLI=/path/to/oh-my-pi/packages/coding-agent/src/cli.ts \
SUBAGENT_GUARD_LIVE_OUT=/tmp/subagent-guard-evidence bun run test test/live.test.ts
```

`OMP_BIN=/path/to/omp` runs an installed omp instead. The ten runs show: without the guard, the bundled `task` agent writes `.env` into the checkout, and a scoped-worker starts a command through `hub`; with the guard, `.env`, `.omp/agents/`, and `hub start` are refused, an in-scope write goes through, the owner's Allow and Deny decide out-of-scope writes, no answer is a refusal after 20 seconds, print mode refuses them because there is no one to ask, refused spawns never reach "Allow tool: task", a run without an owner spawns nothing, a Deny at "Allow tool: task" releases the spawn, and an isolated subagent loads a fresh copy of the guard while its patch is kept, not applied; with the overlay alone, a subagent's `bash` and `hub` are refused at once.

## To do before a public release

- **Threat model.** Not run (STRIDE, OWASP LLM Top 10, OWASP Agentic ASI).
- **Security audit.** Not run; the guard has had no independent adversarial review.
- **Newer omp versions.** `before_subagent_spawn` (18.2.11) and `ctx.agent` (18.3.2) are handled from upstream documentation and tested with synthetic events only.
- **The interactive TUI.** The owner's dialog was tested in RPC mode and print mode, not in the terminal UI.
- **Background subagents** (`async.enabled`). The tests ran with it off. A dialog for a subagent that outlives its `task` call may close at once, which refuses the write.
- **More real-model runs.** One run, one model, one scenario.
- **First CI run.** The GitHub Actions workflow has not run yet.

## Limits

- **This is not a sandbox.** The guard checks the paths of `write`, `edit`, and `ast_edit` and refuses other tools by name. A tool you add to `subagentTools` is let through without a path check, except `hub`.
- **Reads are not restricted.** A subagent can read `.env` and copy it into a file inside its scope.
- **The main session is checked for protected writes only.** Keep the main agent at `--tools read,task`, and keep the overlay's `prompt` rules for `bash`, `eval`, and `hub`.
- **18.2.8 has no official way to tell a subagent apart.** The guard reads omp's `session_init` entry, which only omp's task executor writes; a change in omp could break it. On newer omp, an advisor's calls arrive as a subagent named `advisor` and would be refused unless you permit it.
- **omp's task tool caches agent discovery per session.** The guard checks the definitions at session start and at every spawn and refuses when either check fails, but a definition changed and changed back between those points can go unseen.
- **The spawn cap is conservative.** While a `task` call runs, its reserved spawns and its started subagents both count, so a parallel spawn can be refused early.
- **A guard the agent can write to can be changed** for the next session. Install it outside your projects; it refuses writes to its own folder.

## Background

This package implements the integrated Day22 sequence (subagents) of an internal-threat series comparing Cursor and omp. The series measured that omp binds extensions to every subagent and runs its `tool_call` before the approval gate, that subagents run in `yolo` mode, and that an isolated subagent finds a guard only if git can see it. The `hub` gap and the 18.2.8 behaviour this package relies on were found while building it, by reading the omp 18.2.8 source and confirmed in the live runs.

## License

[MIT](LICENSE)
