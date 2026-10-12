import * as path from "node:path";
import type { ExtensionContext, ExtensionUIContext } from "@oh-my-pi/pi-coding-agent";
import type { AuditLog } from "./audit";
import type { GuardConfig } from "./config";

/** State of one run, kept by the main session for every subagent session in the process. */
export interface MainState {
	run: string;
	cwd: string;
	sessionFile: string | undefined;
	owner: string | undefined;
	config: GuardConfig | undefined;
	configPath: string | undefined;
	/** Why the guard cannot start subagents at all (an invalid configuration or an unwritable audit log). */
	setupError: string | undefined;
	audit: AuditLog | undefined;
	/** The main session's UI, lent to subagents to ask the owner. */
	ui: ExtensionUIContext | undefined;
	/** Definition problems found when the run started; omp's task tool may keep using what it found then. */
	startupProblems: Map<string, string>;
	/** Subagent sessions that reported to the guard, in start order. */
	started: number;
	children: Set<string>;
	/** Spawns reserved by task calls that have not returned yet, by tool call id. */
	inflight: Map<string, number>;
	/** Spawns let through by before_subagent_spawn (omp 18.2.11 and later). */
	spawnEvents: number;
	/** Guard files an isolated copy must contain. */
	guardFiles: string[];
}

interface Registry {
	main?: MainState;
}

// Isolated subagents import the extension again (omp adds a cache-busting query), so module state is
// not shared with them; globalThis is.
const KEY = Symbol.for("omp-subagent-guard/registry/v1");

export function registry(): Registry {
	const holder = globalThis as Record<symbol, Registry | undefined>;
	holder[KEY] ??= {};
	return holder[KEY]!;
}

export type Role =
	| { kind: "main" }
	| { kind: "sub"; agent: string | undefined; id: string | undefined; tools: string[] | undefined; parent: string | undefined };

interface AgentInfo {
	kind?: unknown;
	id?: unknown;
	name?: unknown;
}

interface SessionInit {
	type: string;
	agent?: string;
	tools?: string[];
}

const roles = new WeakMap<object, Role>();

/**
 * Whether `ctx` belongs to the main session or a subagent. omp 18.3.2 and later say so in
 * `ctx.agent`; 18.2.8 writes a `session_init` entry into every subagent session before it starts,
 * and only there. A subagent's session file is `<result id>.jsonl`.
 */
export function roleOf(ctx: ExtensionContext): Role {
	const info = (ctx as ExtensionContext & { agent?: AgentInfo }).agent;
	const manager = ctx.sessionManager;
	if (info && (info.kind === "main" || info.kind === "sub")) {
		if (info.kind === "main") return { kind: "main" };
		const init = manager.getEntries().find(entry => entry.type === "session_init") as SessionInit | undefined;
		return {
			kind: "sub",
			agent: init?.agent ?? (typeof info.name === "string" ? info.name : undefined),
			id: typeof info.id === "string" ? info.id : undefined,
			tools: init?.tools,
			parent: parentOf(ctx),
		};
	}
	const cached = roles.get(manager);
	if (cached) return cached;
	const init = manager.getEntries().find(entry => entry.type === "session_init") as SessionInit | undefined;
	const file = manager.getSessionFile();
	const role: Role = init
		? { kind: "sub", agent: init.agent, id: file ? path.basename(file, ".jsonl") : undefined, tools: init.tools, parent: parentOf(ctx) }
		: { kind: "main" };
	roles.set(manager, role);
	return role;
}

function parentOf(ctx: ExtensionContext): string | undefined {
	const parent = ctx.sessionManager.getHeader()?.parentSession;
	return typeof parent === "string" && parent ? path.basename(parent) : undefined;
}
