import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** The temporary root test/run.ts created; test/setup.ts already checked HOME and TMPDIR are inside it. */
export const TEST_ROOT = fs.realpathSync(process.env.SG_TEST_ROOT ?? "/nonexistent-test-root");

/** Deletes `target` only when its real path is strictly inside the suite's temporary root. */
export function safeRemove(target: string): void {
	let real: string;
	try {
		real = fs.realpathSync(target);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
		throw err;
	}
	const rel = path.relative(TEST_ROOT, real);
	if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) throw new Error(`refusing to delete ${target}: outside the test root`);
	fs.rmSync(real, { recursive: true, force: true });
}

const created: string[] = [];

/** A new directory under the suite's TMPDIR. */
export function tempDir(prefix: string): string {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
	created.push(dir);
	return dir;
}

export function removeTemps(): void {
	for (const dir of created.splice(0)) safeRemove(dir);
}

export function writeFile(file: string, text: string): string {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, text);
	return file;
}

function git(cwd: string, args: string[]): void {
	const ran = Bun.spawnSync(["git", "-C", cwd, "-c", "user.name=fixture", "-c", "user.email=fixture@localhost", "-c", "commit.gpgsign=false", ...args]);
	if (ran.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${ran.stderr.toString()}`);
}

/** A committed git repository with a README and one source file, the way a subagent finds a project. */
export function makeRepo(prefix = "sg-repo-", ignore: string[] = []): string {
	const cwd = path.join(tempDir(prefix), "repo");
	writeFile(path.join(cwd, "README.md"), "# fixture\n");
	writeFile(path.join(cwd, "src", "app.ts"), "export const retries = 3;\n");
	writeFile(path.join(cwd, ".gitignore"), ["node_modules/", ...ignore, ""].join("\n"));
	git(cwd, ["init", "-q"]);
	git(cwd, ["add", "-A"]);
	git(cwd, ["commit", "-qm", "fixture"]);
	return cwd;
}

/** An agent definition file with the given frontmatter fields. */
export function writeAgent(file: string, name: string, fields: Record<string, string> = { tools: "read, grep, glob, write, edit" }): string {
	const lines = ["---", `name: ${name}`, `description: ${name} test agent`, ...Object.entries(fields).map(([key, value]) => `${key}: ${value}`), "---", "Do the assignment and report.", ""];
	return writeFile(file, lines.join("\n"));
}

/** The user-level agent directory omp reads under the suite's HOME. */
export function userAgentsDir(): string {
	return path.join(os.homedir(), ".omp", "agent", "agents");
}
