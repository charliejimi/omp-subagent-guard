import { afterAll, afterEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { definitionProblem, isolationProblem, spawnItems } from "../src/spawn";
import { makeRepo, removeTemps, safeRemove, tempDir, userAgentsDir, writeAgent, writeFile } from "./fixtures";
import { SCOPED_TOOLS } from "./helpers";

afterEach(() => safeRemove(userAgentsDir()));
afterAll(removeTemps);

describe("spawnItems", () => {
	it("reads the flat and the batch task shapes the way omp's task tool does", () => {
		expect(spawnItems({ agent: "scoped-worker", task: "x", isolated: true })).toEqual([{ agent: "scoped-worker", isolated: true, tools: [] }]);
		expect(spawnItems({ task: "x" })).toEqual([{ agent: undefined, isolated: false, tools: [] }]);
		expect(spawnItems({ agent: "  ", task: "x" })).toEqual([{ agent: undefined, isolated: false, tools: [] }]);
		expect(
			spawnItems({
				context: "shared",
				tasks: [
					{ agent: "a", task: "1" },
					{ agent: "b", task: "2", isolated: true, tools: ["fetch_rows"] },
				],
			}),
		).toEqual([
			{ agent: "a", isolated: false, tools: [] },
			{ agent: "b", isolated: true, tools: ["fetch_rows"] },
		]);
		expect(spawnItems({ agent: "a", task: "x", tasks: [] })).toEqual([{ agent: "a", isolated: false, tools: [] }]);
	});
});

describe("definitionProblem", () => {
	it("accepts the pinned definition with a narrow tool list", async () => {
		const cwd = makeRepo();
		const pinned = writeAgent(path.join(userAgentsDir(), "scoped-worker.md"), "scoped-worker");
		expect(await definitionProblem("scoped-worker", pinned, cwd, SCOPED_TOOLS)).toBeUndefined();
	});

	it("refuses a project definition that overrides the pinned one", async () => {
		const cwd = makeRepo();
		const pinned = writeAgent(path.join(userAgentsDir(), "scoped-worker.md"), "scoped-worker");
		writeAgent(path.join(cwd, ".omp", "agents", "scoped-worker.md"), "scoped-worker", { tools: "read, write, bash" });
		expect(await definitionProblem("scoped-worker", pinned, cwd, SCOPED_TOOLS)).toContain("project");
	});

	it("refuses a definition with no tool list, extra tools, or spawns, and an agent with no definition", async () => {
		const cwd = makeRepo();
		const dir = userAgentsDir();
		const open = writeAgent(path.join(dir, "open.md"), "open", {});
		const wide = writeAgent(path.join(dir, "wide.md"), "wide", { tools: "read, write, bash" });
		const spawner = writeAgent(path.join(dir, "spawner.md"), "spawner", { tools: "read, write", spawns: "scoped-worker" });
		expect(await definitionProblem("open", open, cwd, SCOPED_TOOLS)).toContain("no tool list");
		expect(await definitionProblem("wide", wide, cwd, SCOPED_TOOLS)).toContain("bash");
		expect(await definitionProblem("spawner", spawner, cwd, SCOPED_TOOLS)).toContain("spawn");
		expect(await definitionProblem("ghost", path.join(dir, "ghost.md"), cwd, SCOPED_TOOLS)).toContain("no definition");
		expect(await definitionProblem("task", path.join(dir, "task.md"), cwd, SCOPED_TOOLS)).toContain("bundled");
	});
});

describe("isolationProblem", () => {
	it("refuses isolation only when the guard sits inside the project in a git-ignored place", () => {
		const outside = writeFile(path.join(tempDir("sg-guard-"), "guard.ts"), "");
		const cwd = makeRepo("sg-iso-", [".omp/"]);
		const ignored = writeFile(path.join(cwd, ".omp", "extensions", "guard.ts"), "");
		const untracked = writeFile(path.join(cwd, "tools", "guard.ts"), "");
		expect(isolationProblem([outside], cwd)).toBeUndefined();
		expect(isolationProblem([untracked], cwd)).toBeUndefined();
		expect(isolationProblem([outside, ignored], cwd)).toContain("ignored");
	});
});
