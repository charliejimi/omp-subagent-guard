import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { buildReport, formatReport } from "../src/audit";
import { removeTemps, safeRemove, userAgentsDir } from "./fixtures";
import { closeRegistry, readAudit, resetGuardState } from "./helpers";
import { delegatedRun } from "./runs";

afterAll(() => {
	closeRegistry();
	removeTemps();
});
beforeEach(resetGuardState);
afterEach(() => safeRemove(userAgentsDir()));

describe("report (AC-6)", () => {
	it("links each spawn to the subagent it started, what that subagent did, and where its patch is", async () => {
		const report = buildReport(readAudit(await delegatedRun()));
		expect(report.runs).toHaveLength(1);
		const run = report.runs[0]!;
		expect(run.owner).toBe("alice");
		expect(run.spawns.map(s => [s.toolCallId, s.decision, s.children])).toEqual([
			["spawn-0", "blocked", []],
			["spawn-1", "allowed", ["BraveOtter"]],
		]);
		const child = run.children.find(c => c.id === "BraveOtter")!;
		expect(child).toMatchObject({ agent: "scoped-worker", spawn: "spawn-1", patchPath: "/tmp/BraveOtter.patch", exitCode: 0, allowed: 1, blocked: 2 });
		expect(child.blockedCalls.map(c => c.tool)).toEqual(["write", "bash"]);

		const text = formatReport(report).join("\n");
		expect(text).toContain("owner alice");
		expect(text).toMatch(/spawn-1.*BraveOtter/s);
		expect(text).toContain("/tmp/BraveOtter.patch");
		expect(text).toContain('Path ".env" is protected');
	});
});
