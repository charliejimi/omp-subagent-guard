import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { GuardConfigInput } from "../src/config";
import { makeRepo, removeTemps, safeRemove, tempDir, userAgentsDir, writeAgent } from "./fixtures";
import { auditFileIn, closeRegistry, fakeUI, loadSession, readAudit, resetGuardState, type Session, type ToolCallResult, writeGuardEntry } from "./helpers";

afterAll(() => {
	closeRegistry();
	removeTemps();
});

let cwd: string;
let auditDir: string;
let pinned: string;

beforeEach(() => {
	resetGuardState();
	cwd = makeRepo();
	auditDir = tempDir("sg-audit-");
	pinned = writeAgent(path.join(userAgentsDir(), "scoped-worker.md"), "scoped-worker");
});
afterEach(() => safeRemove(userAgentsDir()));

function config(extra: GuardConfigInput = {}): GuardConfigInput {
	return { owner: "alice", agents: { "scoped-worker": { definition: pinned, writeScope: ["notes.txt"] } }, auditDir, askTimeoutMs: 400, ...extra };
}

function entry(extra: GuardConfigInput = {}, dir = tempDir("sg-entry-")): string {
	return writeGuardEntry(dir, { config: config(extra) });
}

/** A refusal written by the guard itself: it says what was refused and never how to switch a rule off. */
function expectRefusal(result: ToolCallResult | undefined, contains: string): void {
	expect(result?.block).toBe(true);
	expect(result?.reason ?? "").toContain(contains);
	const ownWords = (result?.reason ?? "").replace(/"[^"]*"/g, '""');
	expect(ownWords).not.toMatch(/yolo|approval|config|setting|allow|--/i);
}

async function main(extra: GuardConfigInput = {}, ui = fakeUI("Allow"), flags?: Record<string, string>): Promise<Session> {
	return loadSession({ entry: entry(extra), cwd, ui, flags });
}

describe("spawn gate in the main session (AC-1)", () => {
	it("lets the pinned scoped-worker through and records the spawn with its owner", async () => {
		const s = await main();
		expect(await s.toolCall("task", { agent: "scoped-worker", task: "write notes" })).toBeUndefined();
		const spawn = readAudit(auditFileIn(auditDir)).find(r => r.event === "spawn_request");
		expect(spawn).toMatchObject({ decision: "allowed", owner: "alice", items: [{ agent: "scoped-worker", isolated: false }] });
	});

	it("refuses an agent that is not permitted, or a spawn that names no agent", async () => {
		const s = await main();
		expectRefusal(await s.toolCall("task", { agent: "task", task: "x" }), '"task"');
		expectRefusal(await s.toolCall("task", { task: "x" }), "names no agent");
	});

	it("refuses eval-defined tools handed to the subagent", async () => {
		const s = await main();
		expectRefusal(await s.toolCall("task", { agent: "scoped-worker", task: "x", tools: ["fetch_rows"] }), "fetch_rows");
	});

	it("refuses when the project overrides the pinned definition, or the definition grants more tools", async () => {
		const s = await main();
		writeAgent(path.join(cwd, ".omp", "agents", "scoped-worker.md"), "scoped-worker");
		expectRefusal(await s.toolCall("task", { agent: "scoped-worker", task: "x" }), "project");
		safeRemove(path.join(cwd, ".omp"));
		writeAgent(pinned, "scoped-worker", { tools: "read, write, bash" });
		expectRefusal(await s.toolCall("task", { agent: "scoped-worker", task: "x" }), "bash");
	});

	it("refuses a run with no named owner; --subagent-owner names one", async () => {
		const ui = fakeUI("Allow");
		const none = await main({ owner: undefined }, ui);
		expectRefusal(await none.toolCall("task", { agent: "scoped-worker", task: "x" }), "owner");
		expect(ui.notices.some(n => n.includes("--subagent-owner"))).toBe(true);
		auditDir = tempDir("sg-audit-");
		const named = await main({ owner: undefined }, fakeUI("Allow"), { "subagent-owner": "bob" });
		expect(await named.toolCall("task", { agent: "scoped-worker", task: "x" })).toBeUndefined();
		expect(readAudit(auditFileIn(auditDir)).find(r => r.event === "spawn_request")).toMatchObject({ owner: "bob", decision: "allowed" });
	});

	it("counts every item of a batch against the spawn cap and releases a reservation when the task returns", async () => {
		const s = await main({ maxSpawns: 2 });
		const batch = (n: number) => ({ context: "c", tasks: Array.from({ length: n }, (_, i) => ({ agent: "scoped-worker", task: `t${i}` })) });
		expectRefusal(await s.toolCall("task", batch(3)), "2");
		expect(await s.toolCall("task", batch(2), "first")).toBeUndefined();
		expectRefusal(await s.toolCall("task", batch(1)), "2");
		await s.toolResult("task", batch(2), { toolCallId: "first", isError: true, text: "Tool call denied by user: task" });
		expect(await s.toolCall("task", batch(1))).toBeUndefined();
	});

	it("releases a reservation when the owner denies the task at omp's approval prompt, which emits no tool result", async () => {
		const s = await main({ maxSpawns: 1 });
		const task = { agent: "scoped-worker", task: "x" };
		expect(await s.toolCall("task", task, "denied")).toBeUndefined();
		expectRefusal(await s.toolCall("task", task), "at most 1");
		await s.runner.emit({ type: "tool_approval_resolved", sessionId: "s", toolCallId: "denied", toolName: "task", approved: false, reason: "denied" } as never);
		expect(await s.toolCall("task", task)).toBeUndefined();
		expect(readAudit(auditFileIn(auditDir)).find(r => r.event === "spawn_denied_by_owner")).toMatchObject({ toolCallId: "denied" });
	});

	it("refuses an isolated spawn when the guard's entry sits in a git-ignored part of the project", async () => {
		const ignoredRepo = makeRepo("sg-iso-", [".omp/"]);
		cwd = ignoredRepo;
		const inside = writeGuardEntry(path.join(ignoredRepo, ".omp", "extensions"), { config: config() });
		const s = await loadSession({ entry: inside, cwd: ignoredRepo, ui: fakeUI("Allow") });
		expectRefusal(await s.toolCall("task", { agent: "scoped-worker", task: "x", isolated: true }), "ignored");
		expect(await s.toolCall("task", { agent: "scoped-worker", task: "x" })).toBeUndefined();
	});
});

async function sub(options: { agent?: string; tools?: string[]; childId?: string; subCwd?: string; entryFile?: string } = {}): Promise<Session> {
	return loadSession({ entry: options.entryFile ?? entry(), cwd: options.subCwd ?? cwd, role: "sub", agent: options.agent, tools: options.tools, childId: options.childId });
}

describe("subagent sessions (AC-2, AC-3, AC-4, AC-7)", () => {
	it("are recognised from omp's session_init entry, also in a freshly imported copy of the guard", async () => {
		const ui = fakeUI("Allow");
		const file = entry();
		await loadSession({ entry: file, cwd, ui });
		const fresh = await sub({ entryFile: file, childId: "BraveOtter" });
		expect(await fresh.toolCall("write", { path: "notes.txt", content: "ok" })).toBeUndefined();
		const start = readAudit(auditFileIn(auditDir)).find(r => r.event === "subagent_start");
		expect(start).toMatchObject({ role: "sub", agent: "scoped-worker", child: "BraveOtter" });
	});

	it("block tools outside the subagent allowlist; the main session has no allowlist", async () => {
		const m = await main();
		const s = await sub({ tools: ["read", "write", "bash", "eval", "task", "sneaky_write"] });
		for (const tool of ["bash", "eval", "task", "sneaky_write"]) expectRefusal(await s.toolCall(tool, { command: "echo hi" }), `"${tool}"`);
		expect(await m.toolCall("bash", { command: "echo hi" })).toBeUndefined();
	});

	it("let subagents use hub to message and inspect, but not to start or drive processes", async () => {
		await main();
		const s = await sub();
		expect(await s.toolCall("hub", { op: "list" })).toBeUndefined();
		expect(await s.toolCall("hub", { op: "send", to: "main", message: "done" })).toBeUndefined();
		expectRefusal(await s.toolCall("hub", { op: "start", application: "bash", args: ["-c", "echo probe > canary.txt"] }), '"start"');
		expectRefusal(await s.toolCall("hub", { op: "send", name: "web", text: "rm -rf ." }), "process");
		expectRefusal(await s.toolCall("hub", { op: "restart", name: "web" }), '"restart"');
	});

	it("block writes to protected paths in subagents and in the main session", async () => {
		const m = await main();
		const s = await sub();
		expectRefusal(await s.toolCall("write", { path: ".env", content: "MODE=demo" }), 'Path ".env" is protected');
		expectRefusal(await s.toolCall("edit", { path: ".git/config", edits: [] }), "is protected");
		expectRefusal(await s.toolCall("write", { path: ".omp/agents/scoped-worker.md", content: "x" }), "is protected");
		expectRefusal(await s.toolCall("write", { path: "~/.omp/agent/config.yml", content: "x" }), "is protected");
		expectRefusal(await m.toolCall("write", { path: ".env", content: "MODE=demo" }), "is protected");
	});

	it("let an isolated subagent write in its own copy under ~/.omp/wt", async () => {
		await main();
		const copy = path.join(os.homedir(), ".omp", "wt", "t00c0ffee", "m");
		fs.mkdirSync(copy, { recursive: true });
		const s = await sub({ subCwd: copy });
		expect(await s.toolCall("write", { path: "notes.txt", content: "ok" })).toBeUndefined();
		expectRefusal(await s.toolCall("write", { path: ".env", content: "x" }), "is protected");
		safeRemove(path.join(os.homedir(), ".omp", "wt"));
	});

	it("refuse every call when no main session registered the guard", async () => {
		const s = await sub();
		expectRefusal(await s.toolCall("read", { path: "README.md" }), "main session");
	});

	it("refuse every call of a subagent whose agent is not permitted (for example one started by eval agent())", async () => {
		await main();
		const s = await sub({ agent: "task" });
		expectRefusal(await s.toolCall("read", { path: "README.md" }), '"task"');
	});

	it("refuse every call of a subagent started after the run's spawn cap was reached", async () => {
		await main({ maxSpawns: 1 });
		const first = await sub({ childId: "One" });
		const second = await sub({ childId: "Two" });
		expect(await first.toolCall("read", { path: "README.md" })).toBeUndefined();
		expectRefusal(await second.toolCall("read", { path: "README.md" }), "1");
	});

	it("refuse the call when the guard itself fails while checking it", async () => {
		await main();
		const broken = SessionManager.inMemory(cwd);
		broken.appendSessionInit({ systemPrompt: "", task: "x", tools: ["read"], agent: "scoped-worker" });
		const s = await loadSession({ entry: entry(), cwd, role: "sub", sessionManager: broken });
		expect(await s.toolCall("write", { path: "notes.txt", content: "ok" })).toBeUndefined();
		broken.getSessionId = () => {
			throw new Error("session id unavailable");
		};
		expectRefusal(await s.toolCall("write", { path: "notes.txt", content: "ok" }), "could not check");
	});
});

describe("writes outside the write scope go to the owner (AC-5)", () => {
	it("are written when the owner answers Allow, and the owner sees who asks for what", async () => {
		const ui = fakeUI("Allow");
		await main({}, ui);
		const s = await sub({ childId: "QuietLynx" });
		expect(await s.toolCall("write", { path: "src/app.ts", content: "x" })).toBeUndefined();
		expect(ui.asked).toHaveLength(1);
		expect(ui.asked[0]!.title).toContain("alice");
		expect(ui.asked[0]!.title).toContain("scoped-worker");
		expect(ui.asked[0]!.title).toContain("src/app.ts");
		expect(ui.asked[0]!.timeout).toBe(400);
		expect(await s.toolCall("write", { path: "notes.txt", content: "ok" })).toBeUndefined();
		expect(ui.asked).toHaveLength(1);
	});

	it("are refused when the owner answers Deny or does not answer in time", async () => {
		await main({}, fakeUI("Deny"));
		expectRefusal(await (await sub()).toolCall("write", { path: "src/app.ts", content: "x" }), "owner refused");
		await main({}, fakeUI("none"));
		const started = performance.now();
		expectRefusal(await (await sub()).toolCall("write", { path: "src/app.ts", content: "x" }), "did not answer");
		const elapsed = performance.now() - started;
		expect(elapsed).toBeGreaterThanOrEqual(390);
		expect(elapsed).toBeLessThan(5_000);
	});

	it("are refused when asking the owner fails", async () => {
		const ui = fakeUI("Allow");
		ui.ui.select = async () => {
			throw new Error("dialog closed");
		};
		await main({}, ui);
		expectRefusal(await (await sub()).toolCall("write", { path: "src/app.ts", content: "x" }), "could not ask");
	});

	it("are refused without asking when there is no UI, or when asking is turned off", async () => {
		await loadSession({ entry: entry(), cwd, ui: null });
		expectRefusal(await (await sub()).toolCall("write", { path: "src/app.ts", content: "x" }), "no owner to ask");
		const ui = fakeUI("Allow");
		await main({ askOutsideScope: false }, ui);
		expectRefusal(await (await sub()).toolCall("write", { path: "src/app.ts", content: "x" }), "outside");
		expect(ui.asked).toHaveLength(0);
	});
});

describe("before_subagent_spawn, for omp 18.2.11 and later (AC-8)", () => {
	it("refuses agents that are not permitted, spawns that bypass the task tool, spawns past the cap, and nested spawns", async () => {
		const m = await main({ maxSpawns: 1 });
		const blocked = (results: unknown[]) => results.some(r => (r as ToolCallResult | undefined)?.block === true);
		expect(blocked(await m.invoke("before_subagent_spawn", { agent: "task", invocationKind: "task", spawnKey: "k0" }))).toBe(true);
		expect(blocked(await m.invoke("before_subagent_spawn", { agent: "scoped-worker", invocationKind: "eval", spawnKey: "k1" }))).toBe(true);
		expect(blocked(await m.invoke("before_subagent_spawn", { agent: "scoped-worker", invocationKind: "task", spawnKey: "k2" }))).toBe(false);
		expect(blocked(await m.invoke("before_subagent_spawn", { agent: "scoped-worker", invocationKind: "task", spawnKey: "k3" }))).toBe(true);
		const s = await sub();
		expect(blocked(await s.invoke("before_subagent_spawn", { agent: "scoped-worker", invocationKind: "task", spawnKey: "k4" }))).toBe(true);
		const spawns = readAudit(auditFileIn(auditDir)).filter(r => r.event === "spawn_event");
		expect(spawns.map(r => [r.spawnKey, r.decision])).toEqual([
			["k0", "blocked"],
			["k1", "blocked"],
			["k2", "allowed"],
			["k3", "blocked"],
			["k4", "blocked"],
		]);
	});

	it("refuses the spawn when the handler itself fails", async () => {
		const m = await main();
		m.sessionManager.getSessionId = () => {
			throw new Error("session id unavailable");
		};
		const results = await m.invoke("before_subagent_spawn", { agent: "scoped-worker", invocationKind: "task" });
		expect(results.some(r => (r as ToolCallResult | undefined)?.block === true)).toBe(true);
	});
});

describe("audit log and /subagents (AC-6)", () => {
	it("links the spawn to the subagent, its decisions, and its patch, without file contents", async () => {
		const ui = fakeUI("Deny");
		const sessions = tempDir("sg-sessions-");
		const m = await loadSession({ entry: entry(), cwd, ui, sessionDir: sessions });
		const task = { agent: "scoped-worker", task: "write notes", isolated: false };
		expect(await m.toolCall("task", task, "spawn-1")).toBeUndefined();
		const s = await loadSession({ entry: entry(), cwd, role: "sub", childId: "BraveOtter", parentSessionFile: m.sessionManager.getSessionFile() });
		await s.beforeAgentStart();
		expect(await s.toolCall("write", { path: "notes.txt", content: "SECRET-CONTENT-123" })).toBeUndefined();
		await s.toolResult("write", { path: "notes.txt", content: "SECRET-CONTENT-123" });
		expect((await s.toolCall("write", { path: ".env", content: "SECRET-CONTENT-123" }))?.block).toBe(true);
		expect((await s.toolCall("write", { path: "src/app.ts", content: "SECRET-CONTENT-123" }))?.block).toBe(true);
		const details = { results: [{ id: "BraveOtter", agent: "scoped-worker", exitCode: 0, isolated: true, patchPath: "/tmp/BraveOtter.patch" }, { id: "GhostMoth", agent: "scoped-worker", exitCode: 0 }] };
		await m.toolResult("task", task, { toolCallId: "spawn-1", details });

		const file = auditFileIn(auditDir);
		const text = fs.readFileSync(file, "utf8");
		expect(text).not.toContain("SECRET-CONTENT-123");
		const records = readAudit(file);
		const run = records[0]!.run;
		expect(records.every(r => r.run === run)).toBe(true);
		expect(records.find(r => r.event === "subagent_start")).toMatchObject({ child: "BraveOtter", agent: "scoped-worker", parent: path.basename(m.sessionManager.getSessionFile()!), activeTools: expect.arrayContaining(["write"]) });
		const decisions = records.filter(r => r.event === "tool_call" && r.child === "BraveOtter").map(r => [r.targets, r.decision]);
		expect(decisions).toEqual([
			[["notes.txt"], "allowed"],
			[[".env"], "blocked"],
			[["src/app.ts"], "owner-denied"],
		]);
		expect(records.find(r => r.event === "task_result")).toMatchObject({ toolCallId: "spawn-1", results: [{ id: "BraveOtter", patchPath: "/tmp/BraveOtter.patch" }, { id: "GhostMoth" }] });
		expect(records.find(r => r.event === "unguarded_subagent")).toMatchObject({ child: "GhostMoth" });
		expect(ui.notices.some(n => n.includes("GhostMoth"))).toBe(true);

		const shown = fakeUI("Allow");
		await m.command("subagents", "", shown);
		const widget = (shown.widgets.get("subagents") as string[]).join("\n");
		expect(widget).toContain("alice");
		expect(widget).toContain("BraveOtter");
		expect(widget).toContain("/tmp/BraveOtter.patch");
		expect(widget).toMatch(/BraveOtter.*1 allowed.*2 blocked/s);
		expect(widget).toContain("GhostMoth");
	});

	it("refuses spawns when the audit log cannot be written", async () => {
		const blocker = path.join(tempDir("sg-ro-"), "not-a-dir");
		fs.writeFileSync(blocker, "");
		const ui = fakeUI("Allow");
		const s = await loadSession({ entry: entry({ auditDir: blocker }), cwd, ui });
		expectRefusal(await s.toolCall("task", { agent: "scoped-worker", task: "x" }), "audit");
		expect(ui.notices.some(n => n.includes("audit"))).toBe(true);
	});

	it("refuses spawns and tells the user when the configuration is invalid", async () => {
		const ui = fakeUI("Allow");
		const s = await loadSession({ entry: entry({ askTimeoutMs: 30_000 }), cwd, ui });
		expectRefusal(await s.toolCall("task", { agent: "scoped-worker", task: "x" }), "cannot start subagents");
		expect(ui.notices.some(n => n.includes("askTimeoutMs"))).toBe(true);
	});
});
