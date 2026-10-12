import { afterAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { inScope, isProtected, type Places, writeTargets } from "../src/policy";
import { removeTemps, tempDir, writeFile } from "./fixtures";

afterAll(removeTemps);

function placesFor(cwd: string, extra: string[] = [], roots: string[] = []): Places {
	return { cwd, home: os.homedir(), roots: [path.join(os.homedir(), ".omp"), ...roots], extra };
}

describe("writeTargets", () => {
	it("names every file a write, edit, or ast_edit call would change, and nothing for read-only tools", () => {
		expect(writeTargets("write", { path: "notes.txt", content: "x" })).toEqual(["notes.txt"]);
		expect(writeTargets("edit", { path: "a.ts", edits: [{ rename: "b.ts" }] })).toEqual(["a.ts", "b.ts"]);
		const patch = "*** Begin Patch\n*** Update File: src/app.ts\n*** Move to: .env\n*** End Patch\n";
		expect(writeTargets("edit", { input: patch })).toEqual(["src/app.ts", ".env"]);
		expect(writeTargets("ast_edit", { paths: ["src/a.ts;src/b.ts"] })).toEqual(["src/a.ts", "src/b.ts"]);
		expect(writeTargets("read", { path: ".env" })).toBeUndefined();
	});
});

describe("isProtected", () => {
	const cwd = tempDir("sg-pol-");

	it("protects .env files, .envrc, .git, and .omp at any depth of the project, and extra patterns", () => {
		const p = placesFor(cwd, ["secrets/**"]);
		for (const target of [".env", "config/.env.production", ".envrc", ".git/config", ".omp/agents/scoped-worker.md", "pkg/.omp/hooks/pre/x.ts", "secrets/key.pem"]) {
			expect({ target, protected: isProtected(target, p) }).toEqual({ target, protected: true });
		}
		for (const target of ["notes.txt", "src/env.ts", ".environment", "docs/omp.md"]) {
			expect({ target, protected: isProtected(target, p) }).toEqual({ target, protected: false });
		}
	});

	it("protects the user's omp directory, given as ~ or absolute, and the extra roots", () => {
		const pkg = tempDir("sg-pkg-");
		const p = placesFor(cwd, [], [pkg]);
		expect(isProtected("~/.omp/agent/agents/scoped-worker.md", p)).toBe(true);
		expect(isProtected(path.join(os.homedir(), ".omp", "agent", "config.yml"), p)).toBe(true);
		expect(isProtected(path.join(pkg, "src", "index.ts"), p)).toBe(true);
		expect(isProtected(path.join(tempDir("sg-else-"), "notes.txt"), p)).toBe(false);
	});

	it("lets a subagent in an isolation copy under ~/.omp/wt write its own files, but not the rest of ~/.omp", () => {
		const copy = path.join(os.homedir(), ".omp", "wt", "t0123abcd", "m");
		fs.mkdirSync(copy, { recursive: true });
		const p = placesFor(copy);
		expect(isProtected("notes.txt", p)).toBe(false);
		expect(isProtected(".omp/agents/x.md", p)).toBe(true);
		expect(isProtected("~/.omp/agent/config.yml", p)).toBe(true);
	});

	it("follows symlinks out of the project into a protected place", () => {
		const target = path.join(os.homedir(), ".omp", "agent");
		fs.mkdirSync(target, { recursive: true });
		fs.symlinkSync(target, path.join(cwd, "link"));
		expect(isProtected("link/config.yml", placesFor(cwd))).toBe(true);
	});
});

describe("inScope", () => {
	it("accepts only project paths that match the agent's write scope", () => {
		const cwd = tempDir("sg-scope-");
		writeFile(path.join(cwd, "src", "a", "b.ts"), "");
		const scope = ["notes.txt", "src/**"];
		expect(inScope("notes.txt", cwd, scope)).toBe(true);
		expect(inScope("src/a/b.ts", cwd, scope)).toBe(true);
		expect(inScope(path.join(cwd, "src", "c.ts"), cwd, scope)).toBe(true);
		expect(inScope("README.md", cwd, scope)).toBe(false);
		expect(inScope("../outside/notes.txt", cwd, scope)).toBe(false);
		expect(inScope("local://plan.md", cwd, scope)).toBe(false);
		expect(inScope("notes.txt", cwd, [])).toBe(false);
	});
});
