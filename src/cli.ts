import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { cleanupIsolation, ensureIsolation } from "@oh-my-pi/pi-coding-agent/task/worktree";
import { buildReport, formatReport, readAuditFile } from "./audit";
import { defaultConfigPath, expandHome, loadConfigFile, PACKAGE_DIR } from "./config";
import { realPathOf } from "./policy";
import { definitionProblem, isolationProblem } from "./spawn";

const USAGE = [
	"usage: omp-subagent-guard preflight [--cwd DIR] [--config FILE] [--overlay FILE] [--guard FILE]... [--isolation] [--json]",
	"       omp-subagent-guard report AUDIT.jsonl [--json]",
].join("\n");

class UsageError extends Error {}

export interface Check {
	check: string;
	status: "pass" | "fail" | "warn" | "skip";
	detail: string;
}

export interface Io {
	out(text: string): void;
	err(text: string): void;
}

function parse(argv: string[], flags: Record<string, "value" | "list" | "switch">): { values: Record<string, string>; lists: Record<string, string[]>; switches: Set<string>; rest: string[] } {
	const values: Record<string, string> = {};
	const lists: Record<string, string[]> = {};
	const switches = new Set<string>();
	const rest: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]!;
		if (!arg.startsWith("--")) {
			rest.push(arg);
			continue;
		}
		const name = arg.slice(2);
		const kind = flags[name];
		if (!kind) throw new UsageError(`unknown option ${arg}`);
		if (kind === "switch") {
			switches.add(name);
			continue;
		}
		const value = argv[++i];
		if (value === undefined || value.startsWith("--")) throw new UsageError(`${arg} needs a value`);
		if (kind === "list") (lists[name] ??= []).push(value);
		else values[name] = value;
	}
	return { values, lists, switches, rest };
}

function setting(doc: unknown, key: string): unknown {
	if (!doc || typeof doc !== "object") return undefined;
	const flat = (doc as Record<string, unknown>)[key];
	if (flat !== undefined) return flat;
	let node: unknown = doc;
	for (const part of key.split(".")) {
		if (!node || typeof node !== "object") return undefined;
		node = (node as Record<string, unknown>)[part];
	}
	return node;
}

/** The rules the overlay must carry; omp applies `--config` over global and project settings. */
function overlayChecks(file: string): Check[] {
	let doc: unknown;
	try {
		doc = Bun.YAML.parse(fs.readFileSync(file, "utf8"));
	} catch (err) {
		return [{ check: "overlay", status: "fail", detail: `cannot read ${file}: ${(err as Error).message}` }];
	}
	const rule = (key: string, ok: (value: unknown) => boolean, want: string): Check => {
		const value = setting(doc, key);
		return { check: "overlay", status: ok(value) ? "pass" : "fail", detail: `${key} is ${value === undefined ? "not set" : JSON.stringify(value)}; want ${want}` };
	};
	const gated = (value: unknown) => value === "prompt" || value === "deny";
	return [
		rule("tools.approval.bash", gated, "prompt or deny (a subagent's prompt is refused at once)"),
		rule("tools.approval.eval", gated, "prompt or deny"),
		rule("tools.approval.hub", gated, "prompt or deny (hub start launches processes, and omp gives hub to every subagent)"),
		rule("task.maxRecursionDepth", value => value === 0 || value === 1, "1 (only the main agent spawns)"),
		rule("task.maxRuntimeMs", value => typeof value === "number" && value > 0, "a time limit above 0"),
		rule("task.isolation.apply", value => value === false, "false (keep isolated patches for review)"),
	];
}

function inside(child: string, parent: string): boolean {
	const rel = path.relative(parent, child);
	return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function isGitRepo(cwd: string): boolean {
	return Bun.spawnSync(["git", "-C", cwd, "rev-parse", "--show-toplevel"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;
}

async function isolationCopyChecks(guardFiles: string[], cwd: string): Promise<Check[]> {
	if (!isGitRepo(cwd)) return [{ check: "isolation-copy", status: "skip", detail: `${cwd} is not a git repository, so omp cannot isolate subagents there` }];
	const root = realPathOf(cwd);
	const handle = await ensureIsolation(root, `sg-preflight-${process.pid}-${Date.now().toString(36)}`);
	const checks: Check[] = [];
	try {
		for (const file of guardFiles) {
			const real = realPathOf(path.resolve(file));
			if (!inside(real, root)) {
				checks.push({ check: "isolation-copy", status: "pass", detail: `${path.basename(real)} is outside the project; an isolated subagent loads it from its own path` });
				continue;
			}
			const rel = path.relative(root, real);
			const present = fs.existsSync(path.join(handle.mergedDir, rel));
			checks.push({ check: "isolation-copy", status: present ? "pass" : "fail", detail: `${rel} is ${present ? "" : "missing "}in an isolated copy made the way omp makes it` });
		}
	} finally {
		await cleanupIsolation(handle);
	}
	if (fs.existsSync(handle.mergedDir)) checks.push({ check: "isolation-copy", status: "warn", detail: `the test copy was not removed: ${handle.mergedDir}` });
	return checks;
}

async function preflight(argv: string[], io: Io): Promise<number> {
	const { values, lists, switches, rest } = parse(argv, { cwd: "value", config: "value", overlay: "value", guard: "list", isolation: "switch", json: "switch" });
	if (rest.length > 0) throw new UsageError(`unexpected argument ${rest[0]}`);
	const home = os.homedir();
	const cwd = path.resolve(values.cwd ?? process.cwd());
	const configPath = path.resolve(expandHome(values.config ?? defaultConfigPath(home), home));
	const guardFiles = [path.join(PACKAGE_DIR, "src", "index.ts"), ...(lists.guard ?? []).map(file => path.resolve(expandHome(file, home)))];
	const checks: Check[] = [];
	const loaded = loadConfigFile(configPath, home);
	if (!loaded.ok) {
		checks.push({ check: "config", status: "fail", detail: loaded.error });
	} else {
		const config = loaded.config;
		checks.push({ check: "config", status: "pass", detail: fs.existsSync(configPath) ? configPath : `${configPath} does not exist; using the defaults` });
		checks.push(
			config.owner
				? { check: "owner", status: "pass", detail: config.owner }
				: { check: "owner", status: "warn", detail: "no owner in the configuration; start omp with --subagent-owner <name> or task spawns are refused" },
		);
		// Stand-in for loading this package with -e: its agents/ folder is one of the session's extension roots.
		const roots = { explicit: [PACKAGE_DIR], mode: "merge" as const, configured: [], configuredLevel: "user" as const };
		for (const [name, policy] of Object.entries(config.agents)) {
			const problem = await definitionProblem(name, policy.definition, cwd, config.subagentTools, roots);
			checks.push({ check: `agent ${name}`, status: problem ? "fail" : "pass", detail: problem ?? `resolves to ${policy.definition}` });
			if (!problem && policy.writeScope.length === 0) checks.push({ check: `agent ${name}`, status: "warn", detail: "empty writeScope: every write asks the owner" });
		}
	}
	if (values.overlay) checks.push(...overlayChecks(path.resolve(values.overlay)));
	else checks.push({ check: "overlay", status: "skip", detail: "no --overlay given" });
	const problem = isGitRepo(cwd) ? isolationProblem(guardFiles, cwd) : undefined;
	checks.push({ check: "isolation", status: problem ? "fail" : "pass", detail: problem ?? "every guard file is outside the project or visible to git" });
	if (switches.has("isolation")) checks.push(...(await isolationCopyChecks(guardFiles, cwd)));
	const ok = checks.every(check => check.status !== "fail");
	if (switches.has("json")) io.out(`${JSON.stringify({ ok, checks }, null, 2)}\n`);
	else io.out(`${checks.map(check => `${check.status === "fail" ? "FAIL" : check.status.padEnd(4)}  ${check.check}: ${check.detail}`).join("\n")}\n`);
	return ok ? 0 : 1;
}

function report(argv: string[], io: Io): number {
	const { switches, rest } = parse(argv, { json: "switch" });
	if (rest.length !== 1) throw new UsageError("report needs exactly one audit log");
	let records: ReturnType<typeof readAuditFile>;
	try {
		records = readAuditFile(rest[0]!);
	} catch (err) {
		io.err(`cannot read ${rest[0]}: ${(err as Error).message}\n`);
		return 1;
	}
	const built = buildReport(records);
	io.out(switches.has("json") ? `${JSON.stringify(built, null, 2)}\n` : `${formatReport(built).join("\n")}\n`);
	return 0;
}

/** Runs the command line; returns the exit code: 0 ok, 1 a check failed or the log is unreadable, 2 usage. */
export async function main(argv: string[], io: Io): Promise<number> {
	const [command, ...args] = argv;
	try {
		if (command === "preflight") return await preflight(args, io);
		if (command === "report") return report(args, io);
		if (command === "--help" || command === "-h" || command === "help") {
			io.out(`${USAGE}\n`);
			return 0;
		}
		throw new UsageError(command ? `unknown command ${command}` : "no command");
	} catch (err) {
		if (err instanceof UsageError) {
			io.err(`${err.message}\n${USAGE}\n`);
			return 2;
		}
		throw err;
	}
}
