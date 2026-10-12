// Live runs against real omp, driven by test/scripted-provider.ts instead of a model, so they need no
// network and no provider account. Opt-in, under `bun run test` like the rest of the suite:
//   SUBAGENT_GUARD_LIVE=1       run these tests
//   OMP_CLI                     omp's src/cli.ts, run with bun (or OMP_BIN: an installed omp executable)
//   SUBAGENT_GUARD_LIVE_OUT     optional folder for evidence, one subfolder per run; must not exist yet
// Every run gets its own HOME, TMPDIR, and repository inside the suite's temporary root. The harness
// plays the owner: it answers omp's "Allow tool: task" and the guard's scope prompts per run.
import { afterAll, describe, expect, it, setDefaultTimeout } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { removeTemps, TEST_ROOT, tempDir, writeFile } from "./fixtures";
import { PACKAGE } from "./helpers";
import type { Script } from "./scripted-provider";

const LIVE = process.env.SUBAGENT_GUARD_LIVE === "1";
const OMP = process.env.OMP_CLI ? ["bun", process.env.OMP_CLI] : process.env.OMP_BIN ? [process.env.OMP_BIN] : [];
const OUT = process.env.SUBAGENT_GUARD_LIVE_OUT;
const PROVIDER = path.join(import.meta.dir, "scripted-provider.ts");
const RUN_TIMEOUT_MS = 150_000;

setDefaultTimeout(240_000);
afterAll(removeTemps);

type Frame = Record<string, unknown> & { at?: number };

interface World {
	root: string;
	home: string;
	tmp: string;
	work: string;
	config: string;
	overlay: string;
	auditDir: string;
}

interface WorldOptions {
	isolated?: boolean;
	/** Extra overlay lines under `tools.approval`. */
	approvals?: Record<string, string>;
	/** task.isolation.apply; omp's default is true. */
	apply?: boolean;
	config?: Record<string, unknown>;
	/** Copy the package's scoped-worker definition to the user level (for runs without the guard). */
	userAgent?: boolean;
	/** A project .omp/agents/scoped-worker.md that overrides the pinned one. */
	projectOverride?: boolean;
}

function git(cwd: string, args: string[]): void {
	Bun.spawnSync(["git", "-C", cwd, "-c", "user.name=fixture", "-c", "user.email=fixture@localhost", "-c", "commit.gpgsign=false", ...args]);
}

function newWorld(options: WorldOptions = {}): World {
	const root = tempDir("sg-live-");
	const home = path.join(root, "home");
	const tmp = path.join(root, "tmp");
	const work = path.join(root, "repo");
	for (const dir of [home, tmp, work]) fs.mkdirSync(dir, { recursive: true });
	writeFile(path.join(work, "README.md"), "# flaky-suite\n");
	writeFile(path.join(work, "src", "app.ts"), "export const retries = 3;\n");
	writeFile(path.join(work, ".gitignore"), "node_modules/\n");
	git(work, ["init", "-q"]);
	git(work, ["add", "-A"]);
	git(work, ["commit", "-qm", "fixture"]);
	const definition = fs.readFileSync(path.join(PACKAGE, "agents", "scoped-worker.md"), "utf8");
	if (options.userAgent) writeFile(path.join(home, ".omp", "agent", "agents", "scoped-worker.md"), definition);
	if (options.projectOverride) writeFile(path.join(work, ".omp", "agents", "scoped-worker.md"), definition.replace("tools: read, grep, glob, find, write, edit", "tools: read, write, edit, bash"));
	const auditDir = path.join(root, "trust", "audit");
	const config = writeFile(
		path.join(root, "trust", "config.json"),
		JSON.stringify({ agents: { "scoped-worker": { writeScope: ["notes.txt"] } }, auditDir, ...options.config }, null, 2),
	);
	const approvals = Object.entries(options.approvals ?? {});
	const overlay = writeFile(
		path.join(root, "overlay.yml"),
		[
			"async:",
			"  enabled: false",
			...(approvals.length ? ["tools:", "  approval:", ...approvals.map(([tool, policy]) => `    ${tool}: ${policy}`)] : []),
			"task:",
			"  maxRecursionDepth: 1",
			"  maxRuntimeMs: 120000",
			"  isolation:",
			`    enabled: ${options.isolated === true}`,
			...(options.apply === undefined ? [] : [`    apply: ${options.apply}`]),
			"  agentModelOverrides:",
			"    scoped-worker: scripted/scripted",
			"    task: scripted/scripted",
			"",
		].join("\n"),
	);
	return { root, home, tmp, work, config, overlay, auditDir };
}

type Answer = "Allow" | "Deny" | "none";

interface RunOptions {
	guard: boolean;
	/** `null`: start without --subagent-owner. */
	owner?: string | null;
	script: Script;
	/** The owner's answer to "Allow tool: task". */
	task?: "Approve" | "Deny";
	/** The owner's answer to a scope prompt, by the path it names. */
	scope?: (title: string) => Answer;
	print?: boolean;
}

interface Asked {
	title: string;
	answer: string;
	at: number;
}

interface Run {
	name: string;
	dir: string | undefined;
	world: World;
	frames: Frame[];
	asked: Asked[];
	notices: string[];
	audit: Record<string, unknown>[];
	stdout: string;
	stderr: string;
	exitCode: number | null;
	requests: Array<{ script: string; step: number; messages: Array<{ role: string; content: unknown; toolName?: string; isError?: boolean }> }>;
}

function sanitize(text: string, world: World): string {
	return text.replaceAll(world.root, "<root>").replaceAll(PACKAGE, "<package>").replaceAll(TEST_ROOT, "<suite>");
}

function evidenceDir(name: string): string | undefined {
	if (!OUT) return undefined;
	const dir = path.join(OUT, name);
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

function readAuditDir(dir: string): Record<string, unknown>[] {
	if (!fs.existsSync(dir)) return [];
	return fs
		.readdirSync(dir)
		.filter(name => name.endsWith(".jsonl"))
		.flatMap(name => fs.readFileSync(path.join(dir, name), "utf8").split("\n").filter(line => line.trim()))
		.map(line => JSON.parse(line) as Record<string, unknown>);
}

async function waitFor(probe: () => boolean, what: string, failed: () => string | undefined, timeoutMs = RUN_TIMEOUT_MS): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (probe()) return;
		const failure = failed();
		if (failure) throw new Error(`${what}: ${failure}`);
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await Bun.sleep(50);
	}
}

async function runOmp(world: World, name: string, options: RunOptions): Promise<Run> {
	const slug = name.replaceAll("/", "-");
	const script = writeFile(path.join(world.root, `${slug}.script.json`), JSON.stringify(options.script));
	const log = path.join(world.root, `${slug}.requests.jsonl`);
	const guardFlags = options.guard
		? ["-e", PACKAGE, "--subagent-guard-config", world.config, ...(options.owner === null ? [] : ["--subagent-owner", options.owner ?? "alice"])]
		: [];
	const command = [
		...OMP,
		...(options.print ? ["-p", "go"] : ["--mode", "rpc"]),
		"--cwd",
		world.work,
		"-e",
		PROVIDER,
		...guardFlags,
		"--config",
		world.overlay,
		"--model",
		"scripted/scripted",
		"--tools",
		"read,task",
		"--approval-mode",
		options.print ? "yolo" : "always-ask",
		"--session-dir",
		path.join(world.root, "sessions", slug),
		"--no-title",
		"--no-lsp",
		"--no-rules",
		"--no-skills",
	];
	const proc = Bun.spawn(command, {
		cwd: world.work,
		env: {
			PATH: process.env.PATH ?? "",
			HOME: world.home,
			USER: process.env.USER ?? "user",
			LANG: "C.UTF-8",
			TERM: "dumb",
			TMPDIR: world.tmp,
			SCRIPTED_PROVIDER_SCRIPT: script,
			SCRIPTED_PROVIDER_LOG: log,
		},
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	// In print mode omp reads piped stdin as part of the prompt and waits for it to close.
	if (options.print) proc.stdin.end();
	const frames: Frame[] = [];
	const asked: Asked[] = [];
	let stdoutText = "";
	const reply = (id: unknown, value: string) => {
		proc.stdin.write(`${JSON.stringify({ type: "extension_ui_response", id, value })}\n`);
		proc.stdin.flush();
	};
	const stdout = (async () => {
		const decoder = new TextDecoder();
		let buffer = "";
		for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
			const text = decoder.decode(chunk, { stream: true });
			stdoutText += text;
			if (options.print) continue;
			buffer += text;
			for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				let frame: Frame;
				try {
					frame = JSON.parse(line) as Frame;
				} catch {
					continue;
				}
				frame.at = Date.now();
				frames.push(frame);
				if (frame.type !== "extension_ui_request" || frame.method !== "select") continue;
				const title = String(frame.title ?? "");
				const answer = /^Allow tool: task\b/.test(title) ? (options.task ?? "Approve") : title.startsWith("Subagent write outside its scope") ? (options.scope?.(title) ?? "Deny") : "Deny";
				asked.push({ title, answer, at: frame.at });
				if (answer !== "none") reply(frame.id, answer);
			}
		}
	})();
	const stderrText = new Response(proc.stderr as ReadableStream<Uint8Array>).text();
	const failed = () => (proc.exitCode !== null ? `exited with ${proc.exitCode}` : undefined);
	try {
		if (options.print) {
			await Promise.race([proc.exited, Bun.sleep(RUN_TIMEOUT_MS)]);
		} else {
			await waitFor(() => frames.some(frame => frame.type === "ready"), "ready", failed);
			proc.stdin.write(`${JSON.stringify({ id: "p1", type: "prompt", message: "Delegate the assignment." })}\n`);
			proc.stdin.flush();
			await waitFor(() => frames.some(frame => frame.type === "agent_end" && frame.isTerminal !== false), "the end of the turn", failed);
		}
	} finally {
		if (!options.print) proc.stdin.end();
		const exited = await Promise.race([proc.exited.then(() => true), Bun.sleep(30_000).then(() => false)]);
		if (!exited) proc.kill();
		await stdout;
	}
	const stderr = await stderrText;
	const requestsText = fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "";
	const run: Run = {
		name,
		dir: evidenceDir(name),
		world,
		frames,
		asked,
		notices: frames.filter(frame => frame.type === "extension_ui_request" && frame.method === "notify").map(frame => String(frame.message ?? "")),
		audit: readAuditDir(world.auditDir),
		stdout: stdoutText,
		stderr,
		exitCode: proc.exitCode,
		requests: requestsText
			.split("\n")
			.filter(line => line.trim())
			.map(line => JSON.parse(line) as Run["requests"][number]),
	};
	if (run.dir) {
		fs.writeFileSync(path.join(run.dir, "cmd.txt"), `${sanitize(["omp", ...command.slice(OMP.length)].join(" "), world)}\n`);
		fs.writeFileSync(path.join(run.dir, "script.json"), `${JSON.stringify(options.script, null, 2)}\n`);
		fs.writeFileSync(path.join(run.dir, "events.jsonl"), sanitize(frames.map(frame => JSON.stringify(frame)).join("\n"), world));
		fs.writeFileSync(path.join(run.dir, "provider-requests.jsonl"), sanitize(requestsText, world));
		fs.writeFileSync(path.join(run.dir, "audit.jsonl"), sanitize(run.audit.map(record => JSON.stringify(record)).join("\n"), world));
		fs.writeFileSync(path.join(run.dir, "stdout.txt"), sanitize(options.print ? stdoutText : "", world));
		fs.writeFileSync(path.join(run.dir, "stderr.txt"), sanitize(stderr, world));
		fs.writeFileSync(path.join(run.dir, "overlay.yml"), fs.readFileSync(world.overlay, "utf8"));
		if (options.guard) fs.writeFileSync(path.join(run.dir, "config.json"), sanitize(fs.readFileSync(world.config, "utf8"), world));
	}
	return run;
}

/** What a subagent's tool calls got back, from the requests the child script saw. */
function childResults(run: Run, marker: string): Array<{ tool: string; isError: boolean; text: string }> {
	const last = run.requests.filter(request => request.script === marker).at(-1);
	return (last?.messages ?? [])
		.filter(message => message.role === "toolResult")
		.map(message => ({
			tool: message.toolName ?? "",
			isError: message.isError === true,
			text: Array.isArray(message.content) ? (message.content as Array<{ text?: string }>).map(part => part.text ?? "").join("") : String(message.content ?? ""),
		}));
}

function parentResults(run: Run): Array<{ tool: string; isError: boolean; text: string }> {
	return childResults(run, "parent");
}

function exists(world: World, rel: string): boolean {
	return fs.existsSync(path.join(world.work, rel));
}

function isolationDirsLeft(world: World): string[] {
	const wt = path.join(world.home, ".omp", "wt");
	return fs.existsSync(wt) ? fs.readdirSync(wt) : [];
}

function record(run: Run, checks: Record<string, unknown>): void {
	if (!run.dir) return;
	const summary = {
		run: run.name,
		exitCode: run.exitCode,
		asked: run.asked.map(item => ({ title: item.title.split("\n")[0], answer: item.answer })),
		notices: run.notices.map(notice => sanitize(notice, run.world)),
		checks,
	};
	fs.writeFileSync(path.join(run.dir, "summary.json"), `${sanitize(JSON.stringify(summary, null, 2), run.world)}\n`);
}

const write = (file: string, content: string) => ({ name: "write", arguments: { path: file, content } });
const done = { name: "yield", arguments: { data: "child done" } };
const spawn = (args: Record<string, unknown>) => ({ toolCalls: [{ name: "task", arguments: args }] });

describe.skipIf(!LIVE || OMP.length === 0)("live: real omp 18.2.8 with a scripted model", () => {
	if (OUT && fs.existsSync(OUT) && fs.readdirSync(OUT).length > 0) throw new Error(`${OUT} already exists`);

	it("before: without the guard, the bundled task agent writes .env into the checkout", async () => {
		const world = newWorld();
		const run = await runOmp(world, "01-before", {
			guard: false,
			script: { parent: [spawn({ agent: "task", task: "CHILD-A write the files" }), { text: "parent done" }], children: { "CHILD-A": [{ toolCalls: [write(".env", "MODE=demo\n")] }, { toolCalls: [write("notes.txt", "ok\n")] }, { toolCalls: [done] }] } },
		});
		const checks = { envInCheckout: exists(world, ".env"), notesInCheckout: exists(world, "notes.txt"), taskPrompts: run.asked.filter(item => item.title.startsWith("Allow tool: task")).length };
		record(run, checks);
		expect(checks).toEqual({ envInCheckout: true, notesInCheckout: true, taskPrompts: 1 });
	});

	it("before: without the guard, a scoped-worker with no bash still runs a command through hub start", async () => {
		const world = newWorld({ userAgent: true });
		const hubStart = { name: "hub", arguments: { op: "start", name: "probe", application: "bash", args: ["-c", "echo probe > canary.txt"], pty: false } };
		const run = await runOmp(world, "02-before-hub", {
			guard: false,
			script: { parent: [spawn({ agent: "scoped-worker", task: "CHILD-A start the probe" }), { text: "parent done" }], children: { "CHILD-A": [{ toolCalls: [hubStart] }, { toolCalls: [{ name: "hub", arguments: { op: "wait", name: "probe", for: "exit", timeout: 10 } }] }, { toolCalls: [done] }] } },
		});
		await Bun.sleep(500);
		const results = childResults(run, "CHILD-A");
		const checks = { canaryInCheckout: exists(world, "canary.txt"), hubStartError: results.find(result => result.tool === "hub")?.isError ?? null, hubStartText: results.find(result => result.tool === "hub")?.text.slice(0, 200) ?? null };
		record(run, checks);
		expect(checks.canaryInCheckout).toBe(true);
	});

	it("guard: protected paths, the write scope with the owner's Allow and Deny, and hub start", async () => {
		const world = newWorld({ config: { askTimeoutMs: 20_000 } });
		const run = await runOmp(world, "03-guard-shared", {
			guard: true,
			scope: title => (title.includes("src/app.ts") ? "Allow" : "Deny"),
			script: {
				parent: [spawn({ agent: "scoped-worker", task: "CHILD-A write the files" }), { text: "parent done" }],
				children: {
					"CHILD-A": [
						{ toolCalls: [write(".env", "MODE=demo\n")] },
						{ toolCalls: [write("notes.txt", "ok\n")] },
						{ toolCalls: [write("src/app.ts", "export const retries = 5;\n")] },
						{ toolCalls: [write("README.md", "# replaced\n")] },
						{ toolCalls: [write(".omp/agents/scoped-worker.md", "---\nname: scoped-worker\ntools: bash\n---\n")] },
						{ toolCalls: [{ name: "hub", arguments: { op: "start", name: "probe", application: "bash", args: ["-c", "echo probe > canary.txt"], pty: false } }] },
						{ toolCalls: [done] },
					],
				},
			},
		});
		const results = childResults(run, "CHILD-A");
		const audit = run.audit;
		const start = audit.find(r => r.event === "subagent_start");
		const taskResult = audit.find(r => r.event === "task_result") as { results?: Array<{ id: string }> } | undefined;
		const checks = {
			envInCheckout: exists(world, ".env"),
			notes: exists(world, "notes.txt") ? fs.readFileSync(path.join(world.work, "notes.txt"), "utf8") : null,
			appChanged: fs.readFileSync(path.join(world.work, "src", "app.ts"), "utf8").includes("retries = 5"),
			readmeUnchanged: fs.readFileSync(path.join(world.work, "README.md"), "utf8") === "# flaky-suite\n",
			projectAgentWritten: exists(world, ".omp/agents/scoped-worker.md"),
			canaryInCheckout: exists(world, "canary.txt"),
			childResults: results.map(result => [result.tool, result.isError, result.text.split("\n").at(-1)?.slice(0, 160)]),
			decisions: audit.filter(r => r.event === "tool_call" && r.role === "sub").map(r => [r.tool, r.targets ?? null, r.decision]),
			scopePrompts: run.asked.filter(item => item.title.startsWith("Subagent write outside its scope")).map(item => [item.title.split("\n").at(-1), item.answer]),
			taskPrompts: run.asked.filter(item => item.title.startsWith("Allow tool: task")).length,
			childLinked: Boolean(start && taskResult?.results?.some(result => result.id === start.child)),
			spawnOwner: audit.find(r => r.event === "spawn_request")?.owner ?? null,
		};
		record(run, checks);
		expect(checks).toMatchObject({ envInCheckout: false, notes: "ok\n", appChanged: true, readmeUnchanged: true, projectAgentWritten: false, canaryInCheckout: false, taskPrompts: 1, childLinked: true, spawnOwner: "alice" });
		expect(checks.decisions).toEqual([
			["write", [".env"], "blocked"],
			["write", ["notes.txt"], "allowed"],
			["write", ["src/app.ts"], "owner-allowed"],
			["write", ["README.md"], "owner-denied"],
			["write", [".omp/agents/scoped-worker.md"], "blocked"],
			["hub", null, "blocked"],
			["yield", null, "allowed"],
		]);
		expect(results.find(result => result.text.includes(".env"))?.text).toContain('Path ".env" is protected');
	});

	it("guard: an isolated subagent loads a fresh copy of the guard, and with apply: false its patch is kept, not applied", async () => {
		const world = newWorld({ isolated: true, apply: false });
		const run = await runOmp(world, "04-guard-isolated", {
			guard: true,
			script: { parent: [spawn({ agent: "scoped-worker", task: "CHILD-A write the files", isolated: true }), { text: "parent done" }], children: { "CHILD-A": [{ toolCalls: [write(".env", "MODE=demo\n")] }, { toolCalls: [write("notes.txt", "ok\n")] }, { toolCalls: [done] }] } },
		});
		const start = run.audit.find(r => r.event === "subagent_start");
		const result = (run.audit.find(r => r.event === "task_result") as { results?: Array<{ id: string; patchPath: string | null }> } | undefined)?.results?.[0];
		const patch = result?.patchPath && fs.existsSync(result.patchPath) ? fs.readFileSync(result.patchPath, "utf8") : "";
		if (run.dir && patch) fs.writeFileSync(path.join(run.dir, "task.patch"), patch);
		const checks = {
			cwdKind: start?.cwdKind ?? null,
			childLinked: start?.child === result?.id,
			decisions: run.audit.filter(r => r.event === "tool_call" && r.role === "sub").map(r => [r.targets ?? null, r.decision]),
			notesInCheckout: exists(world, "notes.txt"),
			envInCheckout: exists(world, ".env"),
			patchHasNotes: patch.includes("notes.txt"),
			patchHasEnv: patch.includes(".env"),
			isolationDirsLeft: isolationDirsLeft(world).length,
		};
		record(run, checks);
		expect(checks).toEqual({
			cwdKind: "isolation",
			childLinked: true,
			decisions: [
				[[".env"], "blocked"],
				[["notes.txt"], "allowed"],
				[null, "allowed"],
			],
			notesInCheckout: false,
			envInCheckout: false,
			patchHasNotes: true,
			patchHasEnv: false,
			isolationDirsLeft: 0,
		});
	});

	it("guard: refused spawns never reach the owner's Allow tool: task prompt", async () => {
		const world = newWorld({ projectOverride: true });
		const run = await runOmp(world, "05-spawn-gate", {
			guard: true,
			script: { parent: [spawn({ agent: "task", task: "CHILD-A x" }), spawn({ task: "CHILD-A x" }), spawn({ agent: "scoped-worker", task: "CHILD-A x" }), { text: "parent done" }], children: { "CHILD-A": [{ toolCalls: [write("notes.txt", "ok\n")] }] } },
		});
		const checks = {
			parentResults: parentResults(run).map(result => [result.isError, result.text.slice(0, 200)]),
			spawnDecisions: run.audit.filter(r => r.event === "spawn_request").map(r => r.decision),
			taskPrompts: run.asked.filter(item => item.title.startsWith("Allow tool: task")).length,
			subagentsStarted: run.audit.filter(r => r.event === "subagent_start").length,
			startupNotice: run.notices.some(notice => notice.includes('"scoped-worker" cannot be spawned') && notice.includes("project")),
		};
		record(run, checks);
		expect(checks).toMatchObject({ spawnDecisions: ["blocked", "blocked", "blocked"], taskPrompts: 0, subagentsStarted: 0, startupNotice: true });
		expect(checks.parentResults.map(([isError]) => isError)).toEqual([true, true, true]);
		expect(String(checks.parentResults[0]![1])).toContain('agent "task" is not one of the agents permitted');
		expect(String(checks.parentResults[2]![1])).toContain("project");
	});

	it("guard: a run with no named owner refuses to spawn and tells the user how to name one", async () => {
		const world = newWorld();
		const run = await runOmp(world, "06-no-owner", {
			guard: true,
			owner: null,
			script: { parent: [spawn({ agent: "scoped-worker", task: "CHILD-A x" }), { text: "parent done" }], children: { "CHILD-A": [{ toolCalls: [write("notes.txt", "ok\n")] }] } },
		});
		const checks = { parent: parentResults(run).map(result => [result.isError, result.text.slice(0, 120)]), notice: run.notices.some(notice => notice.includes("--subagent-owner")), subagentsStarted: run.audit.filter(r => r.event === "subagent_start").length };
		record(run, checks);
		expect(checks).toMatchObject({ notice: true, subagentsStarted: 0 });
		expect(checks.parent[0]).toEqual([true, "Delegation refused: this run has no named owner."]);
	});

	it("guard: when the owner presses Deny at Allow tool: task, no subagent starts and the reservation is released", async () => {
		const world = newWorld({ config: { maxSpawns: 1 } });
		const run = await runOmp(world, "07-deny-task", {
			guard: true,
			task: "Deny",
			script: { parent: [spawn({ agent: "scoped-worker", task: "CHILD-A x" }), spawn({ agent: "scoped-worker", task: "CHILD-A x" }), { text: "parent done" }], children: { "CHILD-A": [{ toolCalls: [write("notes.txt", "ok\n")] }] } },
		});
		const checks = {
			parent: parentResults(run).map(result => [result.isError, result.text.slice(0, 120)]),
			spawnDecisions: run.audit.filter(r => r.event === "spawn_request").map(r => r.decision),
			deniedByOwner: run.audit.filter(r => r.event === "spawn_denied_by_owner").length,
			subagentsStarted: run.audit.filter(r => r.event === "subagent_start").length,
		};
		record(run, checks);
		expect(checks).toMatchObject({ spawnDecisions: ["allowed", "allowed"], deniedByOwner: 2, subagentsStarted: 0 });
		expect(checks.parent.map(([isError, text]) => [isError, String(text).includes("denied")])).toEqual([
			[true, true],
			[true, true],
		]);
	});

	it("guard: an owner who does not answer is treated as a refusal after 20 s, inside omp's 30 s handler budget", async () => {
		const world = newWorld();
		const run = await runOmp(world, "08-ask-timeout", {
			guard: true,
			scope: () => "none",
			script: { parent: [spawn({ agent: "scoped-worker", task: "CHILD-A x" }), { text: "parent done" }], children: { "CHILD-A": [{ toolCalls: [write("src/app.ts", "export const retries = 5;\n")] }, { toolCalls: [done] }] } },
		});
		const asked = run.asked.find(item => item.title.startsWith("Subagent write outside its scope"));
		const decision = run.audit.find(r => r.event === "tool_call" && r.tool === "write");
		const decidedAt = decision ? Date.parse(String(decision.ts)) : Number.NaN;
		const result = childResults(run, "CHILD-A").find(item => item.tool === "write");
		const checks = { waitedMs: asked ? decidedAt - asked.at : null, decision: decision?.decision ?? null, reason: result?.text ?? null, appUnchanged: !fs.readFileSync(path.join(world.work, "src", "app.ts"), "utf8").includes("retries = 5") };
		record(run, checks);
		expect(checks).toMatchObject({ decision: "owner-timeout", appUnchanged: true });
		expect(checks.reason).toContain("did not answer within 20 s");
		expect(checks.waitedMs).toBeGreaterThanOrEqual(19_000);
		expect(checks.waitedMs).toBeLessThan(30_000);
	});

	it("guard: in print mode there is no owner to ask, so writes outside the scope are refused", async () => {
		const world = newWorld();
		const run = await runOmp(world, "09-print-no-ui", {
			guard: true,
			print: true,
			script: { parent: [spawn({ agent: "scoped-worker", task: "CHILD-A x" }), { text: "parent done" }], children: { "CHILD-A": [{ toolCalls: [write("notes.txt", "ok\n")] }, { toolCalls: [write("src/app.ts", "export const retries = 5;\n")] }, { toolCalls: [done] }] } },
		});
		const checks = { exitCode: run.exitCode, decisions: run.audit.filter(r => r.event === "tool_call" && r.role === "sub").map(r => [r.targets ?? null, r.decision]), notes: exists(world, "notes.txt") };
		record(run, checks);
		expect(checks).toEqual({
			exitCode: 0,
			decisions: [
				[["notes.txt"], "allowed"],
				[["src/app.ts"], "owner-unavailable"],
				[null, "allowed"],
			],
			notes: true,
		});
	});

	it("overlay only: prompt rules refuse a subagent's bash and hub start at once, and apply: false keeps the patch", async () => {
		const world = newWorld({ isolated: true, apply: false, approvals: { bash: "prompt", eval: "prompt", hub: "prompt" } });
		const run = await runOmp(world, "10-overlay-only", {
			guard: false,
			script: {
				parent: [spawn({ agent: "task", task: "CHILD-A x", isolated: true }), { text: "parent done" }],
				children: {
					"CHILD-A": [
						{ toolCalls: [{ name: "bash", arguments: { command: "echo probe > canary.txt" } }] },
						{ toolCalls: [{ name: "hub", arguments: { op: "start", name: "probe", application: "bash", args: ["-c", "echo probe > canary.txt"], pty: false } }] },
						{ toolCalls: [write("notes.txt", "ok\n")] },
						{ toolCalls: [done] },
					],
				},
			},
		});
		const results = childResults(run, "CHILD-A");
		const checks = {
			bash: results.find(result => result.tool === "bash")?.text.split("\n")[0] ?? null,
			hub: results.find(result => result.tool === "hub")?.text.split("\n")[0] ?? null,
			canaryInCheckout: exists(world, "canary.txt"),
			notesInCheckout: exists(world, "notes.txt"),
			patchKept: (parentResults(run)[0]?.text ?? "").includes(".patch"),
		};
		record(run, checks);
		expect(checks).toMatchObject({ canaryInCheckout: false, notesInCheckout: false });
		expect(checks.bash).toContain("requires approval but no interactive UI available");
		expect(checks.hub).toContain("requires approval but no interactive UI available");
	});
});
