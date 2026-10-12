import * as path from "node:path";
import { makeRepo, tempDir, userAgentsDir, writeAgent } from "./fixtures";
import { auditFileIn, fakeUI, loadSession, writeGuardEntry } from "./helpers";

/**
 * Runs, through the guard the way omp does, one refused spawn and one isolated spawn whose
 * subagent writes in scope, hits a protected path, and tries bash. Returns the audit log path.
 */
export async function delegatedRun(): Promise<string> {
	const cwd = makeRepo();
	const auditDir = tempDir("sg-audit-");
	const pinned = writeAgent(path.join(userAgentsDir(), "scoped-worker.md"), "scoped-worker");
	const entry = writeGuardEntry(tempDir("sg-entry-"), { config: { owner: "alice", agents: { "scoped-worker": { definition: pinned, writeScope: ["notes.txt"] } }, auditDir, askTimeoutMs: 400 } });
	const m = await loadSession({ entry, cwd, ui: fakeUI("Deny"), sessionDir: tempDir("sg-sessions-") });
	await m.toolCall("task", { agent: "task", task: "x" }, "spawn-0");
	const task = { agent: "scoped-worker", task: "write notes", isolated: true };
	await m.toolCall("task", task, "spawn-1");
	const s = await loadSession({ entry, cwd, role: "sub", childId: "BraveOtter", parentSessionFile: m.sessionManager.getSessionFile() });
	await s.toolCall("write", { path: "notes.txt", content: "ok" });
	await s.toolCall("write", { path: ".env", content: "MODE=demo" });
	await s.toolCall("bash", { command: "echo hi" });
	await m.toolResult("task", task, {
		toolCallId: "spawn-1",
		details: { results: [{ id: "BraveOtter", agent: "scoped-worker", exitCode: 0, isolated: true, patchPath: "/tmp/BraveOtter.patch" }] },
	});
	return auditFileIn(auditDir);
}
