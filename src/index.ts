import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { AuditLog, type AuditRecord, buildReport, formatReport, readAuditFile } from "./audit";
import { defaultConfigPath, expandHome, type GuardConfig, type GuardConfigInput, loadConfigFile, PACKAGE_DIR, resolveConfig } from "./config";
import { displayPath, inScope, isProtected, type Places, writeTargets } from "./policy";
import { type MainState, type Role, registry, roleOf } from "./registry";
import { definitionProblem, isolationProblem, spawnItems } from "./spawn";

export type { GuardConfig, GuardConfigInput } from "./config";

export interface SubagentGuardOptions {
	/** Configuration file; `null` reads none. Default `~/.config/omp-subagent-guard/config.json`. `--subagent-guard-config` wins. */
	configPath?: string | null;
	/** Configuration given in code; used instead of the file unless `--subagent-guard-config` names one. */
	config?: GuardConfigInput;
	/** The file that loads the guard, when it is not this package's own entry, so the isolation check can find it. */
	entryPath?: string;
}

interface Block {
	block: true;
	reason: string;
}

const FLAG_OWNER = "subagent-owner";
const FLAG_CONFIG = "subagent-guard-config";
const WIDGET = "subagents";
const ASK_TITLE = "Subagent write outside its scope";
// omp adds hub to every subagent whose tool list is not all read-only; its start, restart, stop, cancel,
// and send-to-a-process ops launch or drive processes, which would reopen the shell the tool list leaves out.
const HUB_MESSAGING_OPS = new Set(["list", "inbox", "wait", "jobs", "ps", "logs", "describe", "send"]);

interface SubState {
	id: string;
	agent: string | undefined;
	/** Why every call of this subagent is refused, when it is. */
	refused: string | undefined;
}

function message(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function quoted(names: readonly string[]): string {
	return names.map(name => `"${name}"`).join(", ");
}

function cwdKind(cwd: string, main: MainState): string {
	const resolved = path.resolve(cwd);
	const inside = (parent: string) => {
		const rel = path.relative(parent, resolved);
		return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
	};
	if (inside(path.resolve(main.cwd))) return "project";
	if (inside(path.join(os.homedir(), ".omp", "wt"))) return "isolation";
	return "other";
}

function placesFor(cwd: string, main: MainState, config: GuardConfig): Places {
	const roots = [path.join(os.homedir(), ".omp"), PACKAGE_DIR, config.auditDir, ...main.guardFiles];
	if (main.configPath) roots.push(path.dirname(main.configPath));
	return { cwd, home: os.homedir(), roots, extra: config.protect };
}

export function createSubagentGuard(options: SubagentGuardOptions = {}): (pi: ExtensionAPI) => void {
	return function subagentGuard(pi: ExtensionAPI): void {
		pi.setLabel("Subagent guard");
		pi.registerFlag(FLAG_OWNER, { type: "string", description: "Named owner of this run; task spawns are refused without one" });
		pi.registerFlag(FLAG_CONFIG, { type: "string", description: "Subagent guard configuration file (default ~/.config/omp-subagent-guard/config.json)" });
		const guardFiles = [path.join(PACKAGE_DIR, "src", "index.ts"), ...(options.entryPath ? [options.entryPath] : [])];
		let sub: SubState | undefined;

		const audit = (main: MainState | undefined, ctx: ExtensionContext, role: Role, record: AuditRecord) => {
			if (!main?.audit || main.audit.error) return;
			main.audit.write({
				run: main.run,
				session: ctx.sessionManager.getSessionId(),
				role: role.kind,
				...(sub ? { child: sub.id, agent: sub.agent } : {}),
				...record,
			});
		};

		async function startMain(ctx: ExtensionContext): Promise<void> {
			const home = os.homedir();
			const flagConfig = pi.getFlag(FLAG_CONFIG);
			let configPath: string | undefined;
			let loaded: ReturnType<typeof resolveConfig>;
			if (typeof flagConfig === "string" && flagConfig !== "") {
				configPath = path.resolve(ctx.cwd, expandHome(flagConfig, home));
				loaded = loadConfigFile(configPath, home);
			} else if (options.config) {
				loaded = resolveConfig(options.config, ctx.cwd, home);
			} else if (options.configPath === null) {
				loaded = resolveConfig({}, ctx.cwd, home);
			} else {
				configPath = options.configPath ?? defaultConfigPath(home);
				loaded = loadConfigFile(configPath, home);
			}
			const flagOwner = pi.getFlag(FLAG_OWNER);
			const config = loaded.ok ? loaded.config : undefined;
			const owner = typeof flagOwner === "string" && flagOwner.trim() !== "" ? flagOwner.trim() : config?.owner;
			const run = ctx.sessionManager.getSessionId();
			const log = config ? new AuditLog(config.auditDir, run) : undefined;
			const main: MainState = {
				run,
				cwd: ctx.cwd,
				sessionFile: ctx.sessionManager.getSessionFile(),
				owner,
				config,
				configPath,
				setupError: loaded.ok ? log?.error : `invalid configuration: ${loaded.error}`,
				audit: log,
				ui: ctx.hasUI ? ctx.ui : undefined,
				startupProblems: new Map(),
				started: 0,
				children: new Set(),
				inflight: new Map(),
				spawnEvents: 0,
				guardFiles,
			};
			registry().main = main;
			const notices: string[] = [];
			if (main.setupError) notices.push(`subagent guard: ${main.setupError}; task spawns are refused`);
			if (!owner) notices.push("subagent guard: this run has no named owner; start omp with --subagent-owner <name> (task spawns are refused until then)");
			if (config) {
				for (const [name, policy] of Object.entries(config.agents)) {
					const problem = await definitionProblem(name, policy.definition, ctx.cwd, config.subagentTools);
					if (problem) {
						main.startupProblems.set(name, problem);
						notices.push(`subagent guard: "${name}" cannot be spawned: ${problem}`);
					}
				}
			}
			audit(main, ctx, { kind: "main" }, {
				event: "run_start",
				owner: owner ?? null,
				agents: config ? Object.keys(config.agents) : [],
				maxSpawns: config?.maxSpawns ?? null,
				problems: Object.fromEntries(main.startupProblems),
			});
			for (const notice of notices) ctx.ui.notify(notice, "warning");
		}

		function startSub(ctx: ExtensionContext, role: Extract<Role, { kind: "sub" }>): SubState {
			const main = registry().main;
			const state: SubState = { id: role.id ?? ctx.sessionManager.getSessionId(), agent: role.agent, refused: undefined };
			sub = state;
			if (!main?.config) {
				state.refused = "Refused: the subagent guard found no main session for this subagent.";
				return state;
			}
			main.started++;
			main.children.add(state.id);
			const config = main.config;
			if (!role.agent || !config.agents[role.agent]) {
				state.refused = `Refused: this subagent runs agent "${role.agent ?? "(unknown)"}", which is not one of the agents permitted for this run.`;
			} else if (main.started > config.maxSpawns) {
				state.refused = `Refused: this run already started its limit of ${config.maxSpawns} subagents.`;
			}
			let activeTools: string[] | null = null;
			try {
				activeTools = [...pi.getActiveTools()].sort();
			} catch {}
			audit(main, ctx, role, {
				event: "subagent_start",
				parent: role.parent ?? null,
				cwdKind: cwdKind(ctx.cwd, main),
				ordinal: main.started,
				granted: role.tools ?? null,
				activeTools,
				outsideToolList: activeTools ? activeTools.filter(tool => !config.subagentTools.includes(tool)) : null,
				refused: state.refused ?? null,
			});
			return state;
		}

		pi.on("session_start", async (_event, ctx) => {
			const role = roleOf(ctx);
			if (role.kind === "main") await startMain(ctx);
			else startSub(ctx, role);
		});

		async function spawnGate(event: { toolCallId: string; input: Record<string, unknown> }, ctx: ExtensionContext, main: MainState): Promise<Block | undefined> {
			const items = spawnItems(event.input);
			const record = (decision: "allowed" | "blocked", reason?: string) =>
				audit(main, ctx, { kind: "main" }, {
					event: "spawn_request",
					toolCallId: event.toolCallId,
					owner: main.owner ?? null,
					items: items.map(item => ({ agent: item.agent ?? null, isolated: item.isolated })),
					decision,
					...(reason ? { reason } : {}),
				});
			const deny = (reason: string): Block => {
				record("blocked", reason);
				return { block: true, reason };
			};
			const config = main.config;
			if (!config) return deny("Delegation refused: the subagent guard cannot start subagents until its setup is fixed.");
			if (!main.audit || main.audit.error) return deny("Delegation refused: the subagent guard cannot write its audit log.");
			if (main.setupError) return deny("Delegation refused: the subagent guard cannot start subagents until its setup is fixed.");
			if (!main.owner) return deny("Delegation refused: this run has no named owner.");
			const permitted = quoted(Object.keys(config.agents));
			for (const item of items) {
				if (!item.agent) return deny(`Delegation refused: a task item names no agent; name one of the agents permitted for this run (${permitted}).`);
				if (!config.agents[item.agent]) return deny(`Delegation refused: agent "${item.agent}" is not one of the agents permitted for this run (${permitted}).`);
				if (item.tools.length > 0) return deny(`Delegation refused: the task hands the subagent extra tools (${quoted(item.tools)}); a subagent gets only its agent definition's tools.`);
			}
			for (const name of new Set(items.map(item => item.agent!))) {
				const problem = (await definitionProblem(name, config.agents[name]!.definition, ctx.cwd, config.subagentTools)) ?? main.startupProblems.get(name);
				if (problem) return deny(`Delegation refused: ${problem}.`);
			}
			if (items.some(item => item.isolated)) {
				const problem = isolationProblem(main.guardFiles, ctx.cwd);
				if (problem) return deny(`Delegation refused: an isolated subagent would run without this guard: ${problem}.`);
			}
			const pending = [...main.inflight.values()].reduce((sum, n) => sum + n, 0);
			if (main.started + pending + items.length > config.maxSpawns) {
				return deny(`Delegation refused: this run may start at most ${config.maxSpawns} subagents (${main.started} started, ${pending} pending).`);
			}
			main.inflight.set(event.toolCallId, items.length);
			record("allowed");
			return undefined;
		}

		async function subCall(event: { toolName: string; input: Record<string, unknown> }, ctx: ExtensionContext, role: Role, state: SubState): Promise<Block | undefined> {
			const main = registry().main;
			const tool = event.toolName;
			const targets = writeTargets(tool, event.input);
			const record = (decision: string, reason?: string) =>
				audit(main, ctx, role, {
					event: "tool_call",
					tool,
					...(targets ? { targets: targets.map(target => displayPath(target, ctx.cwd)) } : {}),
					decision,
					...(reason ? { reason } : {}),
				});
			const deny = (reason: string, decision = "blocked"): Block => {
				record(decision, reason);
				return { block: true, reason };
			};
			if (state.refused) return deny(state.refused);
			const config = main?.config;
			if (!main || !config) return deny("Refused: the subagent guard found no main session for this subagent.");
			if (!config.subagentTools.includes(tool)) return deny(`Tool "${tool}" is not available to subagents in this run.`);
			if (tool === "hub") {
				const op = typeof event.input.op === "string" ? event.input.op : "";
				if (!HUB_MESSAGING_OPS.has(op) || (op === "send" && event.input.name !== undefined)) {
					return deny(`Refused: hub "${op}" starts or drives a process, which subagents may not do in this run.`);
				}
			}
			if (targets === undefined) {
				record("allowed");
				return undefined;
			}
			if (targets.length === 0) return deny(`Refused: the subagent guard cannot tell which files this ${tool} call changes.`);
			if (tool === "ast_edit" && targets.some(target => /[*?[{]/.test(target) || isDirectory(path.resolve(ctx.cwd, target)))) {
				return deny("Refused: in a subagent, ast_edit must name single files.");
			}
			const places = placesFor(ctx.cwd, main, config);
			const hit = targets.find(target => isProtected(target, places));
			if (hit) return deny(`Path "${hit}" is protected`);
			const scope = config.agents[state.agent ?? ""]?.writeScope ?? [];
			const outside = targets.filter(target => !inScope(target, ctx.cwd, scope));
			if (outside.length === 0) {
				record("allowed");
				return undefined;
			}
			const shown = outside.map(target => displayPath(target, ctx.cwd)).join(", ");
			const refused = `Write to "${shown}" refused: it is outside this subagent's write scope`;
			if (!config.askOutsideScope) return deny(`${refused}.`);
			const ui = main.ui;
			if (!ui) return deny(`${refused} and there is no owner to ask.`, "owner-unavailable");
			const title = [ASK_TITLE, `owner: ${main.owner ?? "(none)"}`, `subagent: ${state.agent ?? "(unknown)"} (${state.id})`, `tool: ${tool}`, `path: ${shown}`].join("\n");
			let answer: string | undefined;
			try {
				answer = await ui.select(title, ["Allow", "Deny"], { timeout: config.askTimeoutMs });
			} catch (err) {
				return deny(`${refused} and the subagent guard could not ask the owner (${message(err)}).`, "owner-error");
			}
			if (answer === "Allow") {
				record("owner-allowed");
				return undefined;
			}
			if (answer === "Deny") return deny(`${refused} and the owner refused it.`, "owner-denied");
			return deny(`${refused} and the owner did not answer within ${config.askTimeoutMs / 1000} s.`, "owner-timeout");
		}

		function mainCall(event: { toolName: string; input: Record<string, unknown> }, ctx: ExtensionContext, main: MainState): Block | undefined {
			const targets = writeTargets(event.toolName, event.input);
			if (!targets || !main.config) return undefined;
			const hit = targets.find(target => isProtected(target, placesFor(ctx.cwd, main, main.config!)));
			if (!hit) return undefined;
			const reason = `Path "${hit}" is protected`;
			audit(main, ctx, { kind: "main" }, { event: "tool_call", tool: event.toolName, targets: targets.map(target => displayPath(target, ctx.cwd)), decision: "blocked", reason });
			return { block: true, reason };
		}

		pi.on("tool_call", async (event, ctx) => {
			try {
				const call = { toolName: event.toolName, toolCallId: event.toolCallId, input: (event.input ?? {}) as Record<string, unknown> };
				const role = roleOf(ctx);
				if (role.kind === "sub") return await subCall(call, ctx, role, sub ?? startSub(ctx, role));
				const main = registry().main;
				if (!main) return { block: true, reason: "Refused: the subagent guard has not started in this session." };
				if (call.toolName === "task") {
					if (ctx.hasUI) main.ui = ctx.ui;
					return await spawnGate(call, ctx, main);
				}
				return mainCall(call, ctx, main);
			} catch (err) {
				return { block: true, reason: `Refused: the subagent guard could not check this call (${message(err)}).` };
			}
		});

		pi.on("tool_result", async (event, ctx) => {
			try {
				const role = roleOf(ctx);
				const main = registry().main;
				if (role.kind === "sub") {
					audit(main, ctx, role, { event: "tool_result", tool: event.toolName, isError: event.isError });
					return;
				}
				if (event.toolName !== "task" || !main) return;
				main.inflight.delete(event.toolCallId);
				const results = ((event.details as { results?: Record<string, unknown>[] } | undefined)?.results ?? []).filter(result => typeof result?.id === "string");
				audit(main, ctx, role, {
					event: "task_result",
					toolCallId: event.toolCallId,
					isError: event.isError,
					results: results.map(result => ({
						id: result.id,
						agent: result.agent ?? null,
						exitCode: result.exitCode ?? null,
						isolated: result.isolated ?? null,
						patchPath: result.patchPath ?? null,
						hasRootChanges: result.hasRootChanges ?? null,
						...(typeof result.error === "string" ? { error: result.error.slice(0, 300) } : {}),
					})),
				});
				// Result ids match subagent session files only when sessions are saved.
				if (!main.sessionFile) return;
				for (const result of results) {
					const id = result.id as string;
					if (main.children.has(id)) continue;
					audit(main, ctx, role, { event: "unguarded_subagent", child: id, agent: result.agent ?? null, toolCallId: event.toolCallId });
					const patch = typeof result.patchPath === "string" ? ` (patch ${result.patchPath})` : "";
					ctx.ui.notify(`subagent guard: subagent ${id} ran without the guard; review what it changed before merging${patch}`, "error");
				}
			} catch {
				// A result cannot be refused; a record that fails to write is not worth failing the turn.
			}
		});

		// A task the owner denies at omp's approval prompt ends without a tool_result; release its reservation here.
		pi.on("tool_approval_resolved", async (event, ctx) => {
			try {
				const main = registry().main;
				if (event.toolName !== "task" || event.approved || !main || roleOf(ctx).kind !== "main") return;
				if (!main.inflight.delete(event.toolCallId)) return;
				audit(main, ctx, { kind: "main" }, { event: "spawn_denied_by_owner", toolCallId: event.toolCallId });
			} catch {}
		});
		pi.on("tool_execution_end", async (event, ctx) => {
			try {
				if (event.toolName === "task" && roleOf(ctx).kind === "main") registry().main?.inflight.delete(event.toolCallId);
			} catch {}
		});

		// before_subagent_spawn arrived in omp 18.2.11; on 18.2.8 it is registered and never fires.
		const untyped = pi as unknown as { on(event: string, handler: (event: Record<string, unknown>, ctx: ExtensionContext) => Promise<Block | undefined>): void };
		untyped.on("before_subagent_spawn", async (event, ctx) => {
			try {
				const role = roleOf(ctx);
				const main = registry().main;
				const agent = typeof event.agent === "string" ? event.agent : typeof (event.agent as { name?: unknown } | undefined)?.name === "string" ? ((event.agent as { name: string }).name) : undefined;
				const deny = (reason: string): Block => {
					audit(main, ctx, role, { event: "spawn_event", spawnKey: event.spawnKey ?? null, agent: agent ?? null, invocationKind: event.invocationKind ?? null, decision: "blocked", reason });
					return { block: true, reason };
				};
				if (role.kind === "sub") return deny("Delegation refused: subagents may not start subagents in this run.");
				const config = main?.config;
				if (!main || !config || main.setupError) return deny("Delegation refused: the subagent guard cannot start subagents until its setup is fixed.");
				if (!main.owner) return deny("Delegation refused: this run has no named owner.");
				if (event.invocationKind !== undefined && event.invocationKind !== "task") {
					return deny(`Delegation refused: subagents may be started only through the task tool in this run (this one came from ${String(event.invocationKind)}).`);
				}
				if (!agent || !config.agents[agent]) return deny(`Delegation refused: agent "${agent ?? "(none)"}" is not one of the agents permitted for this run (${quoted(Object.keys(config.agents))}).`);
				if (main.spawnEvents >= config.maxSpawns) return deny(`Delegation refused: this run may start at most ${config.maxSpawns} subagents.`);
				main.spawnEvents++;
				audit(main, ctx, role, { event: "spawn_event", spawnKey: event.spawnKey ?? null, agent, invocationKind: event.invocationKind ?? null, decision: "allowed" });
				return undefined;
			} catch (err) {
				return { block: true, reason: `Delegation refused: the subagent guard could not check this spawn (${message(err)}).` };
			}
		});

		pi.registerCommand("subagents", {
			description: "Show this run's owner, spawns, subagents, what the guard refused, and where their patches are",
			handler: async (_args, ctx) => {
				const main = registry().main;
				let lines: string[];
				if (!main?.audit || main.audit.error) {
					lines = [`subagent guard: ${main?.setupError ?? "not started in this session"}`];
				} else {
					try {
						lines = formatReport(buildReport(readAuditFile(main.audit.file)));
					} catch (err) {
						lines = [`subagent guard: cannot read the audit log: ${message(err)}`];
					}
					lines.push(`audit log: ${main.audit.file}`);
				}
				ctx.ui.setWidget(WIDGET, lines);
				ctx.ui.notify(lines[0] ?? "subagent guard", "info");
			},
		});
	};
}

function isDirectory(abs: string): boolean {
	try {
		return fs.statSync(abs).isDirectory();
	} catch {
		return false;
	}
}

export default createSubagentGuard();
