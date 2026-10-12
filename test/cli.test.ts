import { afterAll, afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { makeRepo, removeTemps, safeRemove, tempDir, userAgentsDir, writeAgent, writeFile } from "./fixtures";
import { closeRegistry, PACKAGE, resetGuardState } from "./helpers";
import { delegatedRun } from "./runs";

// Each case starts the CLI, which loads omp's discovery; --isolation also builds a real copy.
setDefaultTimeout(60_000);

const BIN = path.join(PACKAGE, "bin", "omp-subagent-guard.ts");
const GOOD_OVERLAY = ["tools:", "  approval:", "    bash: prompt", "    eval: deny", "    hub: prompt", "task:", "  maxRecursionDepth: 1", "  maxRuntimeMs: 900000", "  isolation:", "    apply: false", ""].join("\n");

afterAll(() => {
	closeRegistry();
	removeTemps();
});
beforeEach(resetGuardState);
afterEach(() => {
	safeRemove(userAgentsDir());
	safeRemove(path.join(os.homedir(), ".omp", "wt"));
});

function cli(args: string[], cwd = PACKAGE): { code: number; out: string } {
	const ran = Bun.spawnSync(["bun", BIN, ...args], { cwd, env: process.env, stdout: "pipe", stderr: "pipe" });
	return { code: ran.exitCode ?? -1, out: `${ran.stdout.toString()}${ran.stderr.toString()}` };
}

interface Setup {
	cwd: string;
	config: string;
	overlay: string;
}

function setup(overlay = GOOD_OVERLAY, ignore: string[] = []): Setup {
	const cwd = makeRepo("sg-cli-", ignore);
	const dir = tempDir("sg-cli-cfg-");
	const pinned = writeAgent(path.join(userAgentsDir(), "scoped-worker.md"), "scoped-worker");
	const config = writeFile(path.join(dir, "config.json"), JSON.stringify({ owner: "alice", agents: { "scoped-worker": { definition: pinned, writeScope: ["notes.txt"] } }, auditDir: path.join(dir, "audit") }));
	return { cwd, config, overlay: writeFile(path.join(dir, "overlay.yml"), overlay) };
}

function preflight(s: Setup, extra: string[] = []) {
	return cli(["preflight", "--cwd", s.cwd, "--config", s.config, "--overlay", s.overlay, ...extra]);
}

describe("omp-subagent-guard preflight (AC-9)", () => {
	it("exits 0 when the agents are pinned, the overlay sets every rule, and the guard follows isolated subagents", () => {
		const ran = preflight(setup());
		expect({ code: ran.code, out: ran.out }).toMatchObject({ code: 0 });
		expect(ran.out).toContain("pass");
		expect(ran.out).not.toContain("FAIL");
	});

	it("exits 1 and names the rule when the overlay leaves one out", () => {
		const ran = preflight(setup(GOOD_OVERLAY.replace("    eval: deny\n", "")));
		expect(ran.code).toBe(1);
		expect(ran.out).toContain("tools.approval.eval");
	});

	it("exits 1 when the project overrides a permitted agent's definition", () => {
		const s = setup();
		writeAgent(path.join(s.cwd, ".omp", "agents", "scoped-worker.md"), "scoped-worker");
		const ran = preflight(s);
		expect(ran.code).toBe(1);
		expect(ran.out).toContain("project");
	});

	it("exits 1 when a guard entry sits in a git-ignored part of the project, and --isolation shows the copy lacks it", () => {
		const s = setup(GOOD_OVERLAY, [".omp/"]);
		const ignored = writeFile(path.join(s.cwd, ".omp", "extensions", "guard.ts"), "export default function () {}\n");
		const tracked = writeFile(path.join(s.cwd, "tools", "guard.ts"), "export default function () {}\n");
		const bad = preflight(s, ["--guard", ignored, "--isolation", "--json"]);
		expect(bad.code).toBe(1);
		const checks = JSON.parse(bad.out) as { checks: Array<{ check: string; status: string; detail: string }> };
		expect(checks.checks.find(c => c.check === "isolation-copy" && c.detail.includes("guard.ts"))?.status).toBe("fail");
		const good = preflight(s, ["--guard", tracked, "--isolation"]);
		expect(good.code).toBe(0);
		expect(fs.existsSync(path.join(os.homedir(), ".omp", "wt")) ? fs.readdirSync(path.join(os.homedir(), ".omp", "wt")) : []).toEqual([]);
	});

	it("passes with the shipped example configuration, overlay, and scoped-worker definition", () => {
		const cwd = makeRepo("sg-cli-shipped-");
		const ran = cli(["preflight", "--cwd", cwd, "--config", path.join(PACKAGE, "examples", "config.example.json"), "--overlay", path.join(PACKAGE, "examples", "overlay.yml"), "--json"]);
		expect(ran.code).toBe(0);
		const report = JSON.parse(ran.out) as { checks: Array<{ check: string; status: string; detail: string }> };
		expect(report.checks.find(c => c.check === "agent scoped-worker")?.detail).toContain(path.join(PACKAGE, "agents", "scoped-worker.md"));
		expect(report.checks.filter(c => c.check === "overlay").map(c => c.status)).toEqual(["pass", "pass", "pass", "pass", "pass", "pass"]);
	});

	it("exits 2 on a usage error", () => {
		expect(cli(["preflight", "--bogus"]).code).toBe(2);
		expect(cli(["frobnicate"]).code).toBe(2);
	});
});

describe("omp-subagent-guard report (AC-6)", () => {
	it("prints the spawn-to-subagent report for a log, and exits 1 for a log it cannot read", async () => {
		const log = await delegatedRun();
		const ran = cli(["report", log]);
		expect(ran.code).toBe(0);
		expect(ran.out).toMatch(/spawn-1.*BraveOtter/s);
		expect(cli(["report", path.join(tempDir("sg-none-"), "missing.jsonl")]).code).toBe(1);
	});
});
