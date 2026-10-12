import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const PACKAGE_DIR = path.resolve(import.meta.dir, "..");

export interface AgentPolicy {
	/** The definition file this agent must resolve to; any other (a project override, a plugin) refuses the spawn. */
	definition: string;
	/** Globs, relative to the subagent's working directory, it may write without asking the owner. */
	writeScope: string[];
}

export interface GuardConfig {
	owner?: string;
	maxSpawns: number;
	agents: Record<string, AgentPolicy>;
	subagentTools: string[];
	protect: string[];
	askOutsideScope: boolean;
	askTimeoutMs: number;
	auditDir: string;
}

export type GuardConfigInput = Partial<Omit<GuardConfig, "agents">> & { agents?: Record<string, Partial<AgentPolicy>> };

export const DEFAULT_SUBAGENT_TOOLS = ["read", "grep", "glob", "find", "write", "edit", "yield", "hub"];
// omp gives a tool_call handler 30 s, and a dialog opened on the main session's UI does not pause a
// subagent's budget, so the owner's answer must come well inside it.
export const MAX_ASK_TIMEOUT_MS = 25_000;

export function defaultConfigPath(home = os.homedir()): string {
	return path.join(home, ".config", "omp-subagent-guard", "config.json");
}

export function defaultAuditDir(home = os.homedir()): string {
	return path.join(home, ".local", "state", "omp-subagent-guard", "audit");
}

function defaults(home: string): GuardConfig {
	return {
		maxSpawns: 3,
		agents: { "scoped-worker": { definition: path.join(PACKAGE_DIR, "agents", "scoped-worker.md"), writeScope: [] } },
		subagentTools: DEFAULT_SUBAGENT_TOOLS,
		protect: [],
		askOutsideScope: true,
		askTimeoutMs: 20_000,
		auditDir: defaultAuditDir(home),
	};
}

export function expandHome(file: string, home: string): string {
	if (file === "~") return home;
	if (file.startsWith("~/")) return path.join(home, file.slice(2));
	return file;
}

function strings(value: unknown, field: string): string[] {
	if (!Array.isArray(value) || value.some(item => typeof item !== "string")) throw new Error(`${field} must be a list of strings`);
	return value as string[];
}

const AGENT_NAME = /^[A-Za-z0-9_-]+$/;

/** Validates a configuration over the defaults. Relative paths resolve against `baseDir`. */
export function resolveConfig(input: unknown, baseDir: string, home = os.homedir()): { ok: true; config: GuardConfig } | { ok: false; error: string } {
	try {
		if (input === null || typeof input !== "object" || Array.isArray(input)) throw new Error("the configuration must be a JSON object");
		const raw = input as Record<string, unknown>;
		const config = defaults(home);
		const file = (value: unknown, field: string) => {
			if (typeof value !== "string" || value === "") throw new Error(`${field} must be a path`);
			return path.resolve(baseDir, expandHome(value, home));
		};
		if (raw.owner !== undefined) {
			if (typeof raw.owner !== "string" || raw.owner.trim() === "") throw new Error("owner must be a non-empty string");
			config.owner = raw.owner.trim();
		}
		if (raw.maxSpawns !== undefined) {
			if (!Number.isInteger(raw.maxSpawns) || (raw.maxSpawns as number) < 0) throw new Error("maxSpawns must be a whole number, 0 or more");
			config.maxSpawns = raw.maxSpawns as number;
		}
		if (raw.agents !== undefined) {
			if (raw.agents === null || typeof raw.agents !== "object" || Array.isArray(raw.agents)) throw new Error("agents must be an object keyed by agent name");
			config.agents = {};
			for (const [name, value] of Object.entries(raw.agents as Record<string, unknown>)) {
				if (!AGENT_NAME.test(name)) throw new Error(`agents: "${name}" is not a valid agent name`);
				const policy = (value ?? {}) as Record<string, unknown>;
				config.agents[name] = {
					definition: policy.definition === undefined ? path.join(PACKAGE_DIR, "agents", `${name}.md`) : file(policy.definition, `agents.${name}.definition`),
					writeScope: policy.writeScope === undefined ? [] : strings(policy.writeScope, `agents.${name}.writeScope`),
				};
			}
		}
		if (raw.subagentTools !== undefined) config.subagentTools = strings(raw.subagentTools, "subagentTools");
		if (raw.protect !== undefined) config.protect = strings(raw.protect, "protect");
		if (raw.askOutsideScope !== undefined) {
			if (typeof raw.askOutsideScope !== "boolean") throw new Error("askOutsideScope must be true or false");
			config.askOutsideScope = raw.askOutsideScope;
		}
		if (raw.askTimeoutMs !== undefined) {
			const ms = raw.askTimeoutMs;
			if (!Number.isInteger(ms) || (ms as number) < 100 || (ms as number) > MAX_ASK_TIMEOUT_MS) {
				throw new Error(`askTimeoutMs must be a whole number from 100 to ${MAX_ASK_TIMEOUT_MS}`);
			}
			config.askTimeoutMs = ms as number;
		}
		if (raw.auditDir !== undefined) config.auditDir = file(raw.auditDir, "auditDir");
		const unknown = Object.keys(raw).filter(key => !["owner", "maxSpawns", "agents", "subagentTools", "protect", "askOutsideScope", "askTimeoutMs", "auditDir"].includes(key));
		if (unknown.length > 0) throw new Error(`unknown setting ${unknown.map(key => `"${key}"`).join(", ")}`);
		return { ok: true, config };
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	}
}

/** Reads the configuration file; a missing file means the defaults. */
export function loadConfigFile(file: string, home = os.homedir()): { ok: true; config: GuardConfig } | { ok: false; error: string } {
	let text: string;
	try {
		text = fs.readFileSync(file, "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return resolveConfig({}, path.dirname(file), home);
		return { ok: false, error: `cannot read ${file}: ${(err as Error).message}` };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (err) {
		return { ok: false, error: `${file} is not valid JSON: ${(err as Error).message}` };
	}
	return resolveConfig(parsed, path.dirname(file), home);
}
