import * as fs from "node:fs";
import * as path from "node:path";

export type AuditRecord = Record<string, unknown>;

/** One JSONL file per run (the main session), written synchronously so records from all sessions keep their order. */
export class AuditLog {
	readonly file: string;
	readonly error: string | undefined;

	constructor(dir: string, run: string) {
		this.file = path.join(dir, `${run.replace(/[^A-Za-z0-9_.-]/g, "_")}.jsonl`);
		let error: string | undefined;
		try {
			fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
			fs.appendFileSync(this.file, "", { mode: 0o600 });
		} catch (err) {
			error = `cannot write the audit log in ${dir}: ${(err as Error).message}`;
		}
		this.error = error;
	}

	write(record: AuditRecord): void {
		fs.appendFileSync(this.file, `${JSON.stringify({ ts: new Date().toISOString(), ...record })}\n`, { mode: 0o600 });
	}
}

export function readAuditFile(file: string): AuditRecord[] {
	return fs
		.readFileSync(file, "utf8")
		.split("\n")
		.filter(line => line.trim())
		.map(line => JSON.parse(line) as AuditRecord);
}

const ALLOWED = new Set(["allowed", "owner-allowed"]);

export interface BlockedCall {
	tool: string;
	targets: string[];
	decision: string;
	reason: string;
}

export interface ChildReport {
	id: string;
	agent: string | null;
	/** The task call that started it, when the task result names it. */
	spawn: string | null;
	parent: string | null;
	cwdKind: string | null;
	refused: string | null;
	allowed: number;
	blocked: number;
	blockedCalls: BlockedCall[];
	exitCode: number | null;
	isolated: boolean | null;
	patchPath: string | null;
}

export interface SpawnReport {
	toolCallId: string;
	decision: string;
	reason: string | null;
	items: Array<{ agent: string | null; isolated: boolean }>;
	children: string[];
}

export interface RunReport {
	run: string;
	owner: string | null;
	startedAt: string | null;
	spawns: SpawnReport[];
	spawnEvents: Array<{ spawnKey: string | null; agent: string | null; decision: string; reason: string | null }>;
	children: ChildReport[];
	/** Subagents a task result names that never reported to the guard. */
	unguarded: string[];
}

export interface Report {
	runs: RunReport[];
}

const str = (value: unknown): string | null => (typeof value === "string" ? value : null);

/** Groups a guard's audit records into runs, each linking its spawns to the subagents they started. */
export function buildReport(records: readonly AuditRecord[]): Report {
	const runs = new Map<string, RunReport>();
	const children = new Map<string, Map<string, ChildReport>>();
	const runOf = (record: AuditRecord): { run: RunReport; kids: Map<string, ChildReport> } => {
		const id = str(record.run) ?? "(unknown run)";
		let run = runs.get(id);
		if (!run) {
			run = { run: id, owner: null, startedAt: null, spawns: [], spawnEvents: [], children: [], unguarded: [] };
			runs.set(id, run);
			children.set(id, new Map());
		}
		return { run, kids: children.get(id)! };
	};
	const childOf = (kids: Map<string, ChildReport>, id: string): ChildReport => {
		let child = kids.get(id);
		if (!child) {
			child = { id, agent: null, spawn: null, parent: null, cwdKind: null, refused: null, allowed: 0, blocked: 0, blockedCalls: [], exitCode: null, isolated: null, patchPath: null };
			kids.set(id, child);
		}
		return child;
	};
	for (const record of records) {
		const { run, kids } = runOf(record);
		switch (record.event) {
			case "run_start":
				run.owner = str(record.owner);
				run.startedAt = str(record.ts);
				break;
			case "spawn_request":
				run.spawns.push({
					toolCallId: str(record.toolCallId) ?? "",
					decision: str(record.decision) ?? "",
					reason: str(record.reason),
					items: Array.isArray(record.items) ? (record.items as SpawnReport["items"]) : [],
					children: [],
				});
				break;
			case "spawn_event":
				run.spawnEvents.push({ spawnKey: str(record.spawnKey), agent: str(record.agent), decision: str(record.decision) ?? "", reason: str(record.reason) });
				break;
			case "subagent_start": {
				const child = childOf(kids, str(record.child) ?? "");
				child.agent = str(record.agent);
				child.parent = str(record.parent);
				child.cwdKind = str(record.cwdKind);
				child.refused = str(record.refused);
				break;
			}
			case "tool_call": {
				const id = str(record.child);
				if (!id) break;
				const child = childOf(kids, id);
				const decision = str(record.decision) ?? "";
				if (ALLOWED.has(decision)) child.allowed++;
				else {
					child.blocked++;
					child.blockedCalls.push({ tool: str(record.tool) ?? "", targets: Array.isArray(record.targets) ? (record.targets as string[]) : [], decision, reason: str(record.reason) ?? "" });
				}
				break;
			}
			case "task_result": {
				const spawn = run.spawns.findLast(s => s.toolCallId === record.toolCallId);
				for (const result of Array.isArray(record.results) ? (record.results as AuditRecord[]) : []) {
					const id = str(result.id);
					if (!id) continue;
					const child = childOf(kids, id);
					child.spawn = str(record.toolCallId);
					child.agent ??= str(result.agent);
					child.exitCode = typeof result.exitCode === "number" ? result.exitCode : null;
					child.isolated = typeof result.isolated === "boolean" ? result.isolated : null;
					child.patchPath = str(result.patchPath);
					spawn?.children.push(id);
				}
				break;
			}
			case "unguarded_subagent": {
				const id = str(record.child);
				if (id) run.unguarded.push(id);
				break;
			}
		}
	}
	for (const [id, run] of runs) run.children = [...children.get(id)!.values()];
	return { runs: [...runs.values()] };
}

function childLine(child: ChildReport): string {
	const parts = [`${child.allowed} allowed`, `${child.blocked} blocked`];
	if (child.exitCode !== null) parts.push(`exit ${child.exitCode}`);
	if (child.patchPath) parts.push(`patch ${child.patchPath}`);
	return `${child.id} (${child.agent ?? "unknown agent"}${child.isolated ? ", isolated" : ""}): ${parts.join(", ")}`;
}

/** The report as text lines: per run, each spawn and the subagents it started, then what each subagent had refused. */
export function formatReport(report: Report): string[] {
	const lines: string[] = [];
	for (const run of report.runs) {
		lines.push(`run ${run.run} · owner ${run.owner ?? "(none)"}${run.startedAt ? ` · started ${run.startedAt}` : ""}`);
		const shown = new Set<string>();
		const describe = (child: ChildReport, indent: string) => {
			shown.add(child.id);
			lines.push(`${indent}${childLine(child)}`);
			if (child.refused) lines.push(`${indent}  every call refused: ${child.refused}`);
			for (const call of child.blockedCalls) {
				lines.push(`${indent}  ${call.decision} ${call.tool}${call.targets.length ? ` ${call.targets.join(", ")}` : ""}: ${call.reason}`);
			}
		};
		for (const spawn of run.spawns) {
			const what = spawn.items.map(item => `${item.agent ?? "(no agent)"}${item.isolated ? ", isolated" : ""}`).join("; ");
			lines.push(`  spawn ${spawn.toolCallId}: ${spawn.decision}${what ? ` (${what})` : ""}${spawn.children.length ? ` → ${spawn.children.join(", ")}` : ""}`);
			if (spawn.reason) lines.push(`    ${spawn.reason}`);
			for (const id of spawn.children) {
				const child = run.children.find(c => c.id === id);
				if (child && !shown.has(id)) describe(child, "    ");
			}
		}
		for (const event of run.spawnEvents) {
			lines.push(`  spawn event ${event.spawnKey ?? "(no key)"}: ${event.decision} (${event.agent ?? "no agent"})${event.reason ? ` — ${event.reason}` : ""}`);
		}
		const unlinked = run.children.filter(child => !shown.has(child.id));
		if (unlinked.length > 0) {
			lines.push("  subagents not linked to a task call:");
			for (const child of unlinked) describe(child, "    ");
		}
		if (run.unguarded.length > 0) lines.push(`  ran without the guard: ${run.unguarded.join(", ")} — review their changes before merging`);
	}
	if (lines.length === 0) lines.push("no runs in this audit log");
	return lines;
}
